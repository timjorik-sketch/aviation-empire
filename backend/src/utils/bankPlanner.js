// Hub-banking optimizer for a SINGLE aircraft on a SINGLE round-trip route.
//
// A "bank" is a hub wave: an arrival window and a departure window (minutes of
// day). The planner packs bank-compliant round trips into a repeating week for
// one aircraft, then places one weekly maintenance block into the largest idle
// gap ANYWHERE (hub ground time OR a long destination layover — the game resets
// condition regardless of where the aircraft sits). Waiting is allowed at both
// ends: hub ground before the next departure, and extended turnaround at the
// destination so the return lands inside an arrival window.
//
// The core is a DYNAMIC-PROGRAM search over the week. State = the earliest time
// the aircraft is next free to depart ("cursor"). From each state it branches
// over EVERY reachable (departure bank × arrival bank) within the next day —
// so at each step it genuinely tries "morning? midday? evening?" and keeps, per
// cursor, the best partial (most round trips, then least destination layover).
// Anchored at each bank's departure start, the search finds the global best.
//
// Objective (best full week wins): most effective flights (a maintenance-forced
// dropped round trip counts against it) → least total destination layover →
// earliest first departure (deterministic, Monday-first). Days differ only when
// that's genuinely better; they come out identical when one bank is always best.
//
// All times are absolute "week minutes": Mon 00:00 = 0 … Sun 23:59 = 10079.

const DAY = 1440;
const WEEK = 7 * DAY;

// Expand each bank's window into absolute week-minute occurrences. Banks recur
// every day, so we replicate each window across `weeks*7` days (enough that a
// search anchored on day 0 can reach forward across the Sun→Mon seam), sorted by
// start.
function expandWindows(banks, startKey, endKey, weeks) {
  const occ = [];
  const totalDays = weeks * 7;
  for (let d = 0; d < totalDays; d++) {
    for (const b of banks) {
      const s = b[startKey];
      let e = b[endKey];
      // Night window (end earlier than start) crosses midnight → its end is on
      // the following day, so unwrap by +1 day.
      if (e < s) e += DAY;
      occ.push({ start: d * DAY + s, end: d * DAY + e });
    }
  }
  occ.sort((a, z) => a.start - z.start);
  return occ;
}

// DP search for the best chain of round trips anchored at `anchorDep`.
// Returns an array of complete weeks, each { legs:[{depWk,arrWk,depWin,arrWin}], lay }.
// `lay` is total destination layover (idle beyond the minimum round trip).
function searchWeek(anchorDep, depWindows, arrWindows, oneWay, turnaround) {
  const Lmin = 2 * oneWay + turnaround;
  const limit = anchorDep + WEEK;   // one full cycle; next week's first dep is here
  const BEAM = 400;                 // safety cap on distinct states per step

  let beam = [{ legs: [], cursor: anchorDep, lay: 0 }];
  const complete = [];

  for (let step = 0; step < 80; step++) {   // depth guard
    const byCursor = new Map();              // dedup: future depends only on cursor

    for (const st of beam) {
      let extended = false;
      for (const dw of depWindows) {
        if (dw.end < st.cursor) continue;          // window already passed
        if (dw.start > st.cursor + DAY) continue;  // don't skip more than a day of departures
        const D = Math.max(st.cursor, dw.start);
        if (D >= limit) continue;
        for (const aw of arrWindows) {
          if (aw.end < D + Lmin) continue;
          if (aw.start > D + Lmin + DAY) continue; // don't idle more than a day at the destination
          const A = Math.max(D + Lmin, aw.start);
          if (A > aw.end) continue;
          if (A + turnaround > limit) continue;    // return must close before the week wraps
          extended = true;
          const cursor = A + turnaround;
          const cand = {
            legs: st.legs.concat({ depWk: D, arrWk: A, depWin: { lo: dw.start, hi: dw.end }, arrWin: { lo: aw.start, hi: aw.end } }),
            cursor,
            lay: st.lay + (A - D - Lmin),
          };
          const ex = byCursor.get(cursor);
          // Per cursor keep the strongest partial: more round trips, then less layover.
          if (!ex || cand.legs.length > ex.legs.length ||
              (cand.legs.length === ex.legs.length && cand.lay < ex.lay)) {
            byCursor.set(cursor, cand);
          }
        }
      }
      if (!extended && st.legs.length) complete.push(st);
    }

    if (byCursor.size === 0) break;
    beam = [...byCursor.values()];
    if (beam.length > BEAM) {
      beam.sort((a, b) => a.cursor - b.cursor || a.lay - b.lay);
      beam = beam.slice(0, BEAM);
    }
  }
  for (const st of beam) if (st.legs.length) complete.push(st);
  return complete;
}

// Every idle ground gap across the week, cyclically: the destination layover
// inside each round trip AND the hub gap between consecutive round trips. Each
// entry is { start, size } in week minutes. Maintenance can use ANY of them.
function allGaps(rts, oneWay, turnaround) {
  const gaps = [];
  const n = rts.length;
  for (let i = 0; i < n; i++) {
    const rt = rts[i];
    // Destination layover: between the outbound arrival and the return departure.
    gaps.push({ start: rt.depWk + oneWay, size: (rt.arrWk - oneWay) - (rt.depWk + oneWay) });
    // Hub gap: between this return's arrival and the next round trip's departure.
    const next = rts[(i + 1) % n];
    const nextDep = i + 1 < n ? next.depWk : next.depWk + WEEK;
    gaps.push({ start: rt.arrWk, size: nextDep - rt.arrWk });
  }
  return gaps;
}

