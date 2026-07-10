// Hub-banking optimizer for a SINGLE aircraft on a SINGLE round-trip route.
//
// A "bank" is a hub wave: an arrival window and a departure window (minutes of
// day). The planner packs as many bank-compliant round trips as possible into a
// repeating week for one aircraft, then places one weekly maintenance block into
// the largest idle hub gap. Waiting is allowed at BOTH ends (hub ground before
// the next departure, and extended turnaround at the destination so the return
// lands inside an arrival window).
//
// This is a greedy earliest-fit heuristic. For one aircraft on one route it is
// optimal or within ±1 round trip of optimal — the right cost for a game.
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

// Build the round-trip chain anchored at an exact departure instant.
// oneWay = one-way flight minutes (incl. taxi); turnaround = min ground minutes.
function buildChain(anchorDep, depWindows, arrWindows, oneWay, turnaround) {
  const Lmin = 2 * oneWay + turnaround; // shortest hub-dep → hub-arr round trip
  const limit = anchorDep + WEEK;       // one full cycle; next week's first dep sits at `limit`
  const legs = [];
  let cursor = anchorDep;
  // Hard cap iterations as a runaway guard.
  for (let i = 0; i < 1000; i++) {
    const D = earliestInWindow(depWindows, cursor);
    if (D === null || D.t >= limit) break;
    const A = earliestInWindow(arrWindows, D.t + Lmin);
    if (A === null) break;
    if (A.t + turnaround > limit) break;  // return + turnaround must close before the cycle wraps
    legs.push({
      depWk: D.t, arrWk: A.t,
      depWin: { lo: D.lo, hi: D.hi },     // absolute bounds the hub departure may move within
      arrWin: { lo: A.lo, hi: A.hi },     // absolute bounds the hub arrival may move within
    });
    cursor = A.t + turnaround;
  }
  return legs;
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

  // Try anchoring at each bank's departure-window start on day 0. Because windows
  // repeat daily, these phases cover the distinct chain shapes.
  let best = [];
  for (const b of banks) {
    const anchor = b.earliest_departure; // day 0
    const chain = buildChain(anchor, depWindows, arrWindows, oneWay, turnaround);
    if (chain.length > best.length) best = chain;
  }

  if (best.length === 0) {
    return { roundTrips: [], maintStartWk: null, maintDuration: 0, feasible: false, note: 'No bank-compliant round trip fits' };
  }

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
