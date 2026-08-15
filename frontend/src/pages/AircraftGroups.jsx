import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import TopBar from '../components/TopBar.jsx';
import Loader from '../components/Loader.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Weekly grid geometry. Half the density of the aircraft schedule grid (which
// runs 1 px per minute in a scroll box) so a whole week fits an accordion
// without its own scrollbar — a plan is read as a shape, not measured.
const HOUR_H     = 30;
const PX_PER_MIN = HOUR_H / 60;
const TOTAL_H    = 24 * HOUR_H;
const GUTTER_W   = 38;

const pad2 = (n) => String(n).padStart(2, '0');
const minToHHMM = (m) => `${pad2(Math.floor(((m % 1440) + 1440) % 1440 / 60))}:${pad2(((m % 1440) + 1440) % 1440 % 60)}`;
const hhmmToMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = parseInt(m[1]), mi = parseInt(m[2]);
  return h > 23 || mi > 59 ? null : h * 60 + mi;
};
const WEEK_MIN = 7 * 1440;
const mod1440 = (v) => ((v % 1440) + 1440) % 1440;

// Departures are planned on a five-minute grid, so that is the resolution of the
// slot slider and of dragging a wave around.
const SLOT_STEP = 5;

// A bank's departure window as a continuous range. A window ending before it
// starts runs across midnight, so the end is unwrapped onto the next day and the
// caller takes the result modulo a day when it needs a clock time.
function depWindow(bank) {
  const lo = bank.earliest_departure;
  const hi = bank.latest_departure;
  return [lo, hi < lo ? hi + 1440 : hi];
}

// Schedules are stored in Berlin game time. Times are shown at the airport they
// happen at, using the same whole-hour longitude approximation the schedule view
// and the bank planner use.
const lonOffset = (lon) => (lon != null ? (Math.round(lon / 15) - 1) * 60 : 0);
const toLocal = (gameMin, offset) => mod1440(gameMin + offset);

// Names in the shape players build by hand: DXB-JFK-B1.1 is the first aircraft on
// bank 1, DXB-JFK-AB the standby that covers every bank's leftover day. Derived
// straight from the plan response so it does not depend on component state.
// One POST, with the three ways it can fail kept apart: the request never left,
// the reply was not JSON, or the server answered with an error. Returns null once
// it has reported a failure itself; otherwise { ok, status, data }.
async function request(path, body, setError) {
  // Serialised before the request, and reported on its own: a body that will not
  // stringify is a bug here, not a network problem, and saying "could not reach
  // the server" would send the search somewhere it can never find anything.
  let payload;
  try {
    payload = JSON.stringify(body);
  } catch (err) {
    console.error(`[aircraft-groups] POST ${path} body could not be serialised`, err, body);
    setError(`Bug: the request could not be built (${err.message}).`);
    return null;
  }

  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' },
      body: payload,
    });
  } catch (err) {
    console.error(`[aircraft-groups] POST ${path} never completed`, err);
    setError(`Could not reach the server (${err.message}). Check your connection.`);
    return null;
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    console.error(`[aircraft-groups] POST ${path} → HTTP ${res.status}, body was not JSON`, err);
    setError(`The server answered HTTP ${res.status} with something that is not JSON — it may be restarting or behind a proxy error page.`);
    return null;
  }

  return { ok: res.ok, status: res.status, data };
}

// A leg keeps one identity for as long as the plan lives. Bars are drawn in time
// order, so an index would change the moment a wave moves past another one, and
// React would tear down the element being dragged along with its pointer capture.
const withUid = (assignment) => (l, i) => ({ ...l, uid: `${assignment.slot}-${i}` });

function buildNames(data, route) {
  const base = `${route.departure_airport}-${route.arrival_airport}`;
  const perBank = {};
  let standby = 0;
  const out = {};
  for (const a of data.assignments) {
    if (a.bank_ids.length !== 1) {
      standby += 1;
      out[a.slot] = standby === 1 ? `${base}-AB` : `${base}-AB${standby}`;
      continue;
    }
    const no = data.banks.findIndex(b => b.id === a.bank_ids[0]) + 1;
    perBank[no] = (perBank[no] || 0) + 1;
    out[a.slot] = `${base}-B${no}.${perBank[no]}`;
  }
  return out;
}

// A bank window whose end is earlier than its start runs across midnight.
const inWindow = (min, lo, hi) => (hi < lo ? (min >= lo || min <= hi) : (min >= lo && min <= hi));

// Same circular-week overlap rules the server enforces on commit, so a shift that
// would be rejected is visible here instead of failing at the last step.
const overlapsWeekly = (depA, arrA, depB, arrB, pad) => {
  const endA = arrA + pad, endB = arrB + pad;
  for (const s of [-WEEK_MIN, 0, WEEK_MIN]) if (depA + s < endB && depB < endA + s) return true;
  return false;
};
const overlapsMaint = (dep, arr, pad, mStart, mEnd) => {
  for (const s of [-WEEK_MIN, 0, WEEK_MIN]) if (dep - pad + s < mEnd && mStart < arr + pad + s) return true;
  return false;
};
const legSpan = (l) => {
  const dep = hhmmToMin(l.departure_time) ?? 0;
  const arr = hhmmToMin(l.arrival_time) ?? 0;
  const block = (((arr - dep) % 1440) + 1440) % 1440 || 1440;
  const depWk = l.day_of_week * 1440 + dep;
  return { depWk, arrWk: depWk + block };
};

// Put the weekly maintenance block back into a gap it fits, mirroring the server
// planner: leave it alone while it still fits, otherwise take the largest idle
// stretch anywhere in the week. Gaps between an outbound arrival and its return
// count too — the game resets condition wherever the aircraft happens to sit.
// Returns the block unchanged when nothing fits, so the conflict warning shows.
function refitMaintenance(legs, maintenance, pad) {
  if (!maintenance || legs.length === 0) return maintenance;
  const dur = maintenance.duration_minutes;
  const spans = legs.map(legSpan).sort((x, y) => x.depWk - y.depWk);

  const mStart = maintenance.day_of_week * 1440 + maintenance.start_minutes;
  if (!spans.some(s => overlapsMaint(s.depWk, s.arrWk, pad, mStart, mStart + dur))) {
    return maintenance;
  }

  let best = null;
  for (let i = 0; i < spans.length; i++) {
    const cur = spans[i];
    const next = spans[(i + 1) % spans.length];
    const nextDep = i + 1 < spans.length ? next.depWk : next.depWk + WEEK_MIN;
    const size = nextDep - cur.arrWk;
    if (!best || size > best.size) best = { start: cur.arrWk, size };
  }
  if (!best || best.size < dur + 2 * pad) return maintenance;

  const startWk = (((best.start + pad) % WEEK_MIN) + WEEK_MIN) % WEEK_MIN;
  const startMin = startWk % 1440;
  return {
    ...maintenance,
    day_of_week: Math.floor(startWk / 1440),
    start_minutes: startMin,
    start_time: minToHHMM(startMin),
  };
}

// ── Weekly schedule grid ─────────────────────────────────────────────────────
// The same Mon–Sun timeline the aircraft schedule page uses, read-only, drawn
// from a planned (not yet written) week — so bars carry the anthracite dashed
// "ghost" language the bank planner already established for unwritten flights.
// Shift an absolute week minute by a time-zone offset and split it back into the
// day column and minute-of-day the bar is drawn at. Crossing midnight in local
// time genuinely moves a flight into the neighbouring column — that is the point
// of the view, not an artefact.
function localSlot(dayOfWeek, minuteOfDay, offset) {
  const abs = (((dayOfWeek * 1440 + minuteOfDay + offset) % WEEK_MIN) + WEEK_MIN) % WEEK_MIN;
  return { day: Math.floor(abs / 1440), min: abs % 1440 };
}