// Does a maintenance block fit into some gap (anywhere) without dropping a trip?
function maintFits(rts, oneWay, turnaround, duration) {
  if (!duration) return true;
  if (!rts.length) return false;
  const need = duration + 2 * turnaround;
  return allGaps(rts, oneWay, turnaround).some(g => g.size >= need);
}

// Place one maintenance block into the largest gap anywhere. If nothing fits,
// drop round trips (whichever removal frees the most room) until it does.
function placeMaintenance(rts, oneWay, turnaround, duration) {
  const need = duration + 2 * turnaround;
  let working = rts.slice();

  while (working.length > 0) {
    const gaps = allGaps(working, oneWay, turnaround);
    let biggest = gaps[0];
    for (const g of gaps) if (g.size > biggest.size) biggest = g;

    if (biggest.size >= need) {
      const startWk = biggest.start + turnaround;
      return { legs: working, maintStartWk: ((startWk % WEEK) + WEEK) % WEEK };
    }

    // Remove the round trip whose removal yields the largest merged hub gap.
    let dropIdx = 0, bestMerged = -1;
    for (let i = 0; i < working.length; i++) {
      const prev = working[(i - 1 + working.length) % working.length];
      const next = working[(i + 1) % working.length];
      const prevArr = i === 0 ? prev.arrWk - WEEK : prev.arrWk;
      const nextDep = i + 1 < working.length ? next.depWk : next.depWk + WEEK;
      const merged = nextDep - prevArr;
      if (merged > bestMerged) { bestMerged = merged; dropIdx = i; }
    }
    working.splice(dropIdx, 1);
  }

  return { legs: [], maintStartWk: 0 };
}

/**
 * Plan a bank-aligned weekly rotation for one aircraft on one round-trip route.
 *
 * @param {object} p
 * @param {number} p.oneWayMinutes  one-way flight time incl. taxi (both legs equal)
 * @param {number} p.turnaround     minimum ground minutes (wake turnaround)
 * @param {Array}  p.banks          [{earliest_arrival, latest_arrival, earliest_departure, latest_departure}] (minutes of day)
 * @param {number} p.maintDuration  maintenance block minutes (0 to skip)
 * @returns {{roundTrips:Array, maintStartWk:number|null, maintDuration:number, feasible:boolean, note:string}}
 */
export function planBanks({ oneWayMinutes, turnaround, banks, maintDuration }) {
  if (!banks || banks.length === 0) {
    return { roundTrips: [], maintStartWk: null, maintDuration: 0, feasible: false, note: 'No banks selected' };
  }
  const oneWay = Math.round(oneWayMinutes);
  const Lmin = 2 * oneWay + turnaround;
  if (Lmin > WEEK) {
    return { roundTrips: [], maintStartWk: null, maintDuration: 0, feasible: false, note: 'Round trip is longer than a week' };
  }

  // Two weeks of window occurrences so a search anchored on day 0 can run forward
  // across the Sun→Mon seam without running out of candidates.
  const depWindows = expandWindows(banks, 'earliest_departure', 'latest_departure', 2);
  const arrWindows = expandWindows(banks, 'earliest_arrival', 'latest_arrival', 2);

  // Anchor at each bank's departure-window start (day 0) and DP-search each.
  // Score every complete week and keep the best:
  //   1. effective flights — round trips minus one if maintenance can't fit
  //      anywhere without dropping a rotation;
  //   2. least total destination layover (cleaner, tighter rhythm);
  //   3. earliest first departure (deterministic, Monday-first).
  let best = null;
  for (const b of banks) {
    const plans = searchWeek(b.earliest_departure, depWindows, arrWindows, oneWay, turnaround);
    for (const pl of plans) {
      if (!pl.legs.length) continue;
      const fits = maintFits(pl.legs, oneWay, turnaround, maintDuration);
      const eff = pl.legs.length - (fits ? 0 : 1);
      const firstDep = Math.min(...pl.legs.map(l => l.depWk));
      if (best === null || eff > best.eff ||
          (eff === best.eff && (pl.lay < best.lay ||
          (pl.lay === best.lay && firstDep < best.firstDep)))) {
        best = { chain: pl.legs, eff, lay: pl.lay, firstDep };
      }
    }
  }

  if (!best || best.chain.length === 0) {
    return { roundTrips: [], maintStartWk: null, maintDuration: 0, feasible: false, note: 'No bank-compliant round trip fits' };
  }
  const chain = best.chain;

  let roundTrips = chain;
  let maintStartWk = null;
  let droppedForMaint = 0;
  if (maintDuration > 0) {
    const placed = placeMaintenance(chain, oneWay, turnaround, maintDuration);
    if (placed.legs.length > 0) {
      droppedForMaint = chain.length - placed.legs.length;
      roundTrips = placed.legs;
      maintStartWk = placed.maintStartWk;
    } else {
      return {
        roundTrips: chain, maintStartWk: null, maintDuration,
        feasible: true, note: 'Could not fit a maintenance window; consider fewer/looser banks',
      };
    }
  }

  const note = droppedForMaint > 0
    ? `Dropped ${droppedForMaint} round trip(s) to fit the weekly maintenance window`
    : '';
  return { roundTrips, maintStartWk, maintDuration: maintDuration > 0 ? maintDuration : 0, feasible: true, note };
}

export { WEEK, DAY };
