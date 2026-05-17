// Deterministic, flavored descriptions for delay/disruption events.
// Used in user-facing detail views (OCC Events Breakdown, flight details
// modal) — the underlying event_type / delay_reason tags are unchanged.

const FLAVORS = {
  technical_ground: [
    'AC unit malfunction',
    'Water supply defect',
    'Galley malfunction',
    'Cabin door sensor fault',
    'Lavatory out of service',
    'Avionics warning',
    'Hydraulic system check',
    'Fuel system inspection',
    'Tire pressure check',
    'Cargo hold sensor fault',
    'IFE system reboot',
    'Cabin oxygen check',
  ],
  ground_ops: [
    'Pushback truck unavailable',
    'Cleaning crew late',
    'Late connecting passengers',
    'Baggage loading delay',
    'Apron bus delayed',
  ],
  atc: [
    'Departure slot missed',
    'ATC congestion',
    'Low visibility hold',
    'Runway change',
    'Flow control restriction',
    'Traffic separation hold',
    'Crosswind procedure',
    'Ground stop',
    'Airspace closure',
    'Wake separation hold',
  ],
  technical_air: [
    'Engine parameter abnormal',
    'Hydraulic fault in flight',
    'Cabin pressure warning',
    'Fuel flow anomaly',
    'Avionics fault',
    'AC system failure in flight',
    'Engine vibration warning',
    'Bird strike during climb',
    'Smoke indication in cabin',
    'Generator failure',
  ],
  medical: [
    'Medical emergency on board',
    'Passenger requires hospital',
    'Cardiac event passenger',
    'Severe allergic reaction',
    'Stroke symptoms passenger',
    'Crew member illness',
  ],
  wrong_location: [
    'Aircraft at unexpected airport',
    'Aircraft positioning issue',
    'Aircraft not at scheduled gate',
  ],
  medical_cascade: [
    'Aircraft late after medical diversion',
    'Knock-on from medical diversion',
  ],
};

// Cheap deterministic hash → integer
function hashSeed(input) {
  const s = String(input ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

// Returns a flavor string for the given event type, picked deterministically
// from the seed (e.g. event id or flight id). Returns null if no flavor list
// exists for the type.
export function getEventFlavor(eventType, seed) {
  const list = FLAVORS[eventType];
  if (!list || list.length === 0) return null;
  return list[hashSeed(seed) % list.length];
}
