// Group planner: spread ONE round-trip route across SEVERAL aircraft so that every
// selected bank gets a departure on every day of the week.
//
// Why this exists: bankPlanner.js packs the best possible week for a SINGLE
// aircraft. On long-haul that is never a daily service — DXB–JFK is ~806 min one
// way, so a round trip incl. turnaround runs ~27.9 h. Because that exceeds 24 h,
// one aircraft can only depart every OTHER day (Mon/Wed/Fri). Two aircraft cover
// six days and leave exactly one hole per bank; a further aircraft mops up the
// holes of several banks at once — which is the "B1.1 / B1.2 / … / AB" pattern
// players build by hand. This module derives that pattern automatically.
//
// Model
//   • Each bank gets ONE fixed departure clock time and ONE fixed elapsed round-trip
//     duration, used on all seven days — regularity is the whole point of a bank.
//     The player may pin the departure time ("Wunschzeit"); otherwise it is searched
//     inside the bank's departure window.
//   • That yields banks × 7 "rotations", each an interval on the circular weekly
//     timeline (Mon 00:00 = 0 … Sun 23:59 = 10079) that includes the hub turnaround.
//   • Assigning rotations to aircraft is cyclic interval scheduling. A greedy pass
//     over the week from many cut points, with two tie-break modes, gets the
//     minimum aircraft count on instances this small, and the "prefer an aircraft
//     already flying this bank" mode is what keeps a plane on one bank instead of
//     scattering it.
//   • The departure/arrival time choice per bank is then hill-climbed, because a
//     later return can be the difference between needing 7 aircraft and 6.
//
// All times are minutes; windows are minutes-of-day in GAME time (the caller
// converts from hub-local), spans are absolute week minutes.

const DAY = 1440;
const WEEK = 7 * DAY;

const mod = (v, m) => ((v % m) + m) % m;

// A "latest" earlier than its "earliest" is a window across midnight — unwrap it
// by pushing the end onto the next day (same convention as bankPlanner).
function unwrap(lo, hi) {
  return hi < lo ? [lo, hi + DAY] : [lo, hi];
}

// Up to `maxN` sample positions across [lo, hi], both ends always included.
function samples(lo, hi, maxN) {
  if (hi <= lo) return [lo];
  if (maxN <= 1) return [lo];
  const out = [];
  for (let i = 0; i < maxN; i++) out.push(Math.round(lo + (hi - lo) * i / (maxN - 1)));
  return [...new Set(out)];
}

