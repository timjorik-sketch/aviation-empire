// Hub-banking optimizer for a SINGLE aircraft on a SINGLE round-trip route.
//
// A "bank" is a hub wave: an arrival window and a departure window (minutes of
// day). The planner packs as many bank-compliant round trips as possible into a
// repeating week for one aircraft, then places one weekly maintenance block into
// the largest idle hub gap. Waiting is allowed at BOTH ends (hub ground before
// the next departure, and extended turnaround at the destination so the return
// lands inside an arrival window).
//
// It searches: for each anchor it builds a week two ways — earliest-fit (max
// count) and minimum-layover (tries different banks per day, pushes idle time to
// the hub) — then keeps the week with the most effective flights (a maintenance-
// forced drop counts against it), then least destination layover. Days may differ
// when that's better; they come out identical when one bank is consistently best.
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

// Earliest instant >= minT that lies inside one of the windows. Returns
// { t, lo, hi } — the chosen instant plus the absolute bounds of the window it
// landed in (so callers know how far the endpoint may later be dragged) — or
// null if none within the expanded range.
function earliestInWindow(windows, minT) {
  let best = null;
  for (const win of windows) {
    if (win.end < minT) continue;          // window already fully passed
    const cand = Math.max(minT, win.start); // depart/arrive as early as allowed
    if (cand > win.end) continue;           // shouldn't happen given the guard
    if (best === null || cand < best.t) best = { t: cand, lo: win.start, hi: win.end };
  }
  return best;
}

// Build a round-trip chain anchored at a departure instant.
//
// `mode` decides how each rotation's DEPARTURE bank is chosen among the ones
// reachable at that point:
//   'earliest'   — take the earliest possible departure (packs tightest → max
//                  count; but can dump the slack into a long destination layover).
//   'minlayover' — among departures reachable within the next day, take the one
//                  whose return lands soonest after the minimum round trip, i.e.
//                  the smallest destination layover. This makes the planner try
//                  *different* banks on different days when that lines up better,
//                  and pushes idle time to the HUB (where maintenance can use it)
//                  instead of the destination.
function buildChain(anchorDep, depWindows, arrWindows, oneWay, turnaround, mode) {
  const Lmin = 2 * oneWay + turnaround; // shortest hub-dep → hub-arr round trip
  const limit = anchorDep + WEEK;       // one full cycle; next week's first dep sits at `limit`
  const legs = [];
  let cursor = anchorDep;

  for (let i = 0; i < 1000; i++) {       // hard cap as a runaway guard
    let pick = null;      // best candidate under the mode's rule (within horizon)
    let earliest = null;  // earliest feasible candidate overall (fallback / earliest mode)

    for (const dw of depWindows) {
      if (dw.end < cursor) continue;                 // window already passed
      const D = Math.max(cursor, dw.start);
      if (D >= limit) continue;                       // would spill into next week
      const A = earliestInWindow(arrWindows, D + Lmin);
      if (A === null || A.t + turnaround > limit) continue; // must close before wrap
      const cand = {
        depWk: D, arrWk: A.t,
        depWin: { lo: dw.start, hi: dw.end },
        arrWin: { lo: A.lo, hi: A.hi },
        layover: A.t - D - Lmin,                      // idle time beyond the minimum round trip
      };
      if (earliest === null || cand.depWk < earliest.depWk) earliest = cand;
      if (mode === 'minlayover') {
        // Only weigh departures reachable within ~a day so we never skip a whole
        // rotation just to shave layover.
        if (dw.start > cursor + DAY) continue;
        if (pick === null || cand.layover < pick.layover ||
            (cand.layover === pick.layover && cand.depWk < pick.depWk)) pick = cand;
      }
    }

    const chosen = mode === 'minlayover' ? (pick || earliest) : earliest;
    if (!chosen) break;
    legs.push({ depWk: chosen.depWk, arrWk: chosen.arrWk, depWin: chosen.depWin, arrWin: chosen.arrWin });
    cursor = chosen.arrWk + turnaround;
  }
  return legs;
}

// Total destination idle time across a chain (idle beyond the minimum round trip).
function totalLayover(legs, Lmin) {
  return legs.reduce((s, l) => s + (l.arrWk - l.depWk - Lmin), 0);
}

