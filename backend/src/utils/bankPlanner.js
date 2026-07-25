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

// Up to `maxN` sample positions across [lo, hi] (always incl. both ends).
function positions(lo, hi, maxN) {
  if (hi <= lo) return [lo];
  if (maxN <= 1) return [lo];
  const out = [];
  for (let i = 0; i < maxN; i++) out.push(Math.round(lo + (hi - lo) * i / (maxN - 1)));
  return [...new Set(out)];
}

// DP search for the best chains of round trips anchored at `anchorDep`.
//
// Crucially it does NOT force every flight to the earliest possible minute: it
// samples several DEPARTURE positions across each departure window and several
// ARRIVAL positions across each arrival window, so it can push flights later to
// consolidate idle time into one big gap (e.g. to fit maintenance without
// dropping a rotation). State = cursor (next-free-to-depart); per cursor it keeps
// a small Pareto front trading total layover against the largest single gap so
// far (`maxGap`), because a placement with a bit more layover but a bigger gap may
// fit maintenance and thus yield MORE effective flights. Returns complete weeks
// { legs, lay, maxGap, firstDep }.
function searchWeek(anchorDep, depWindows, arrWindows, oneWay, turnaround) {
  const Lmin = 2 * oneWay + turnaround;
  const limit = anchorDep + WEEK;
  // Short round trips pack many rotations into the week, so position sampling
  // there explodes the search for little gain (flights are forced tight anyway).
  // Sample more positions only when round trips are long (few per week).
  const POS_N = Lmin >= 8 * 60 ? 4 : (Lmin >= 4 * 60 ? 3 : 2);
  const PER_CURSOR = 3;    // Pareto states kept per cursor
  const GLOBAL_CAP = 600;

  let beam = [{ legs: [], cursor: anchorDep, lay: 0, maxGap: 0, firstDep: null }];
  const complete = [];

  for (let step = 0; step < 80; step++) {   // depth guard
    const buckets = new Map();               // cursor -> candidate states

    for (const st of beam) {
      let extended = false;
      for (const dw of depWindows) {
        if (dw.end < st.cursor) continue;
        if (dw.start > st.cursor + DAY) continue;
        const dLo = Math.max(st.cursor, dw.start);
        const dHi = Math.min(dw.end, limit - 1);
        if (dHi < dLo) continue;
        for (const D of positions(dLo, dHi, POS_N)) {
          for (const aw of arrWindows) {
            if (aw.end < D + Lmin) continue;
            if (aw.start > D + Lmin + DAY) continue;
            const aLo = Math.max(D + Lmin, aw.start);
            const aHi = Math.min(aw.end, limit - turnaround);
            if (aHi < aLo) continue;
            for (const A of positions(aLo, aHi, POS_N)) {
              extended = true;
              const cursor = A + turnaround;
              const prevArr = st.legs.length ? st.legs[st.legs.length - 1].arrWk : null;
              const hubGap = prevArr == null ? 0 : (D - prevArr);   // gap before this departure
              const destGap = A - D - 2 * oneWay;                    // destination layover
              const ns = {
                legs: st.legs.concat({ depWk: D, arrWk: A, depWin: { lo: dw.start, hi: dw.end }, arrWin: { lo: aw.start, hi: aw.end } }),
                cursor,
                lay: st.lay + (A - D - Lmin),
                maxGap: Math.max(st.maxGap, hubGap, destGap),
                firstDep: st.firstDep == null ? D : st.firstDep,
              };
              let arr = buckets.get(cursor);
              if (!arr) { arr = []; buckets.set(cursor, arr); }
              arr.push(ns);
            }
          }
        }
      }
      if (!extended && st.legs.length) complete.push(st);
    }

    if (buckets.size === 0) break;

    // Per cursor keep the Pareto front (least layover vs largest gap).
    const next = [];
    for (const arr of buckets.values()) {
      arr.sort((a, b) => a.lay - b.lay || b.maxGap - a.maxGap);
      let bestMax = -1, kept = 0;
      for (const s of arr) {
        if (s.maxGap > bestMax) { next.push(s); bestMax = s.maxGap; if (++kept >= PER_CURSOR) break; }
      }
    }
    beam = next;
    if (beam.length > GLOBAL_CAP) {
      beam.sort((a, b) => b.legs.length - a.legs.length || a.lay - b.lay);
      beam = beam.slice(0, GLOBAL_CAP);
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

// Explicitly build "same time every day" candidates: one rotation per day that
// departs at the SAME clock time T_d and arrives at the SAME clock time T_a every
// day (the return landing `delta` days later). These guarantee the perfectly
// regular option is evaluated even if the DP's pruning would drop it. Layover is
// minimised, which also maximises the daily hub gap so maintenance tends to fit.
function uniformDailyCandidates(banks, oneWay, turnaround) {
  const Lmin = 2 * oneWay + turnaround;
  const out = [];
  for (const bd of banks) {
    let dLo = bd.earliest_departure, dHi = bd.latest_departure; if (dHi < dLo) dHi += DAY;
    for (const ba of banks) {
      let aLo = ba.earliest_arrival, aHi = ba.latest_arrival; if (aHi < aLo) aHi += DAY;
      for (let delta = 0; delta <= 3; delta++) {
        let best = null;
        for (let Td = dLo; Td <= dHi; Td += 5) {
          // Ta in the arrival window, with elapsed = delta*DAY + Ta - Td >= Lmin
          // and one-per-day feasibility: Ta - Td <= (1-delta)*DAY - turnaround.
          const taLo = Math.max(aLo, Td + Lmin - delta * DAY);
          const taHi = Math.min(aHi, Td + (1 - delta) * DAY - turnaround);
          if (taLo > taHi) continue;
          const Ta = taLo;                       // earliest arrival → least layover
          const layover = delta * DAY + Ta - Td - Lmin;
          if (!best || layover < best.layover) best = { Td, Ta, layover };
        }
        if (!best) continue;
        const elapsed = delta * DAY + best.Ta - best.Td;
        if (elapsed < Lmin) continue;
        const legs = [];
        for (let k = 0; k < 7; k++) {
          const depWk = k * DAY + best.Td;
          legs.push({
            depWk, arrWk: depWk + elapsed,
            depWin: { lo: k * DAY + dLo, hi: k * DAY + dHi },
            arrWin: { lo: (k + delta) * DAY + aLo, hi: (k + delta) * DAY + aHi },
          });
        }
        out.push({ legs, lay: 7 * best.layover, firstDep: legs[0].depWk });
      }
    }
  }
  return out;
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
  //   2. REGULARITY — prefer the same clock times every day (fewest distinct
  //      departure/arrival minutes-of-day). "Same every day when possible."
  //   3. least total destination layover (cleaner, tighter rhythm);
  //   4. earliest first departure (deterministic, Monday-first).
  const need = maintDuration > 0 ? maintDuration + 2 * turnaround : 0;
  const regularity = (legs) => {
    const dep = new Set(), arr = new Set();
    for (const l of legs) { dep.add(((l.depWk % 1440) + 1440) % 1440); arr.add(((l.arrWk % 1440) + 1440) % 1440); }
    return dep.size + arr.size; // fewer distinct times-of-day = more regular
  };
  let best = null;
  const consider = (legs, lay, firstDep) => {
    if (!legs.length) return;
    const gaps = allGaps(legs, oneWay, turnaround);       // largest gap anywhere (incl. wrap + dest layovers)
    const finalMax = gaps.length ? Math.max(...gaps.map(g => g.size)) : 0;
    const fits = need === 0 ? true : finalMax >= need;
    const eff = legs.length - (fits ? 0 : 1);
    const reg = regularity(legs);
    if (best === null || eff > best.eff ||
        (eff === best.eff && (reg < best.reg ||
        (reg === best.reg && (lay < best.lay ||
        (lay === best.lay && firstDep < best.firstDep)))))) {
      best = { chain: legs, eff, reg, lay, firstDep };
    }
  };
  for (const b of banks) {
    for (const pl of searchWeek(b.earliest_departure, depWindows, arrWindows, oneWay, turnaround)) {
      consider(pl.legs, pl.lay, pl.firstDep);
    }
  }
  // Also weigh explicit "same time every day" candidates.
  for (const u of uniformDailyCandidates(banks, oneWay, turnaround)) consider(u.legs, u.lay, u.firstDep);

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
