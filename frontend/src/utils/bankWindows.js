// Shared helpers for hub banks. Bank windows are stored as minutes 0..1439 in
// the hub's LOCAL clock; schedule times are Berlin game-time "HH:MM". Local
// time uses the app-wide longitude approximation (Berlin ≈ UTC+1 under
// round(lon/15)), matching the Flightplan distribution view and the planner.

export function minutesToHHMM(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

export function parseHM(hm) {
  const [h, m] = (hm || '00:00').split(':').map(Number);
  return h * 60 + m;
}

// Berlin "HH:MM" on weekday `day` (0=Mon) → { day, min } in local time at `lon`.
export function berlinToLocal(berlinHHMM, day, lon) {
  let total = parseHM(berlinHHMM.slice(0, 5));
  if (lon != null && !isNaN(lon)) total += (Math.round(lon / 15) - 1) * 60;
  const dayShift = Math.floor(total / 1440);
  total = ((total % 1440) + 1440) % 1440;
  return { day: (((day + dayShift) % 7) + 7) % 7, min: total };
}

// Window [start, end]; end < start is a night window crossing midnight.
export function inWindow(min, start, end) {
  return start <= end ? (min >= start && min <= end) : (min >= start || min <= end);
}

export function windowLabel(start, end) {
  return `${minutesToHHMM(start)}–${minutesToHHMM(end)}${end < start ? ' (+1)' : ''}`;
}

// A weekly_schedule leg's local departure at its origin and local arrival at
// its destination (overnight legs land the next Berlin day).
export function legLocalTimes(e) {
  const dep = e.departure_time.slice(0, 5);
  const arr = e.arrival_time.slice(0, 5);
  const arrDay = arr <= dep ? (e.day_of_week + 1) % 7 : e.day_of_week;
  return {
    dep: berlinToLocal(dep, e.day_of_week, e.departure_longitude),
    arr: berlinToLocal(arr, arrDay, e.arrival_longitude),
  };
}