// Does a maintenance block fit into some hub gap without dropping a round trip?
function maintFits(legs, turnaround, duration) {
  if (!duration) return true;
  if (!legs.length) return false;
  const need = duration + 2 * turnaround;
  const gaps = computeGaps(legs, turnaround);
  return gaps.some(g => g.size >= need);
}

// Gaps (in week minutes) available for maintenance between consecutive round
// trips, cyclically. Each gap needs `duration + 2*turnaround` to host a block
// (turnaround padding on both sides, matching the schedule overlap rule).
function computeGaps(legs, turnaround) {
  const n = legs.length;
  const gaps = [];
  for (let i = 0; i < n; i++) {
    const cur = legs[i];
    const next = legs[(i + 1) % n];
    const nextDep = i + 1 < n ? next.depWk : next.depWk + WEEK; // wrap gap
    gaps.push({ afterLeg: i, start: cur.arrWk, size: nextDep - cur.arrWk });
  }
  return gaps;
}

// Place one maintenance block of `duration` into the largest gap. If nothing
// fits, drop round trips (whichever removal frees the most room) until it does.
function placeMaintenance(legs, turnaround, duration) {
  const need = duration + 2 * turnaround;
  let working = legs.slice();

  while (working.length > 0) {
    const gaps = computeGaps(working, turnaround);
    let biggest = gaps[0];
    for (const g of gaps) if (g.size > biggest.size) biggest = g;

    if (biggest.size >= need) {
      const startWk = biggest.start + turnaround;
      return { legs: working, maintStartWk: ((startWk % WEEK) + WEEK) % WEEK };
    }

    // No gap fits — remove the round trip whose removal yields the largest merged
    // gap, then retry. Removing leg i merges the gap before it, its own block, and
    // the gap after it into one.
    let dropIdx = 0, bestMerged = -1;
    for (let i = 0; i < working.length; i++) {
      const prev = working[(i - 1 + working.length) % working.length];
      const cur = working[i];
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
 * @returns {{roundTrips:Array<{depWk,arrWk}>, maintStartWk:number|null, maintDuration:number, feasible:boolean, note:string}}
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

  // Two weeks of window occurrences so a chain anchored on day 0 can search
  // forward across the Sun→Mon seam without running out of candidates.
  const depWindows = expandWindows(banks, 'earliest_departure', 'latest_departure', 2);
  const arrWindows = expandWindows(banks, 'earliest_arrival', 'latest_arrival', 2);

  // Search: anchor at each bank's departure-window start (day 0), and for each
  // anchor try both strategies. Score every resulting week and keep the best.
  // Score priority:
  //   1. effective flights — round trips minus one if maintenance can't fit
  //      without dropping a rotation (so "maintenance fits" beats "one more flight
  //      that then gets cut");
  //   2. least total destination layover (cleaner rhythm, slack at the hub);
  //   3. earliest first departure (deterministic, Monday-first).
  let best = null;
  for (const b of banks) {
    const anchor = b.earliest_departure; // day 0
    for (const mode of ['earliest', 'minlayover']) {
      const chain = buildChain(anchor, depWindows, arrWindows, oneWay, turnaround, mode);
      if (!chain.length) continue;
      const fits = maintFits(chain, turnaround, maintDuration);
      const eff = chain.length - (fits ? 0 : 1);
      const lay = totalLayover(chain, Lmin);
      const firstDep = Math.min(...chain.map(l => l.depWk));
      if (best === null || eff > best.eff ||
          (eff === best.eff && (lay < best.lay ||
          (lay === best.lay && firstDep < best.firstDep)))) {
        best = { chain, eff, lay, firstDep };
      }
    }
  }

  if (!best || best.chain.length === 0) {
    return { roundTrips: [], maintStartWk: null, maintDuration: 0, feasible: false, note: 'No bank-compliant round trip fits' };
  }
  best = best.chain;

  let roundTrips = best;
  let maintStartWk = null;
  let droppedForMaint = 0;
  if (maintDuration > 0) {
    const placed = placeMaintenance(best, turnaround, maintDuration);
    if (placed.legs.length > 0) {
      droppedForMaint = best.length - placed.legs.length;
      roundTrips = placed.legs;
      maintStartWk = placed.maintStartWk;
    } else {
      // Couldn't fit maintenance at all — return trips without it and flag.
      return {
        roundTrips: best, maintStartWk: null, maintDuration,
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