function WeekGrid({ legs, maintenance, conflicts, offset = 0, onDragWave }) {
  // Dragging a bar moves the whole wave: every aircraft flying that bank in that
  // direction, by the same amount. Deltas are applied incrementally against what
  // has already been applied, so the draft stays the source of truth and no drag
  // baseline has to be remembered across re-renders.
  const drag = useRef(null);

  const onPointerDown = (e, leg) => {
    if (!onDragWave) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { leg, startY: e.clientY, applied: 0 };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const raw = (e.clientY - d.startY) / PX_PER_MIN;
    const snapped = Math.round(raw / SLOT_STEP) * SLOT_STEP;
    if (snapped === d.applied) return;
    onDragWave(d.leg.bank_id, d.leg.direction, snapped - d.applied, false);
    d.applied = snapped;
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    // Zero delta still refits maintenance, which is what settles the block after
    // the flights have finished moving.
    if (d) onDragWave(d.leg.bank_id, d.leg.direction, 0, true);
  };
  const flightBars = useMemo(() => legs.map((l, i) => {
    const depGame = hhmmToMin(l.departure_time) ?? 0;
    const arrGame = hhmmToMin(l.arrival_time) ?? 0;
    const dur = (((arrGame - depGame) % 1440) + 1440) % 1440 || 1440;
    const { day, min: dep } = localSlot(l.day_of_week, depGame, offset);
    const end = dep + dur;
    return {
      id: i, day, leg: l,
      depLabel: minToHHMM(dep),
      arrLabel: minToHHMM(dep + dur),
      top: dep * PX_PER_MIN,
      height: Math.max(Math.min(dur, 1440 - dep) * PX_PER_MIN, 12),
      overflowDay: end > 1440 ? (day + 1) % 7 : null,
      overflowHeight: end > 1440 ? Math.max((end - 1440) * PX_PER_MIN, 12) : 0,
    };
  }), [legs, offset]);

  const maintBar = useMemo(() => {
    if (!maintenance) return null;
    const { day, min: start } = localSlot(maintenance.day_of_week, maintenance.start_minutes, offset);
    const end = start + maintenance.duration_minutes;
    return {
      day, startLabel: minToHHMM(start),
      top: start * PX_PER_MIN,
      height: Math.max(Math.min(maintenance.duration_minutes, 1440 - start) * PX_PER_MIN, 12),
      overflowDay: end > 1440 ? (day + 1) % 7 : null,
      overflowHeight: end > 1440 ? Math.max((end - 1440) * PX_PER_MIN, 12) : 0,
    };
  }, [maintenance, offset]);

  return (
    <div className="ag-grid">
      <div className="ag-grid-header">
        <div className="ag-grid-gutter-hd" />
        {DAY_SHORT.map((d, i) => <div key={i} className="ag-grid-day-hd">{d}</div>)}
      </div>
      <div className="ag-grid-inner">
        <div className="ag-grid-gutter">
          {Array.from({ length: 9 }, (_, k) => k * 3).map(h => (
            <div key={h} className="ag-grid-hour-lbl" style={{ top: h * HOUR_H }}>{pad2(h)}:00</div>
          ))}
        </div>
        {DAY_SHORT.map((_, di) => (
          <div key={di} className="ag-grid-col">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className={h % 3 === 0 ? 'ag-hour-line ag-hour-line--major' : 'ag-hour-line'}
                style={{ top: h * HOUR_H }} />
            ))}

            {maintBar?.day === di && (
              <div className="ag-bar ag-bar--maint" style={{ top: maintBar.top, height: maintBar.height }}
                title={`Maintenance · ${maintenance.duration_minutes} min`}>
                <span className="ag-bar-fn">MAINT</span>
                <span className="ag-bar-tm">{maintBar.startLabel}</span>
              </div>
            )}
            {maintBar?.overflowDay === di && (
              <div className="ag-bar ag-bar--maint" style={{ top: 0, height: maintBar.overflowHeight }} />
            )}

            {flightBars.filter(b => b.day === di).map(b => (
              <div key={`f-${b.leg.uid ?? b.id}`}
                className={`ag-bar ag-bar--flight${onDragWave ? ' ag-bar--drag' : ''}${conflicts?.has(b.leg) ? ' ag-bar--conflict' : ''}`}
                style={{ top: b.top, height: b.height }}
                onPointerDown={e => onPointerDown(e, b.leg)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                title={`${b.leg.flight_number} ${b.leg.departure_airport}→${b.leg.arrival_airport} · ${b.depLabel}–${b.arrLabel} · ${b.leg.bank_name}`
                  + (onDragWave ? ' · drag to move the whole wave' : '')}>
                <span className="ag-bar-fn">{b.leg.flight_number}</span>
                <span className="ag-bar-rt">{b.leg.departure_airport}→{b.leg.arrival_airport}</span>
                <span className="ag-bar-tm">{b.depLabel}–{b.arrLabel}</span>
              </div>
            ))}
            {flightBars.filter(b => b.overflowDay === di).map(b => (
              <div key={`o-${b.leg.uid ?? b.id}`} className="ag-bar ag-bar--flight ag-bar--cont"
                style={{ top: 0, height: b.overflowHeight }}
                title={`${b.leg.flight_number} arrives ${b.arrLabel}`}>
                <span className="ag-bar-tm">↳ {b.arrLabel}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Aircraft Group Planning — plan ONE round-trip route across SEVERAL aircraft so
 * every selected bank is served daily. Long-haul round trips run past 24 h, so a
 * daily departure needs an interleaved fleet; this page works out the pattern,
 * shows each aircraft's resulting week, and writes them all at once. Nothing is
 * stored until "Write plan" — it is a planning assistant, not an entity.
 */
function AircraftGroups({ airline, onBack, backLabel = 'Fleet' }) {
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  const [routes, setRoutes]                   = useState([]);
  const [banks, setBanks]                     = useState([]);
  const [fleet, setFleet]                     = useState([]);
  const [airports, setAirports]               = useState([]);
  const [serviceProfiles, setServiceProfiles] = useState([]);
  const [cabinProfiles, setCabinProfiles]     = useState([]);

  // ── Inputs ────────────────────────────────────────────────────────────────
  const [fwdRouteId, setFwdRouteId]           = useState('');
  const [selectedBankIds, setSelectedBankIds] = useState([]);
  // Chosen departure minute per bank, hub-local, on the five-minute grid. Seeded
  // with the start of the window when a bank is picked and moved with the slider.
  const [bankSlot, setBankSlot] = useState({});
  const [selectedAcIds, setSelectedAcIds]     = useState([]);
  const [collapsedBases, setCollapsedBases]   = useState(() => new Set());
  const [strategy, setStrategy]               = useState('regular');
  const [ecoPrice, setEcoPrice]               = useState('');
  const [bizPrice, setBizPrice]               = useState('');
  const [firstPrice, setFirstPrice]           = useState('');
  const [serviceProfileId, setServiceProfileId] = useState('');

  // ── Plan / edit ───────────────────────────────────────────────────────────
  const [plan, setPlan]           = useState(null);
  const [draft, setDraft]         = useState([]);
  const [computing, setComputing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [editMode, setEditMode]   = useState(false);
  const [openSlots, setOpenSlots] = useState(() => new Set());
  // Aircraft names, slot → string. Seeded with the suggested pattern name and
  // always written, so the fleet list reads as the plan does; editable per row.
  const [names, setNames]         = useState({});
  // What is currently typed into a departure field, keyed `${bankId}:${direction}`.
  // Only the text — the planned time itself lives in the draft and is read back
  // from there, so a half-finished entry can never desync the two.
  const [bankTimeText, setBankTimeText] = useState({});

  const headers = useMemo(() => ({ Authorization: `Bearer ${localStorage.getItem('token')}` }), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [r, b, f, ap, sp, cp] = await Promise.all([
          fetch(`${API_URL}/api/routes`, { headers }).then(x => x.json()),
          fetch(`${API_URL}/api/banks`, { headers }).then(x => x.json()),
          fetch(`${API_URL}/api/aircraft/fleet`, { headers }).then(x => x.json()),
          fetch(`${API_URL}/api/airline/airports`).then(x => x.json()),
          fetch(`${API_URL}/api/service-profiles`, { headers }).then(x => x.json()),
          fetch(`${API_URL}/api/cabin-profiles`, { headers }).then(x => x.json()),
        ]);
        if (cancelled) return;
        setRoutes(r.routes || []);
        setBanks(b.banks || []);
        setFleet(f.fleet || []);
        setAirports(ap.airports || []);
        setServiceProfiles(sp.profiles || []);
        setCabinProfiles(cp.profiles || []);
      } catch {
        if (!cancelled) setError('Failed to load planning data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [headers]);

  const airportName = useCallback(
    (code) => (code ? airports.find(a => a.iata_code === code)?.name ?? null : null),
    [airports]
  );

  const fwdRoute = useMemo(
    () => routes.find(r => r.id === parseInt(fwdRouteId)) || null,
    [routes, fwdRouteId]
  );
  // A group always flies a round trip, so the reverse route has to exist already.
  const retRoute = useMemo(() => {
    if (!fwdRoute) return null;
    return routes.find(r => r.departure_airport === fwdRoute.arrival_airport
                         && r.arrival_airport === fwdRoute.departure_airport) || null;
  }, [routes, fwdRoute]);

  const hubCode = fwdRoute?.departure_airport || null;
  const hubBanks = useMemo(
    () => (hubCode ? banks.filter(b => b.hub_airport_code === hubCode) : []),
    [banks, hubCode]
  );

  const clearPlan = useCallback(() => {
    setPlan(null); setDraft([]); setEditMode(false); setOpenSlots(new Set());
    setBankTimeText({});
  }, []);

  useEffect(() => {
    clearPlan();
    setSelectedBankIds([]);
    if (fwdRoute) {
      setEcoPrice(fwdRoute.economy_price ? String(fwdRoute.economy_price) : '');
      setBizPrice(fwdRoute.business_price ? String(fwdRoute.business_price) : '');
      setFirstPrice(fwdRoute.first_price ? String(fwdRoute.first_price) : '');
    }
  }, [fwdRoute, clearPlan]);

  const { hasBusiness, hasFirst } = useMemo(() => {
    const profileIds = new Set(
      fleet.filter(a => selectedAcIds.includes(a.id)).map(a => a.airline_cabin_profile_id).filter(Boolean)
    );
    let biz = false, fir = false;
    for (const p of cabinProfiles) {
      if (!profileIds.has(p.id)) continue;
      for (const c of p.classes || []) {
        if (c.actual_capacity > 0 && c.class_type === 'business') biz = true;
        if (c.actual_capacity > 0 && c.class_type === 'first') fir = true;
      }
    }
    return { hasBusiness: biz, hasFirst: fir };
  }, [cabinProfiles, fleet, selectedAcIds]);

  // Only grounded aircraft are offered: an operating frame would have to be
  // pulled out of service for the write, and its running flights cancelled.
  const capableFleet = useMemo(() => {
    if (!fwdRoute) return [];
    const dist = fwdRoute.distance_km;
    const now = new Date();
    return fleet.filter(a =>
      !a.is_active &&
      !a.is_listed_for_sale &&
      !(a.delivery_at && new Date(a.delivery_at) > now) &&
      (!a.range_km || dist <= a.range_km)
    );
  }, [fleet, fwdRoute]);

  // Grouped by home base, exactly like the fleet's Airplane List.
  const groupedFleet = useMemo(() => {
    const map = new Map();
    for (const ac of [...capableFleet].sort((x, y) =>
      (x.registration || '').localeCompare(y.registration || ''))) {
      const code = ac.home_airport || null;
      const key = code ?? '__none__';
      if (!map.has(key)) map.set(key, { key, code, aircraft: [] });
      map.get(key).aircraft.push(ac);
    }
    return [...map.values()].sort((a, b) => {
      if (!a.code && !b.code) return 0;
      if (!a.code) return 1;
      if (!b.code) return -1;
      return a.code.localeCompare(b.code);
    });
  }, [capableFleet]);

  const toggleBank = (id) => {
    clearPlan();
    setSelectedBankIds(ids => {
      if (ids.includes(id)) return ids.filter(x => x !== id);
      const b = hubBanks.find(x => x.id === id);
      if (b) setBankSlot(s => (s[id] != null ? s : { ...s, [id]: depWindow(b)[0] }));
      return [...ids, id];
    });
  };
  const setSlot = (id, minutes) => {
    clearPlan();
    setBankSlot(s => ({ ...s, [id]: minutes }));
  };
  const toggleAircraft = (id) => {
    clearPlan();
    setSelectedAcIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  };
  const toggleBase = (key) => {
    setCollapsedBases(s => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const toggleBaseSelection = (group, on) => {
    clearPlan();
    const ids = group.aircraft.map(a => a.id);
    setSelectedAcIds(prev => on
      ? [...new Set([...prev, ...ids])]
      : prev.filter(id => !ids.includes(id)));
  };

  // ── Compute ───────────────────────────────────────────────────────────────
  const computePlan = async () => {
    setError(''); setSuccess('');
    if (!fwdRoute) { setError('Select an outbound route.'); return; }
    if (!retRoute) { setError('No return route exists for this pairing — create the reverse route first.'); return; }
    if (selectedBankIds.length === 0) { setError('Select at least one bank.'); return; }
    if (selectedAcIds.length === 0) { setError('Select at least one aircraft.'); return; }

    setComputing(true);
    // The slot chosen on each bank is the departure — the optimiser arranges the
    // aircraft and the returns around it rather than picking the minute itself,
    // which it only ever did by taking whichever window edge cost least layover.
    const pinned = {};
    for (const id of selectedBankIds) {
      const b = hubBanks.find(x => x.id === id);
      if (!b) continue;
      pinned[id] = minToHHMM(bankSlot[id] ?? depWindow(b)[0]);
    }
    const body = {
      forward_route_id: fwdRoute.id,
      return_route_id: retRoute.id,
      bank_ids: selectedBankIds,
      aircraft_ids: selectedAcIds,
      strategy,
      bank_departure_times: pinned,
    };

    // Each stage reports its own failure. Wrapping all three in one catch made a
    // bug in the rendering below read as "the server is unreachable", which sent
    // the search in exactly the wrong direction.
    const res = await request('/api/aircraft-groups/plan', body, setError);
    if (!res) { clearPlan(); setComputing(false); return; }
    if (!res.ok) { setError(res.data?.error || `Could not compute a plan (HTTP ${res.status})`); clearPlan(); setComputing(false); return; }

    try {
      const data = res.data;
      if (!Array.isArray(data.assignments)) {
        throw new Error('response had no assignments — the backend may be running an older build');
      }
      setPlan(data);
      setDraft(data.assignments.map(a => ({ ...a, legs: (a.legs || []).map(withUid(a)) })));
      setEditMode(false);
      setOpenSlots(new Set(data.assignments.length ? [data.assignments[0].slot] : []));
      setBankTimeText({});
      setNames(buildNames(data, fwdRoute));
    } catch (err) {
      console.error('[aircraft-groups] plan received but could not be displayed', err);
      setError(`The plan arrived but could not be displayed: ${err.message}`);
      clearPlan();
    } finally { setComputing(false); }
  };

  // ── Edit helpers ──────────────────────────────────────────────────────────
  const updateLeg = (slot, legIdx, patch) => {
    setDraft(d => d.map(a => a.slot !== slot ? a : {
      ...a,
      legs: a.legs.map((l, i) => {
        if (i !== legIdx) return l;
        const next = { ...l, ...patch };
        // Arrival is always derived from the departure, never typed — the server
        // recomputes it the same way from the route distance.
        const depMin = hhmmToMin(next.departure_time);
        const oldDep = hhmmToMin(l.departure_time);
        const oldArr = hhmmToMin(l.arrival_time);
        if (depMin != null && oldDep != null && oldArr != null) {
          const block = (((oldArr - oldDep) % 1440) + 1440) % 1440;
          next.arrival_time = minToHHMM(depMin + block);
        }
        return next;
      }),
    }));
  };
  const deleteLeg = (slot, legIdx) => {
    setDraft(d => d.map(a => a.slot !== slot ? a : { ...a, legs: a.legs.filter((_, i) => i !== legIdx) }));
  };
  const resetDraft = () => {
    if (!plan) return;
    setDraft(plan.assignments.map(a => ({ ...a, legs: a.legs.map(withUid(a)) })));
    setBankTimeText({});
    setEditMode(false);
  };

  // Move one wave across the whole group.
  //
  // Moving the OUTBOUND takes the return with it: the two are one rotation, and
  // sliding only the front half would silently eat into the turnaround at the far
  // end. Moving the INBOUND moves only the return, which is exactly how you trade
  // ground time at the destination against a later arrival back at the hub.
  //
  // Afterwards each aircraft's maintenance is refitted, because a wave that moved
  // onto the block would otherwise just sit there as an error.
  //
  // `currentLocal` is read back out of the draft, so the draft stays the single
  // source of truth and the field can never drift away from what is planned.
  // The one place a wave moves. Both the numeric fields and dragging a bar in a
  // week grid come through here, so they cannot drift apart. Time zones do not
  // enter into it: a delta is a delta wherever it is read.
  const shiftWave = useCallback((bankId, direction, delta, refit = true) => {
    // A zero delta still has work to do when refitting: that is how a drag settles
    // its maintenance block once the flights have stopped moving.
    if (!delta && !refit) return;
    const pad = plan?.summary?.turnaround ?? 60;
    const moves = (l) => l.bank_id === bankId && (direction === 'out' || l.direction === 'in');

    setDraft(d => d.map(a => {
      const legs = a.legs.map(l => {
        if (!moves(l)) return l;
        const dep = hhmmToMin(l.departure_time) ?? 0;
        const arr = hhmmToMin(l.arrival_time) ?? 0;
        const block = mod1440(arr - dep);
        const abs = ((((l.day_of_week * 1440 + dep + delta) % WEEK_MIN) + WEEK_MIN) % WEEK_MIN);
        const nm = abs % 1440;
        return {
          ...l,
          day_of_week: Math.floor(abs / 1440),
          departure_time: minToHHMM(nm),
          arrival_time: minToHHMM(nm + block),
        };
      });
      // While a drag is in flight the block would hop around under the cursor, so
      // it is refitted once at the end instead of on every pointer move.
      return { ...a, legs, maintenance: refit ? refitMaintenance(legs, a.maintenance, pad) : a.maintenance };
    }));
  }, [plan]);

  const shiftLeg = (bankId, direction, value, currentLocal) => {
    setBankTimeText(t => ({ ...t, [`${bankId}:${direction}`]: value }));
    const next = hhmmToMin(value);
    if (next == null || currentLocal == null) return;
    // Read a change as the shortest move, so nudging 23:50 → 00:10 is twenty
    // minutes later rather than most of a day earlier.
    let delta = next - currentLocal;
    if (delta > 720) delta -= 1440;
    if (delta <= -720) delta += 1440;
    shiftWave(bankId, direction, delta);
  };

  // Per bank, the first outbound and inbound leg found in the draft — they all
  // share a clock time within a bank, so one stands for the whole wave.
  const shiftRows = useMemo(() => {
    if (!plan) return [];
    return plan.banks.map(b => {
      let outLeg = null, inLeg = null;
      for (const a of draft) {
        for (const l of a.legs) {
          if (l.bank_id !== b.id) continue;
          if (l.direction === 'out' && !outLeg) outLeg = l;
          if (l.direction === 'in' && !inLeg) inLeg = l;
        }
      }
      const src = hubBanks.find(x => x.id === b.id) || null;
      // A rotation does not have to come home into the bank it left from — the
      // planner picks whichever arrival window costs least layover, and records it
      // as arr_bank_id. Judging the return against the DEPARTURE bank's arrival
      // window is what made a landing at 14:50 look wrong when it was sitting
      // squarely inside the afternoon window it was actually planned for.
      const arrSrc = hubBanks.find(x => x.id === b.arr_bank_id)
                  || hubBanks.find(x => x.id === b.id) || null;
      const hubOff  = lonOffset(outLeg?.dep_longitude ?? inLeg?.arr_longitude);
      const destOff = lonOffset(inLeg?.dep_longitude ?? outLeg?.arr_longitude);
      return {
        bank: b, src, arrSrc, outLeg, inLeg,
        // Outbound leaves the hub — check it against the bank's departure window.
        outLocal: outLeg ? toLocal(hhmmToMin(outLeg.departure_time), hubOff) : null,
        // Inbound leaves the destination, but what a bank governs is when the
        // aircraft lands back at the hub, so that is what gets checked.
        inLocal: inLeg ? toLocal(hhmmToMin(inLeg.departure_time), destOff) : null,
        inArrHubLocal: inLeg ? toLocal(hhmmToMin(inLeg.arrival_time), hubOff) : null,
      };
    });
  }, [plan, draft, hubBanks]);

  // Banks are referred to by position everywhere in the plan — B1, B2 — because
  // that is how the naming pattern reads and it stays short in a table row.
  const bankShort = useCallback(
    (bankId) => (plan ? `B${plan.banks.findIndex(b => b.id === bankId) + 1}` : ''),
    [plan]
  );

  // Both ends of the route as departure boards, in the style of the flight plan's
  // time distribution: a row per distinct local departure time, a column per day.
  // Read across a row and simultaneous departures line up in the same cell — the
  // thing a per-aircraft week cannot show, because it only ever shows one aircraft.
  const boards = useMemo(() => {
    const build = (direction) => {
      const byTime = new Map();
      for (const a of draft) {
        for (const l of a.legs) {
          if (l.direction !== direction) continue;
          const off = lonOffset(l.dep_longitude);
          const { day, min } = localSlot(l.day_of_week, hhmmToMin(l.departure_time) ?? 0, off);
          const time = minToHHMM(min);
          if (!byTime.has(time)) byTime.set(time, { time, days: {} });
          const row = byTime.get(time);
          (row.days[day] ||= []).push({
            key: `${a.slot}-${l.day_of_week}-${l.departure_time}`,
            reg: a.registration || '—',
            bank: bankShort(l.bank_id),
            fn: l.flight_number,
            to: l.arrival_airport,
          });
        }
      }
      return [...byTime.values()].sort((x, y) => x.time.localeCompare(y.time));
    };
    return { out: build('out'), in: build('in') };
  }, [draft, bankShort]);

  // Which legs now clash — with each other or with their aircraft's maintenance.
  // Shifting a bank can easily push a flight onto its neighbour, and finding that
  // out only when the write is rejected would be a poor trade.
  const conflicts = useMemo(() => {
    const bad = new Set();
    if (!plan) return bad;
    const pad = plan.summary.turnaround;
    for (const a of draft) {
      const spans = a.legs.map(l => ({ l, ...legSpan(l) }));
      for (let i = 0; i < spans.length; i++) {
        for (let j = i + 1; j < spans.length; j++) {
          if (overlapsWeekly(spans[i].depWk, spans[i].arrWk, spans[j].depWk, spans[j].arrWk, pad)) {
            bad.add(spans[i].l); bad.add(spans[j].l);
          }
        }
      }
      if (a.maintenance) {
        const mS = a.maintenance.day_of_week * 1440 + a.maintenance.start_minutes;
        const mE = mS + a.maintenance.duration_minutes;
        for (const s of spans) {
          if (overlapsMaint(s.depWk, s.arrWk, pad, mS, mE)) bad.add(s.l);
        }
      }
    }
    return bad;
  }, [draft, plan]);

  const toggleSlot = (slot) => {
    setOpenSlots(s => {
      const next = new Set(s);
      if (next.has(slot)) next.delete(slot); else next.add(slot);
      return next;
    });
  };

  // "B1 – Mon, Wed, Fri" for an aircraft that stays on one bank; a standby that
  // fills a different bank's gap each time gets each day labelled with its own
  // bank: "B1 – Sun, B2 – Thu, B3 – Tue".
  const bankDayLabel = useCallback((a) => {
    const entries = a.legs
      .filter(l => l.direction === 'out')
      .map(l => ({
        day: localSlot(l.day_of_week, hhmmToMin(l.departure_time) ?? 0, a.home_offset_minutes ?? 0).day,
        bank: bankShort(l.bank_id),
      }))
      .sort((x, y) => x.day - y.day);
    if (entries.length === 0) return '—';
    const distinct = new Set(entries.map(e => e.bank));
    return distinct.size === 1
      ? `${entries[0].bank} – ${entries.map(e => DAY_SHORT[e.day]).join(', ')}`
      : entries.map(e => `${e.bank} – ${DAY_SHORT[e.day]}`).join(', ');
  }, [bankShort]);

  // ── Commit ────────────────────────────────────────────────────────────────
  const commitPlan = async () => {
    setError(''); setSuccess('');
    if (!plan || draft.length === 0) return;
    if (plan.missing_aircraft > 0) {
      setError(`This plan needs ${plan.required_aircraft} aircraft — select ${plan.missing_aircraft} more.`);
      return;
    }
    if (!ecoPrice) { setError('Enter an economy price before writing the plan.'); return; }

    setCommitting(true);
    const res = await request('/api/aircraft-groups/commit', {
      forward_route_id: fwdRoute.id,
      return_route_id: retRoute.id,
      economy_price: ecoPrice,
      business_price: hasBusiness ? bizPrice : '',
      first_price: hasFirst ? firstPrice : '',
      service_profile_id: serviceProfileId ? parseInt(serviceProfileId) : undefined,
      assignments: draft.map(a => ({
        aircraft_id: a.aircraft_id,
        aircraft_name: names[a.slot] || undefined,
        legs: a.legs.map(l => ({
          route_id: l.route_id,
          day_of_week: l.day_of_week,
          departure_time: l.departure_time,
        })),
        maintenance: a.maintenance,
      })),
    }, setError);
    setCommitting(false);
    if (!res) return;
    if (!res.ok) { setError(res.data?.error || `Could not write the plan (HTTP ${res.status})`); return; }

    // left_grounded is not a failure: the aircraft was parked before the plan and
    // stays parked, schedule written, for the player to activate.
    const failed = (res.data.activation || []).filter(a => !a.activated && !a.left_grounded);
    setSuccess(res.data.message);
    if (failed.length) {
      setError(`Not activated: ${failed.map(f => `${f.registration} (${f.error})`).join(', ')}`);
    }
    clearPlan();
    try {
      const f = await fetch(`${API_URL}/api/aircraft/fleet`, { headers }).then(x => x.json());
      setFleet(f.fleet || []);
    } catch (err) {
      // The write already succeeded — a stale list is not worth an error banner.
      console.error('[aircraft-groups] fleet refresh after commit failed', err);
    }
  };

  if (loading) return <Loader />;

  const sortedLegs = (a) => a.legs
    .slice()
    .sort((x, y) => (x.day_of_week * 1440 + (hhmmToMin(x.departure_time) ?? 0))
                  - (y.day_of_week * 1440 + (hhmmToMin(y.departure_time) ?? 0)));

  const BoxBar = ({ n, title, right }) => (
    <div className="ag-boxbar">
      {n != null && <span className="ag-boxbar-num">{n}</span>}
      <span className="ag-boxbar-title">{title}</span>
      {right && <span className="ag-boxbar-right">{right}</span>}
    </div>
  );

  return (
    <div className="app">
      <div className="page-hero" style={{ backgroundImage: "url('/header-images/Headerimage_Fleet.png')" }}>
        <div className="page-hero-overlay">
          <h1>Aircraft Group Planning</h1>
          <p>{airline?.name} — daily service across a group of aircraft</p>
        </div>
      </div>

      <div className="container" style={{ paddingTop: 24 }}>
        <TopBar onBack={onBack} backLabel={backLabel} balance={airline?.balance} />

        {error && <div className="ag-alert ag-alert--error">{error}</div>}
        {success && <div className="ag-alert ag-alert--ok">{success}</div>}

        {/* ── Row 1: Route | Banks ────────────────────────────────────────── */}
        <div className="ag-row ag-row--half">
          <section className="ag-box">
            <BoxBar n="1" title="Route" />
            <div className="ag-boxbody">
              <div className="ag-field">
                <label>Outbound route (round trip)</label>
                <select value={fwdRouteId} onChange={e => setFwdRouteId(e.target.value)}>
                  <option value="">— select route —</option>
                  {routes.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.flight_number}: {r.departure_airport} → {r.arrival_airport} ({(r.distance_km ?? 0).toLocaleString()} km)
                    </option>
                  ))}
                </select>
              </div>
              {fwdRoute && (
                <div className={`ag-note${retRoute ? '' : ' ag-note--warn'}`}>
                  {retRoute
                    ? <>Return leg <strong>{retRoute.flight_number}</strong> {retRoute.departure_airport} → {retRoute.arrival_airport} · Hub <strong>{hubCode}</strong></>
                    : <>⚠ No return route exists for {fwdRoute.arrival_airport} → {fwdRoute.departure_airport}. Create it in Route Planning first.</>}
                </div>
              )}
            </div>
          </section>

          <section className="ag-box">
            <BoxBar n="2" title={`Banks at ${hubCode || 'the hub'}`}
              right={selectedBankIds.length > 0 ? `${selectedBankIds.length} selected` : null} />
            <div className="ag-boxbody">
              {!hubCode && <div className="ag-hint">Select an outbound route to see the banks at its hub.</div>}
              {hubCode && hubBanks.length === 0 && (
                <div className="ag-hint">No banks defined at {hubCode} yet. Create them on an aircraft's schedule page.</div>
              )}
              {hubBanks.length > 0 && (
                <div className="ag-base">
                  <div className="ag-base-body">
                    <table className="ag-ovtable">
                      <thead>
                        <tr>
                          <th style={{ width: '34px' }} />
                          <th>Bank</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hubBanks.map(b => {
                          const on = selectedBankIds.includes(b.id);
                          const [lo, hi] = depWindow(b);
                          const slot = bankSlot[b.id] ?? lo;
                          return (
                            <tr key={b.id}
                              className={`ag-ovrow${on ? ' ag-ovrow--on' : ''}`}
                              onClick={() => toggleBank(b.id)}>
                              <td style={{ textAlign: 'center' }}>
                                <input type="checkbox" checked={on} readOnly tabIndex={-1} />
                              </td>
                              <td>
                                <div className="ag-ovreg">{b.name}</div>
                                <div className="ag-bankwin">
                                  arr {minToHHMM(b.earliest_arrival)}–{minToHHMM(b.latest_arrival)}
                                  {' · '}dep {minToHHMM(b.earliest_departure)}–{minToHHMM(b.latest_departure)}
                                </div>
                                {/* Only reachable minutes are offered, so an out-of-window
                                    departure is not something you can pick by accident. */}
                                {on && (
                                  <div className="ag-slot" onClick={e => e.stopPropagation()}>
                                    <span className="ag-slot-edge">{minToHHMM(lo)}</span>
                                    <input
                                      type="range" className="ag-slot-range"
                                      min={lo} max={hi} step={SLOT_STEP} value={slot}
                                      onChange={e => setSlot(b.id, parseInt(e.target.value))}
                                    />
                                    <span className="ag-slot-edge">{minToHHMM(hi)}</span>
                                    <span className="ag-slot-value">{minToHHMM(slot)}</span>
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* ── Row 2: Aircraft (70%) | Pricing & strategy (30%) ────────────── */}
        <div className="ag-row ag-row--7030">
          <section className="ag-box">
            <BoxBar n="3" title="Aircraft"
              right={`${selectedAcIds.length} selected${plan ? ` · ${plan.required_aircraft} needed` : ''}`} />
            <div className="ag-boxbody">
              {!fwdRoute && <div className="ag-hint">Select a route first — the list only offers aircraft that can fly it.</div>}
              {fwdRoute && capableFleet.length === 0 && (
                <div className="ag-hint">
                  No grounded aircraft can fly {fwdRoute.distance_km?.toLocaleString()} km. Only grounded
                  aircraft can be planned — put a frame out of service in the fleet list to make it available.
                </div>
              )}
              {groupedFleet.length > 0 && (
                <div className="ag-bases">
                  {groupedFleet.map(g => {
                    const collapsed = collapsedBases.has(g.key);
                    const name = airportName(g.code);
                    const allOn = g.aircraft.every(a => selectedAcIds.includes(a.id));
                    return (
                      <div key={g.key} className="ag-base">
                        <div className="ag-base-hd" onClick={() => toggleBase(g.key)}>
                          <span className="ag-base-chevron">{collapsed ? '▶' : '▼'}</span>
                          {g.code
                            ? <>
                                <span className="ag-base-iata">{g.code}</span>
                                {name && <span className="ag-base-name">{name}</span>}
                              </>
                            : <span className="ag-base-none">No Home Base</span>}
                          <button
                            className="ag-base-all"
                            onClick={e => { e.stopPropagation(); toggleBaseSelection(g, !allOn); }}
                          >
                            {allOn ? 'Deselect all' : 'Select all'}
                          </button>
                          <span className="ag-base-badge">{g.aircraft.length}</span>
                        </div>
                        {!collapsed && (
                          <div className="ag-base-body">
                            <table className="ag-ovtable">
                              <thead>
                                <tr>
                                  <th style={{ width: '34px' }} />
                                  <th style={{ width: '36px', textAlign: 'center' }} />
                                  <th>Registration</th>
                                  <th>Name</th>
                                  <th>Type</th>
                                  <th>Cabin Profile</th>
                                  <th>Current Location</th>
                                </tr>
                              </thead>
                              <tbody>
                                {g.aircraft.map(ac => {
                                  const on = selectedAcIds.includes(ac.id);
                                  return (
                                    <tr key={ac.id}
                                      className={`ag-ovrow${on ? ' ag-ovrow--on' : ''}`}
                                      onClick={() => toggleAircraft(ac.id)}>
                                      <td style={{ textAlign: 'center' }}>
                                        <input type="checkbox" checked={on} readOnly tabIndex={-1} />
                                      </td>
                                      <td style={{ textAlign: 'center' }}>
                                        <span className="ag-status-dot" title="Grounded" />
                                      </td>
                                      <td><span className="ag-ovreg">{ac.registration}</span></td>
                                      <td className="ag-ovname">{ac.name || <span className="ag-ovempty">—</span>}</td>
                                      <td className="ag-ovtype">{ac.full_name}</td>
                                      <td className="ag-ovcabin">
                                        {ac.airline_cabin_profile_name || <span className="ag-ovempty">—</span>}
                                      </td>
                                      <td className="ag-ovloc">{ac.current_location || ac.home_airport || '—'}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="ag-box">
            <BoxBar n="4" title="Pricing & strategy" />
            <div className="ag-boxbody">
              <div className="ag-field">
                <label>Economy</label>
                <input type="number" min="1" placeholder="$" value={ecoPrice} onChange={e => setEcoPrice(e.target.value)} />
              </div>
              <div className={`ag-field${hasBusiness ? '' : ' ag-field--off'}`}>
                <label>Business</label>
                <input type="number" min="1" placeholder={hasBusiness ? '$' : 'N/A'} value={bizPrice}
                  disabled={!hasBusiness} onChange={e => setBizPrice(e.target.value)} />
              </div>
              <div className={`ag-field${hasFirst ? '' : ' ag-field--off'}`}>
                <label>First</label>
                <input type="number" min="1" placeholder={hasFirst ? '$' : 'N/A'} value={firstPrice}
                  disabled={!hasFirst} onChange={e => setFirstPrice(e.target.value)} />
              </div>
              <div className="ag-field">
                <label>Service Profile</label>
                <select value={serviceProfileId} onChange={e => setServiceProfileId(e.target.value)}>
                  <option value="">— None —</option>
                  {serviceProfiles.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div className="ag-field">
                <label>Optimisation</label>
                <select value={strategy} onChange={e => { clearPlan(); setStrategy(e.target.value); }}>
                  <option value="regular">Regular — one bank per aircraft + standby</option>
                  <option value="fewest">Fewest aircraft — roll across banks</option>
                </select>
              </div>
              {/* Called through a lambda: onClick={computePlan} would hand React's
                  click event straight to the pinnedDepartures parameter. */}
              <button className="ag-btn-primary ag-btn-block" onClick={() => computePlan()}
                disabled={computing || !fwdRoute || !retRoute || selectedBankIds.length === 0 || selectedAcIds.length === 0}>
                {computing ? 'Calculating…' : 'Calculate plan'}
              </button>
            </div>
          </section>
        </div>

        {/* ── Result ──────────────────────────────────────────────────────── */}
        {plan && (
          <section className="ag-box" style={{ marginBottom: '2rem' }}>
            <BoxBar title="Plan" right={
              <button className="ag-bar-btn" onClick={() => editMode ? resetDraft() : setEditMode(true)}>
                {editMode ? 'Discard edits' : 'Edit times'}
              </button>
            } />
            <div className="ag-boxbody">
              {plan.missing_aircraft > 0 && (
                <div className="ag-alert ag-alert--error">
                  {plan.missing_aircraft} more aircraft needed — the entries below without a registration
                  cannot be written. Select more aircraft, drop a bank, or switch to “Fewest aircraft”.
                </div>
              )}
              {plan.spare_aircraft.length > 0 && (
                <div className="ag-note" style={{ marginTop: '1rem' }}>
                  Not needed for this plan: {plan.spare_aircraft.map(a => a.registration).join(', ')}
                </div>
              )}
              {plan.note && <div className="ag-note ag-note--warn" style={{ marginTop: '1rem' }}>⚠ {plan.note}</div>}

              {/* Both ends as departure boards — simultaneous departures share a cell */}
              <div className="ag-boards">
                {[
                  { rows: boards.out, code: fwdRoute?.departure_airport, to: fwdRoute?.arrival_airport },
                  { rows: boards.in,  code: retRoute?.departure_airport, to: retRoute?.arrival_airport },
                ].map(board => (
                  <div key={board.code} className="ag-board">
                    <div className="ag-board-hd">
                      Departures {board.code} <span>→ {board.to}</span>
                      <em>{board.code} local</em>
                    </div>
                    <div className="ag-dist">
                      <div className="ag-dist-head">
                        <span>Time</span>
                        {DAY_SHORT.map(d => <span key={d}>{d}</span>)}
                      </div>
                      {board.rows.length === 0 && <div className="ag-dist-empty">No departures</div>}
                      {board.rows.map(row => (
                        <div key={row.time} className="ag-dist-row">
                          <span className="ag-dist-time">{row.time}</span>
                          {DAY_SHORT.map((_, di) => (
                            <div key={di} className="ag-dist-cell">
                              {(row.days[di] || []).map(f => (
                                <span key={f.key} className="ag-dist-pill"
                                  title={`${f.fn} → ${f.to} · ${f.reg} · ${f.bank} · ${row.time}`}>
                                  {f.reg}
                                </span>
                              ))}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Move a whole wave: a field per bank and direction, every aircraft follows */}
              <div className="ag-shift-grid">
                <div className="ag-shift-col">
                  <div className="ag-shift-hd">
                    Departure time Outbound
                    <span>{fwdRoute?.departure_airport}–{fwdRoute?.arrival_airport}</span>
                    <em>moves the whole rotation</em>
                  </div>
                  {shiftRows.map(({ bank, src, outLeg, outLocal }) => {
                    const key = `${bank.id}:out`;
                    const text = bankTimeText[key] ?? (outLocal != null ? minToHHMM(outLocal) : '');
                    const min = hhmmToMin(text);
                    const outside = min != null && src && !inWindow(min, src.earliest_departure, src.latest_departure);
                    return (
                      <div key={key} className={`ag-shift-row${min == null || outside ? ' ag-shift-row--warn' : ''}`}>
                        <span className="ag-shift-bank">{bank.name}</span>
                        <input
                          className={`ag-shift-inp${min == null ? ' ag-shift-inp--bad' : ''}`}
                          type="text" value={text} disabled={!outLeg}
                          onChange={e => shiftLeg(bank.id, 'out', e.target.value, outLocal)}
                        />
                        {min == null
                          ? <span className="ag-tag ag-tag--warn">HH:MM</span>
                          : outside && src
                            ? <span className="ag-tag ag-tag--warn">
                                outside {minToHHMM(src.earliest_departure)}–{minToHHMM(src.latest_departure)}
                              </span>
                            : <span className="ag-shift-info">{fwdRoute?.departure_airport} local</span>}
                      </div>
                    );
                  })}
                </div>

                <div className="ag-shift-col">
                  <div className="ag-shift-hd">
                    Departure time Inbound
                    <span>{retRoute?.departure_airport}–{retRoute?.arrival_airport}</span>
                    <em>return only</em>
                  </div>
                  {shiftRows.map(({ bank, arrSrc, inLeg, inLocal, inArrHubLocal }) => {
                    const key = `${bank.id}:in`;
                    const text = bankTimeText[key] ?? (inLocal != null ? minToHHMM(inLocal) : '');
                    const min = hhmmToMin(text);
                    // Judged against the window of the bank this rotation comes HOME
                    // into, which is not always the one it left from.
                    const outside = min != null && arrSrc && inArrHubLocal != null
                      && !inWindow(inArrHubLocal, arrSrc.earliest_arrival, arrSrc.latest_arrival);
                    const into = bankShort(bank.arr_bank_id);
                    return (
                      <div key={key} className={`ag-shift-row${min == null || outside ? ' ag-shift-row--warn' : ''}`}>
                        <span className="ag-shift-bank">{bank.name}</span>
                        <input
                          className={`ag-shift-inp${min == null ? ' ag-shift-inp--bad' : ''}`}
                          type="text" value={text} disabled={!inLeg}
                          onChange={e => shiftLeg(bank.id, 'in', e.target.value, inLocal)}
                        />
                        {min == null
                          ? <span className="ag-tag ag-tag--warn">HH:MM</span>
                          : outside && arrSrc
                            ? <span className="ag-tag ag-tag--warn">
                                lands {minToHHMM(inArrHubLocal)} — outside {into} {minToHHMM(arrSrc.earliest_arrival)}–{minToHHMM(arrSrc.latest_arrival)}
                              </span>
                            : <span className="ag-shift-info">
                                {retRoute?.departure_airport} local · lands {inArrHubLocal != null ? minToHHMM(inArrHubLocal) : '—'} into {into}
                              </span>}
                      </div>
                    );
                  })}
                </div>
              </div>

              {conflicts.size > 0 && (
                <div className="ag-note ag-note--warn" style={{ marginTop: '0.75rem' }}>
                  ⚠ {conflicts.size} flight{conflicts.size === 1 ? '' : 's'} now clash with another flight
                  or with maintenance (marked red in the weeks below). Move them apart — with the fields
                  above or by dragging a bar. The write stays blocked until then.
                </div>
              )}

              {/* One register per aircraft, same display as the picker above */}
              <div className="ag-bases" style={{ marginTop: '1.25rem' }}>
                {draft.map(a => {
                  const open = openSlots.has(a.slot);
                  const legs = sortedLegs(a);
                  return (
                    <div key={a.slot} className="ag-base">
                      <div className="ag-base-hd" onClick={() => toggleSlot(a.slot)}>
                        <span className="ag-base-chevron">{open ? '▼' : '▶'}</span>
                        <span className="ag-base-iata">
                          {a.registration || <em className="ag-missing">missing</em>}
                        </span>
                        {/* The suggested name is always applied on write; this is
                            where it gets overridden. */}
                        <input
                          className="ag-name-inp" type="text" maxLength={60}
                          value={names[a.slot] ?? ''} disabled={!a.aircraft_id}
                          onClick={e => e.stopPropagation()}
                          onChange={e => setNames(n => ({ ...n, [a.slot]: e.target.value }))}
                        />
                        <span className="ag-base-name">{bankDayLabel(a)}</span>
                        <span className="ag-acc-meta">
                          {legs.length} flights · {a.flight_hours}h · {a.utilisation_pct}% util
                        </span>
                      </div>
                      {open && (
                        <div className="ag-base-body ag-plan-body">
                          <div className="ag-tzhint">
                            All times in {a.home_airport || hubCode} local time
                          </div>
                          <WeekGrid legs={legs} maintenance={a.maintenance} conflicts={conflicts}
                            offset={a.home_offset_minutes ?? 0} onDragWave={shiftWave} />

                          {editMode && (
                            <table className="ag-legs">
                              <thead>
                                <tr>
                                  <th>Day</th><th>Flight</th><th>Leg</th>
                                  <th>Departure</th><th>Arrival</th><th>Bank</th><th></th>
                                </tr>
                              </thead>
                              <tbody>
                                {legs.map((l) => {
                                  const realIdx = a.legs.indexOf(l);
                                  return (
                                    <tr key={`${a.slot}-${realIdx}`}>
                                      <td>
                                        <select value={l.day_of_week}
                                          onChange={e => updateLeg(a.slot, realIdx, { day_of_week: parseInt(e.target.value) })}>
                                          {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                                        </select>
                                      </td>
                                      <td className="ag-mono">{l.flight_number}</td>
                                      <td>{l.departure_airport} → {l.arrival_airport}</td>
                                      <td>
                                        <input className="ag-time" type="text" value={l.departure_time}
                                          onChange={e => updateLeg(a.slot, realIdx, { departure_time: e.target.value })} />
                                      </td>
                                      <td className="ag-mono ag-muted">{l.arrival_time}</td>
                                      <td className="ag-muted">{l.bank_name}</td>
                                      <td>
                                        <button className="ag-btn-del" title="Remove this flight"
                                          onClick={() => deleteLeg(a.slot, realIdx)}>×</button>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="ag-commit">
                <div className="ag-commit-note">
                  Writing replaces the whole weekly schedule of every listed aircraft. They stay grounded —
                  put them into operation from the fleet list once the plan looks right.
                </div>
                <button className="ag-btn-primary" onClick={commitPlan}
                  disabled={committing || plan.missing_aircraft > 0 || conflicts.size > 0}>
                  {committing ? 'Writing…' : `Confirm & write ${draft.length} schedules`}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>

      <style>{`
        .ag-alert { padding: 0.85rem 1.1rem; border-radius: 8px; font-size: 0.92rem; margin-bottom: 1rem; }
        .ag-alert--error { background: #FEF2F2; border: 1px solid #FECACA; color: #B91C1C; }
        .ag-alert--ok { background: #F0FDF4; border: 1px solid #BBF7D0; color: #15803D; }

        /* Layout: route | banks, then aircraft (70) | pricing (30) */
        .ag-row { display: grid; gap: 1.25rem; margin-bottom: 1.25rem; align-items: start; }
        .ag-row--half { grid-template-columns: 1fr 1fr; }
        .ag-row--7030 { grid-template-columns: 7fr 3fr; }

        .ag-box {
          background: #fff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden;
        }
        /* Dark section bar, same language as the fleet page headers */
        .ag-boxbar {
          background: #2C2C2C; color: #fff; padding: 14px 20px;
          display: flex; align-items: center; gap: 10px;
        }
        .ag-boxbar-num {
          width: 20px; height: 20px; border-radius: 50%; flex-shrink: 0;
          background: rgba(255,255,255,0.18); display: inline-flex;
          align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 700;
        }
        .ag-boxbar-title {
          font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
        }
        .ag-boxbar-right {
          margin-left: auto; font-size: 0.72rem; font-weight: 600;
          color: rgba(255,255,255,0.75); letter-spacing: 0.04em;
        }
        .ag-bar-btn {
          margin-left: auto; background: transparent; border: 1px solid rgba(255,255,255,0.35);
          color: #fff; padding: 0.25rem 0.7rem; border-radius: 5px;
          font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em;
          text-transform: uppercase; cursor: pointer;
        }
        .ag-bar-btn:hover { background: rgba(255,255,255,0.15); }
        .ag-boxbody { padding: 1.25rem 1.5rem; }

        .ag-field { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 1rem; }
        .ag-field label { font-size: 0.82rem; font-weight: 600; color: #666666; }
        .ag-field select, .ag-field input {
          padding: 0.6rem 0.75rem; border: 1px solid #E0E0E0; border-radius: 6px;
          font-size: 0.95rem; color: #2C2C2C; background: #fff; width: 100%; box-sizing: border-box;
        }
        .ag-field select:focus, .ag-field input:focus { outline: none; border-color: #2C2C2C; }
        .ag-field--off label, .ag-field--off input { opacity: 0.45; }

        .ag-note {
          background: #F5F5F5; border: 1px solid #E0E0E0; border-radius: 6px;
          padding: 0.6rem 0.85rem; font-size: 0.88rem; color: #666666;
        }
        .ag-note--warn { background: #FFFBEB; border-color: #FDE68A; color: #92400E; }
        .ag-hint { font-size: 0.86rem; color: #888888; line-height: 1.5; }

        /* Banks and aircraft share the fleet Airplane List display */
        .ag-bases { display: flex; flex-direction: column; gap: 0.75rem; }
        .ag-base { border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
        .ag-base-hd {
          display: flex; align-items: center; gap: 10px;
          background: #EBEBEB; color: #2C2C2C; padding: 10px 16px;
          cursor: pointer; user-select: none; border: 1px solid #DCDCDC;
          transition: background 0.15s;
        }
        .ag-base-hd:hover { background: #E3E3E3; }
        .ag-base-chevron { font-size: 0.7rem; opacity: 0.5; flex-shrink: 0; }
        .ag-base-iata {
          font-family: monospace; font-weight: 800; font-size: 0.95rem;
          letter-spacing: 0.06em; flex-shrink: 0; color: #2C2C2C;
        }
        .ag-base-name { font-size: 0.85rem; color: #555; }
        .ag-base-none { font-size: 0.85rem; color: #999; font-style: italic; }
        .ag-base-all {
          margin-left: auto; background: transparent; border: 1px solid #C8C8C8;
          color: #555; padding: 0.15rem 0.6rem; border-radius: 4px;
          font-size: 0.7rem; font-weight: 600; cursor: pointer;
        }
        .ag-base-all:hover { background: #2C2C2C; border-color: #2C2C2C; color: #fff; }
        .ag-base-badge {
          background: #2C2C2C; color: white; font-size: 0.7rem; font-weight: 700;
          padding: 2px 8px; border-radius: 10px;
        }
        .ag-base-body { background: white; border: 1px solid #DCDCDC; border-top: none; overflow-x: auto; }

        .ag-ovtable { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
        .ag-ovtable th {
          text-align: left; padding: 0.6rem 0.75rem; border-bottom: 1px solid #E8E8E8;
          font-size: 0.7rem; font-weight: 700; color: #888;
          text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap;
        }
        .ag-ovtable td { padding: 0.55rem 0.75rem; border-bottom: 1px solid #F2F2F2; }
        .ag-ovrow { cursor: pointer; transition: background 0.12s; }
        .ag-ovrow:hover { background: #FAFAFA; }
        .ag-ovrow--on { background: #F5F5F5; }
        .ag-ovrow--on td { border-bottom-color: #E8E8E8; }
        .ag-ovrow input { accent-color: #2C2C2C; pointer-events: none; }
        .ag-status-dot {
          display: inline-block; width: 10px; height: 10px; border-radius: 50%;
          background: #9ca3af; box-shadow: 0 0 0 3px rgba(156,163,175,0.28);
          vertical-align: middle; position: relative; top: -1px;
        }
        .ag-ovreg { font-weight: 700; color: #2C2C2C; letter-spacing: 0.02em; }
        .ag-ovname, .ag-ovtype, .ag-ovcabin { color: #555; }
        .ag-ovempty { color: #BBB; }
        .ag-ovloc { color: #666; font-weight: 600; }
        .ag-bankwin { font-size: 0.78rem; color: #888; font-variant-numeric: tabular-nums; margin-top: 2px; }

        .ag-btn-primary {
          background: #2C2C2C; color: #fff; border: none; border-radius: 6px;
          padding: 0.7rem 1.4rem; font-size: 0.95rem; font-weight: 600; cursor: pointer;
        }
        .ag-btn-primary:hover:not(:disabled) { background: #1a1a1a; }
        .ag-btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
        .ag-btn-block { width: 100%; margin-top: 0.25rem; }

        /* Departure boards — one per end of the route */
        .ag-boards { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.25rem; }
        .ag-board { border: 1px solid #E0E0E0; border-radius: 8px; overflow: hidden; min-width: 0; }
        .ag-board-hd {
          display: flex; align-items: baseline; gap: 0.5rem;
          background: #FAFAFA; border-bottom: 1px solid #E0E0E0; padding: 0.6rem 0.85rem;
          font-size: 0.74rem; font-weight: 700; color: #2C2C2C;
          text-transform: uppercase; letter-spacing: 0.08em;
        }
        .ag-board-hd span { font-family: monospace; font-size: 0.8rem; color: #888; text-transform: none; letter-spacing: 0.04em; }
        .ag-board-hd em {
          margin-left: auto; font-style: normal; font-size: 0.68rem;
          font-weight: 500; color: #AAA; letter-spacing: 0; text-transform: none;
        }
        .ag-dist-head, .ag-dist-row {
          display: grid; grid-template-columns: 46px repeat(7, 1fr); align-items: stretch;
        }
        .ag-dist-head {
          background: #F5F5F5; border-bottom: 1px solid #E8E8E8;
          font-size: 0.62rem; font-weight: 700; color: #999;
          text-transform: uppercase; letter-spacing: 0.05em;
        }
        .ag-dist-head span { padding: 5px 3px; text-align: center; }
        .ag-dist-head span:first-child { text-align: left; padding-left: 8px; }
        .ag-dist-row { border-bottom: 1px solid #F2F2F2; }
        .ag-dist-row:last-child { border-bottom: none; }
        .ag-dist-time {
          display: flex; align-items: center; padding-left: 8px;
          font-size: 0.7rem; font-weight: 700; color: #2C2C2C;
          font-variant-numeric: tabular-nums; background: #FAFAFA;
        }
        .ag-dist-cell {
          display: flex; flex-wrap: wrap; gap: 2px; justify-content: center;
          padding: 4px 3px; min-height: 26px; border-left: 1px solid #F5F5F5;
        }
        .ag-dist-pill {
          font-size: 0.62rem; font-weight: 700; letter-spacing: 0.02em;
          background: #2C2C2C; color: #fff; border-radius: 3px; padding: 1px 4px;
          white-space: nowrap; cursor: default;
        }
        .ag-dist-empty { padding: 0.9rem; text-align: center; font-size: 0.8rem; color: #AAA; }

        /* Departure-time shifter — outbound and inbound side by side */
        .ag-shift-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
        .ag-shift-col {
          padding: 0.9rem 1rem; background: #FAFAFA;
          border: 1px solid #E8E8E8; border-radius: 8px; min-width: 0;
        }
        .ag-shift-hd {
          display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 0.7rem;
          font-size: 0.74rem; font-weight: 700; color: #2C2C2C;
          text-transform: uppercase; letter-spacing: 0.08em;
        }
        .ag-shift-hd span {
          font-family: monospace; font-size: 0.8rem; font-weight: 700;
          color: #888; letter-spacing: 0.04em; text-transform: none;
        }
        .ag-shift-hd em {
          margin-left: auto; font-style: normal; font-size: 0.72rem;
          font-weight: 500; color: #AAA; letter-spacing: 0; text-transform: none;
        }
        .ag-shift-row {
          display: flex; align-items: center; gap: 0.6rem;
          padding: 0.45rem 0.65rem; background: #fff;
          border: 1px solid #EDEDED; border-radius: 6px; margin-bottom: 0.35rem;
          font-size: 0.84rem; color: #666; min-width: 0;
        }
        .ag-shift-row--warn { border-color: #FDE68A; background: #FFFDF7; }
        .ag-shift-bank {
          font-weight: 600; color: #2C2C2C; flex: 1 1 auto; min-width: 0;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .ag-shift-inp {
          width: 72px; flex-shrink: 0; padding: 0.3rem 0.4rem;
          border: 1px solid #E0E0E0; border-radius: 6px;
          font-size: 0.88rem; font-weight: 600; color: #2C2C2C;
          font-variant-numeric: tabular-nums; text-align: center;
        }
        .ag-shift-inp:focus { outline: none; border-color: #2C2C2C; }
        .ag-shift-inp--bad { border-color: #FCA5A5; background: #FEF2F2; }
        .ag-shift-inp:disabled { background: #F5F5F5; opacity: 0.5; }
        .ag-shift-info {
          font-size: 0.75rem; color: #999; font-variant-numeric: tabular-nums;
          flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .ag-tag {
          font-size: 0.68rem; font-weight: 700; border-radius: 4px;
          padding: 0.15rem 0.4rem; flex-shrink: 0; white-space: nowrap;
        }
        .ag-tzhint {
          font-size: 0.75rem; color: #999; margin-bottom: 0.5rem;
          text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;
        }
        .ag-tag--warn { background: #FFFBEB; color: #B45309; border: 1px solid #FDE68A; }

        /* Plan registers — one per aircraft, same shell as the picker's bases */
        .ag-missing { color: #B91C1C; font-style: italic; font-weight: 600; }
        .ag-name-inp {
          flex: 0 1 190px; min-width: 120px; padding: 0.25rem 0.5rem;
          border: 1px solid #D4D4D4; border-radius: 4px; background: #fff;
          font-size: 0.83rem; font-weight: 600; color: #2C2C2C;
        }
        .ag-name-inp:focus { outline: none; border-color: #2C2C2C; }
        .ag-name-inp:disabled { background: #F0F0F0; opacity: 0.5; }
        .ag-acc-meta { margin-left: auto; color: #666; font-size: 0.8rem; white-space: nowrap; }
        .ag-plan-body { padding: 1rem; }

        /* Weekly schedule grid */
        .ag-grid { border: 1px solid #E0E0E0; border-radius: 6px; overflow: hidden; background: #fff; }
        .ag-grid-header { display: flex; border-bottom: 2px solid #E0E0E0; background: #FAFAFA; }
        .ag-grid-gutter-hd { width: ${GUTTER_W}px; min-width: ${GUTTER_W}px; border-right: 1px solid #E0E0E0; flex-shrink: 0; }
        .ag-grid-day-hd {
          flex: 1; text-align: center; padding: 0.4rem 0.2rem;
          font-size: 0.7rem; font-weight: 700; color: #555;
          text-transform: uppercase; letter-spacing: 0.06em; border-right: 1px solid #EEEEEE;
        }
        .ag-grid-day-hd:last-child { border-right: none; }
        .ag-grid-inner { display: flex; height: ${TOTAL_H}px; }
        .ag-grid-gutter {
          width: ${GUTTER_W}px; min-width: ${GUTTER_W}px; position: relative;
          flex-shrink: 0; border-right: 1px solid #E0E0E0; background: #FAFAFA;
        }
        .ag-grid-hour-lbl {
          position: absolute; right: 5px; font-size: 9px; color: #AAAAAA;
          transform: translateY(-50%); white-space: nowrap; pointer-events: none;
        }
        .ag-grid-col { flex: 1; position: relative; border-right: 1px solid #EEEEEE; }
        .ag-grid-col:last-child { border-right: none; }
        .ag-hour-line { position: absolute; left: 0; right: 0; height: 1px; background: #F2F2F2; pointer-events: none; }
        .ag-hour-line--major { background: #E4E4E4; }

        .ag-bar {
          position: absolute; left: 2px; right: 2px; border-radius: 3px;
          padding: 1px 3px; overflow: hidden; box-sizing: border-box;
          display: flex; flex-direction: column; gap: 0px; z-index: 3;
        }
        /* Planned but not yet written — same anthracite dashed language the bank
           planner uses for its preview bars. */
        .ag-bar--flight { background: #2C2C2C; border: 1.5px dashed #2C2C2C; opacity: 0.88; }
        .ag-bar--cont { opacity: 0.6; border-top: none; border-radius: 0 0 3px 3px; }
        .ag-bar--maint { background: #6b7280; border: 1.5px dashed #4b5563; z-index: 2; }
        .ag-bar--conflict { outline: 2px solid #EF4444; outline-offset: -2px; z-index: 4; }
        /* touch-action keeps a drag on a phone from scrolling the page instead */
        .ag-bar--drag { cursor: ns-resize; touch-action: none; }
        .ag-bar--drag:hover { opacity: 1; }

        /* Slot picker inside a selected bank row */
        .ag-slot {
          display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem;
          padding-top: 0.5rem; border-top: 1px dashed #ECECEC;
        }
        .ag-slot-edge { font-size: 0.68rem; color: #AAA; font-variant-numeric: tabular-nums; }
        .ag-slot-range { flex: 1 1 auto; min-width: 0; accent-color: #2C2C2C; cursor: pointer; }
        .ag-slot-value {
          font-size: 0.8rem; font-weight: 700; color: #2C2C2C;
          font-variant-numeric: tabular-nums; background: #F0F0F0;
          border-radius: 4px; padding: 1px 6px; min-width: 46px; text-align: center;
        }
        .ag-bar-fn { font-size: 9px; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.25; }
        .ag-bar-rt { font-size: 8px; color: rgba(255,255,255,0.85); white-space: nowrap; overflow: hidden; line-height: 1.25; }
        .ag-bar-tm { font-size: 8px; color: rgba(255,255,255,0.72); white-space: nowrap; overflow: hidden; font-family: monospace; line-height: 1.25; }

        .ag-legs { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.85rem; background: #fff; }
        .ag-legs th {
          text-align: left; padding: 0.45rem 0.55rem; border-bottom: 1px solid #E0E0E0;
          font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; color: #888; font-weight: 700;
        }
        .ag-legs td { padding: 0.4rem 0.55rem; border-bottom: 1px solid #F2F2F2; color: #2C2C2C; }
        .ag-legs select, .ag-time {
          padding: 0.25rem 0.35rem; border: 1px solid #E0E0E0; border-radius: 4px;
          font-size: 0.82rem; background: #fff; color: #2C2C2C;
        }
        .ag-time { width: 64px; font-variant-numeric: tabular-nums; }
        .ag-mono { font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
        .ag-muted { color: #888; }
        .ag-btn-del {
          background: none; border: none; color: #B91C1C; font-size: 1.05rem;
          cursor: pointer; line-height: 1; padding: 0 0.3rem;
        }

        .ag-commit {
          display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap;
          margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid #F0F0F0;
        }
        .ag-commit-note { flex: 1 1 320px; font-size: 0.85rem; color: #888; line-height: 1.5; }

        @media (max-width: 980px) {
          .ag-row--half, .ag-row--7030, .ag-shift-grid, .ag-boards { grid-template-columns: 1fr; }
          .ag-base-hd { flex-wrap: wrap; row-gap: 0.4rem; }
          .ag-acc-meta { margin-left: 0; width: 100%; }
        }
        @media (max-width: 560px) {
          .ag-boxbody { padding: 1rem; }
          .ag-shift-info { display: none; }
        }
      `}</style>
    </div>
  );
}

export default AircraftGroups;