// Candidate (departure time, elapsed duration) pairs for one bank. The return may
// land in ANY selected bank's arrival window — a wave that departs in the morning
// bank and returns into the evening bank is a perfectly good rotation — so the
// candidate records which bank it lands in for display.
function bankCandidates(bd, banks, oneWay, turnaround) {
  const Lmin = 2 * oneWay + turnaround;
  const [dLo, dHi] = unwrap(bd.earliest_departure, bd.latest_departure);
  // A pinned wish time wins outright: the player asked for that departure minute.
  const depTimes = bd.preferred_departure != null ? [bd.preferred_departure] : samples(dLo, dHi, 9);

  const out = [];
  const seen = new Set();
  for (const Td of depTimes) {
    for (const ba of banks) {
      const [aLo, aHi] = unwrap(ba.earliest_arrival, ba.latest_arrival);
      for (let delta = 0; delta <= 4; delta++) {
        const taLo = Math.max(aLo, Td + Lmin - delta * DAY);
        if (taLo > aHi) continue;
        // Several arrival positions: pushing the return later costs layover but
        // changes when the aircraft is free again, which can save a whole airframe.
        for (const Ta of samples(taLo, aHi, 3)) {
          const elapsed = delta * DAY + Ta - Td;
          if (elapsed < Lmin) continue;
          const dep = mod(Td, DAY);
          const key = `${dep}:${elapsed}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            dep, elapsed, layover: elapsed - Lmin,
            arr_bank_id: ba.id, arr_bank_name: ba.name,
          });
        }
      }
    }
  }
  out.sort((a, b) => a.layover - b.layover || a.dep - b.dep);
  return out.slice(0, 60);
}

// banks × 7 days → rotations on the circular week, sorted by departure.
function buildRotations(banks, choice, candLists, turnaround) {
  const rots = [];
  for (let bi = 0; bi < banks.length; bi++) {
    const c = candLists[bi][choice[bi]];
    for (let day = 0; day < 7; day++) {
      const dep = day * DAY + c.dep;
      rots.push({
        bank_id: banks[bi].id, bank_name: banks[bi].name, bank_index: bi,
        day, dep, arr: dep + c.elapsed, end: dep + c.elapsed + turnaround,
        elapsed: c.elapsed, arr_bank_name: c.arr_bank_name,
      });
    }
  }
  rots.sort((a, b) => a.dep - b.dep);
  return rots;
}

// Greedy cyclic assignment. `cutIdx` chooses where the week is opened: rotations
// before the cut are treated as belonging to the following week, so the problem
// becomes linear. A plane may take a rotation only if it is on the ground
// (lastEnd <= dep) AND the rotation still ends within one week of that plane's
// first departure — that last condition is what makes the pattern repeat weekly.
function assignGreedy(rots, cutIdx, sameBankFirst) {
  const n = rots.length;
  const planes = [];
  for (let k = 0; k < n; k++) {
    const i = (cutIdx + k) % n;
    const r = rots[i];
    const shift = i < cutIdx ? WEEK : 0;
    const dep = r.dep + shift;
    const end = r.end + shift;

    let best = null, bestScore = Infinity;
    for (const p of planes) {
      if (p.lastEnd > dep) continue;
      if (end > p.firstDep + WEEK) continue;
      const idle = dep - p.lastEnd;
      const score = sameBankFirst && !p.bankIds.has(r.bank_id) ? 1e7 + idle : idle;
      if (score < bestScore) { bestScore = score; best = p; }
    }
    if (!best) {
      best = { rots: [], bankIds: new Set(), firstDep: dep, lastEnd: -Infinity };
      planes.push(best);
    }
    best.rots.push({ ...r, dep, end, arr: r.arr + shift });
    best.bankIds.add(r.bank_id);
    best.lastEnd = end;
  }
  return planes;
}

function newPlane(dep) {
  return { rots: [], bankIds: new Set(), firstDep: dep, lastEnd: -Infinity };
}
function addRot(plane, r, dep) {
  const end = dep + r.elapsed + (r.end - r.arr);
  plane.rots.push({ ...r, dep, arr: dep + r.elapsed, end });
  plane.bankIds.add(r.bank_id);
  plane.lastEnd = end;
}

// The shape players build by hand: give each bank its own aircraft flying a fixed
// every-Nth-day pattern, and pool whatever days those cannot reach onto shared
// "standby" aircraft. On a 27.9 h round trip an aircraft departs every second day,
// so two per bank cover six days and leave exactly one — and if the banks' leftover
// days are staggered against each other, ONE shared aircraft mops up all of them.
// `stride` is that stagger: bank i starts its pattern `i * stride` days in.
function dedicatedThenPooled(rots, stride) {
  const byBank = new Map();
  for (const r of rots) {
    if (!byBank.has(r.bank_index)) byBank.set(r.bank_index, []);
    byBank.get(r.bank_index).push(r);
  }

  const planes = [];
  const residual = [];
  for (const [bankIndex, list] of [...byBank.entries()].sort((a, b) => a[0] - b[0])) {
    const byDay = new Map(list.map(r => [r.day, r]));
    const occ = list[0].end - list[0].dep;
    const period = Math.max(1, Math.ceil(occ / DAY));       // days between departures
    const perPlane = Math.floor(7 / period);                // days one aircraft can hold
    const maxDedicated = perPlane >= 1 ? Math.floor(7 / perPlane) : 0;
    const offset = (bankIndex * stride) % 7;

    const dedicated = [];
    for (let k = 0; k < 7; k++) {
      const day = (offset + k) % 7;
      const r = byDay.get(day);
      // Unroll the week from this bank's offset so the wrap-around check below is
      // a plain comparison instead of modular arithmetic.
      const dep = (offset + k) * DAY + mod(r.dep, DAY);
      const end = dep + occ;
      let target = dedicated.find(p => p.lastEnd <= dep && end <= p.firstDep + WEEK);
      if (!target && dedicated.length < maxDedicated) {
        target = newPlane(dep);
        dedicated.push(target);
      }
      if (target) addRot(target, r, dep);
      else residual.push(r);
    }
    planes.push(...dedicated);
  }

  if (residual.length === 0) return planes;

  // Pool the leftovers across banks — this is the standby aircraft.
  residual.sort((a, b) => a.dep - b.dep);
  let pool = null;
  for (let cut = 0; cut < residual.length; cut++) {
    const cand = assignGreedy(residual, cut, false);
    if (!pool || cand.length < pool.length) pool = cand;
  }
  return [...planes, ...pool];
}

function rate(planes) {
  let spread = 0, impure = 0;
  for (const p of planes) { spread += p.bankIds.size - 1; if (p.bankIds.size > 1) impure++; }
  return { planes, used: planes.length, spread, impure };
}

// Try every sensible opening of the week (one per bank on the first two days —
// later days are the same problem rotated) under both tie-break modes, plus the
// dedicated/standby constructions at every stagger.
function bestAssignment(rots, prefer) {
  const cuts = [];
  for (let i = 0; i < rots.length; i++) if (rots[i].dep < 2 * DAY) cuts.push(i);
  if (cuts.length === 0) cuts.push(0);

  let best = null;
  const consider = (planes) => {
    const cand = rate(planes);
    if (!best || prefer(cand, best)) best = cand;
  };
  for (const cut of cuts) {
    for (const sameBankFirst of [true, false]) consider(assignGreedy(rots, cut, sameBankFirst));
  }
  for (let stride = 0; stride < 7; stride++) consider(dedicatedThenPooled(rots, stride));
  return best;
}

// Every idle stretch of one plane's week: the hub gap after each round trip and
// the layover at the destination inside it. Maintenance resets condition wherever
// the aircraft sits, so both are usable (same rule as bankPlanner).
function planeGaps(rots, oneWay, turnaround) {
  const gaps = [];
  for (let i = 0; i < rots.length; i++) {
    const cur = rots[i];
    const next = rots[(i + 1) % rots.length];
    const nextDep = i + 1 < rots.length ? next.dep : next.dep + WEEK;
    gaps.push({ start: cur.end, size: nextDep - cur.end });
    const layStart = cur.dep + oneWay + turnaround;
    gaps.push({ start: layStart, size: (cur.arr - oneWay) - layStart });
  }
  return gaps;
}

// Largest gap wins, so the block sits where it disturbs least. Returns null when
// nothing fits — for a group we never drop a rotation to make room, because that
// would punch a hole in the daily service the whole plan exists to provide.
function placeMaintenance(rots, oneWay, turnaround, duration) {
  if (!duration || rots.length === 0) return null;
  const need = duration + turnaround;
  let best = null;
  for (const g of planeGaps(rots, oneWay, turnaround)) {
    if (g.size >= need && (!best || g.size > best.size)) best = g;
  }
  return best ? mod(best.start, WEEK) : null;
}

/**
 * Plan a daily bank-aligned service across a group of aircraft.
 *
 * @param {object} p
 * @param {number} p.oneWayMinutes  one-way block time (both legs equal)
 * @param {number} p.turnaround     minimum hub ground minutes (wake turnaround)
 * @param {Array}  p.banks          [{ id, name, earliest_arrival, latest_arrival,
 *                                     earliest_departure, latest_departure,
 *                                     preferred_departure|null }] in GAME minutes-of-day
 * @param {number} p.maintDuration  maintenance block minutes (0 to skip)
 * @param {string} [p.strategy]     'fewest' (default) — smallest fleet, aircraft may
 *                                  roll across banks; 'regular' — keep each aircraft
 *                                  on ONE bank even if that costs airframes.
 * @returns {{feasible:boolean, note:string, banks:Array, planes:Array}}
 */
export function planGroup({ oneWayMinutes, turnaround, banks, maintDuration, strategy = 'fewest' }) {
  if (!banks || banks.length === 0) {
    return { feasible: false, note: 'No banks selected', banks: [], planes: [] };
  }
  const oneWay = Math.round(oneWayMinutes);
  // A leg is stored as day + HH:MM with the arrival inferred, so a single leg that
  // runs 24 h or longer cannot be represented in the weekly schedule.
  if (oneWay >= DAY) {
    return { feasible: false, note: 'One-way flight time reaches 24 h — not schedulable', banks: [], planes: [] };
  }
  if (2 * oneWay + turnaround > WEEK) {
    return { feasible: false, note: 'Round trip is longer than a week', banks: [], planes: [] };
  }

  const candLists = banks.map(b => bankCandidates(b, banks, oneWay, turnaround));
  const emptyIdx = candLists.findIndex(l => l.length === 0);
  if (emptyIdx >= 0) {
    const b = banks[emptyIdx];
    return {
      feasible: false, banks: [], planes: [],
      note: `No return fits any arrival window for bank “${b.name}”`
        + (b.preferred_departure != null ? ' with the requested departure time' : ''),
    };
  }

  // 'regular' prices one bank-hopping aircraft the same as one extra airframe.
  // Ranking purity strictly above fleet size would give every bank its own spare
  // for the single day two aircraft cannot cover; this weighting instead pools
  // those leftover days onto as few shared aircraft as possible — the "two per
  // bank plus one all-banks standby" shape players build by hand.
  const keys = strategy === 'regular'
    ? (x) => [x.used + x.impure, x.impure, x.used, x.layover ?? 0]
    : (x) => [x.used, x.spread, x.layover ?? 0];
  const better = (a, b) => {
    const ka = keys(a), kb = keys(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i];
    return false;
  };

  const evaluate = (choice) => {
    const rots = buildRotations(banks, choice, candLists, turnaround);
    const a = bestAssignment(rots, better);
    let layover = 0;
    for (let bi = 0; bi < banks.length; bi++) layover += candLists[bi][choice[bi]].layover;
    return { ...a, layover, choice };
  };

  // Start from the tightest round trip per bank, then improve one bank at a time.
  let cur = evaluate(candLists.map(() => 0));
  for (let round = 0; round < 4; round++) {
    let improved = false;
    for (let bi = 0; bi < banks.length; bi++) {
      for (let ci = 0; ci < candLists[bi].length; ci++) {
        if (ci === cur.choice[bi]) continue;
        const trial = cur.choice.slice();
        trial[bi] = ci;
        const ev = evaluate(trial);
        if (better(ev, cur)) { cur = ev; improved = true; }
      }
    }
    if (!improved) break;
  }

  const bankInfo = banks.map((b, bi) => {
    const c = candLists[bi][cur.choice[bi]];
    const [dLo, dHi] = unwrap(b.earliest_departure, b.latest_departure);
    const depUnwrapped = c.dep < dLo ? c.dep + DAY : c.dep;
    return {
      id: b.id, name: b.name,
      departure_minutes: c.dep,
      arrival_minutes: mod(c.dep + c.elapsed, DAY),
      elapsed_minutes: c.elapsed,
      layover_minutes: c.layover,
      arr_bank_id: c.arr_bank_id, arr_bank_name: c.arr_bank_name,
      // A pinned wish time is honoured even outside the bank window; the caller
      // surfaces this so the player can widen the bank or move the time.
      outside_window: depUnwrapped < dLo || depUnwrapped > dHi,
    };
  });

  const planes = cur.planes.map(p => {
    const rots = p.rots.slice().sort((a, b) => a.dep - b.dep);
    const maintStartWk = placeMaintenance(rots, oneWay, turnaround, maintDuration);
    const busy = rots.reduce((s, r) => s + (r.arr - r.dep), 0);
    return {
      rotations: rots.map(r => ({
        bank_id: r.bank_id, bank_name: r.bank_name, arr_bank_name: r.arr_bank_name,
        dep_wk: mod(r.dep, WEEK), arr_wk: mod(r.dep, WEEK) + r.elapsed,
        elapsed: r.elapsed,
      })),
      bank_ids: [...p.bankIds],
      days: [...new Set(rots.map(r => Math.floor(mod(r.dep, WEEK) / DAY)))].sort((a, b) => a - b),
      round_trips: rots.length,
      flight_hours: +(rots.length * 2 * oneWay / 60).toFixed(1),
      utilisation_pct: Math.round(busy / WEEK * 100),
      maint_start_wk: maintStartWk,
      maint_duration: maintStartWk != null ? maintDuration : 0,
    };
  });
  // Most-loaded first, then by first departure — gives a stable, readable order.
  planes.sort((a, b) => b.round_trips - a.round_trips || a.rotations[0].dep_wk - b.rotations[0].dep_wk);

  const noMaint = planes.filter(p => maintDuration > 0 && p.maint_start_wk == null).length;
  const note = noMaint > 0
    ? `${noMaint} aircraft ${noMaint === 1 ? 'has' : 'have'} no gap large enough for the weekly maintenance block — add an aircraft or loosen a bank`
    : '';

  return { feasible: true, note, banks: bankInfo, planes };
}

export { WEEK, DAY };
