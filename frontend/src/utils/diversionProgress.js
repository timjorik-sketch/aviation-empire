// Plane position along the dep→arr status line, accounting for a mid-route
// medical diversion: the aircraft flies to the diversion airport, sits on the
// ground for the diversion delay, then continues to the destination.
//
// Returns { pct, divPct, atStop, isDiverted }:
//   pct        0..100 — plane position along the line (left→right)
//   divPct     0..100 — where the diversion waypoint dot sits, or null
//   atStop     true while parked at the diversion airport
//   isDiverted whether this flight actually has a usable diversion
//
// The arrival_time already includes the diversion delay, so the cruise time is
// (total - stop), split between the two legs by the geographic fraction.
const clampPct = (v) => Math.max(0, Math.min(100, v));
const clampUnit = (v) => Math.max(0, Math.min(1, v));

export function diversionProgress(flight, now = Date.now()) {
  const dep = new Date(flight.departure_time).getTime();
  const arr = new Date(flight.arrival_time).getTime();
  const total = arr - dep;

  const frac = flight.diversion_fraction;
  const isDiverted =
    flight.delay_reason === 'medical' &&
    !!flight.diversion_airport_code &&
    frac != null && total > 0;

  if (!isDiverted) {
    const pct = total > 0 ? clampPct(((now - dep) / total) * 100) : 0;
    return { pct, divPct: null, atStop: false, isDiverted: false };
  }

  const stopMs = Math.max(0, (flight.diversion_stop_min || 0) * 60000);
  const cruiseMs = Math.max(1, total - stopMs);
  const leg1Ms = cruiseMs * frac;            // dep → diversion
  const leg2Ms = cruiseMs * (1 - frac);      // diversion → dest
  const reach = dep + leg1Ms;
  const leave = reach + stopMs;

  let pos, atStop = false;
  if (now < reach) {
    pos = frac * clampUnit((now - dep) / leg1Ms);
  } else if (now < leave) {
    pos = frac;
    atStop = true;
  } else {
    pos = frac + (1 - frac) * clampUnit((now - leave) / leg2Ms);
  }

  return { pct: clampPct(pos * 100), divPct: clampPct(frac * 100), atStop, isDiverted: true };
}
