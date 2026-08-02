import { useState, useEffect, useMemo, useCallback } from 'react';
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
const hoursLabel = (min) => `${Math.floor(min / 60)}h ${pad2(min % 60)}m`;

const WEEK_MIN = 7 * 1440;

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

// ── Weekly schedule grid ─────────────────────────────────────────────────────
// The same Mon–Sun timeline the aircraft schedule page uses, read-only, drawn
// from a planned (not yet written) week — so bars carry the anthracite dashed
// "ghost" language the bank planner already established for unwritten flights.
function WeekGrid({ legs, maintenance, conflicts }) {
  const flightBars = useMemo(() => legs.map((l, i) => {
    const dep = hhmmToMin(l.departure_time) ?? 0;
    const arr = hhmmToMin(l.arrival_time) ?? 0;
    const dur = (((arr - dep) % 1440) + 1440) % 1440 || 1440;
    const end = dep + dur;
    return {
      id: i, day: l.day_of_week, leg: l,
      top: dep * PX_PER_MIN,
      height: Math.max(Math.min(dur, 1440 - dep) * PX_PER_MIN, 12),
      overflowDay: end > 1440 ? (l.day_of_week + 1) % 7 : null,
      overflowHeight: end > 1440 ? Math.max((end - 1440) * PX_PER_MIN, 12) : 0,
    };
  }), [legs]);

  const maintBar = useMemo(() => {
    if (!maintenance) return null;
    const start = maintenance.start_minutes;
    const end = start + maintenance.duration_minutes;
    return {
      day: maintenance.day_of_week,
      top: start * PX_PER_MIN,
      height: Math.max(Math.min(maintenance.duration_minutes, 1440 - start) * PX_PER_MIN, 12),
      overflowDay: end > 1440 ? (maintenance.day_of_week + 1) % 7 : null,
      overflowHeight: end > 1440 ? Math.max((end - 1440) * PX_PER_MIN, 12) : 0,
    };
  }, [maintenance]);

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
                <span className="ag-bar-tm">{maintenance.start_time}</span>
              </div>
            )}
            {maintBar?.overflowDay === di && (
              <div className="ag-bar ag-bar--maint" style={{ top: 0, height: maintBar.overflowHeight }} />
            )}

            {flightBars.filter(b => b.day === di).map(b => (
              <div key={`f-${b.id}`}
                className={`ag-bar ag-bar--flight${conflicts?.has(b.leg) ? ' ag-bar--conflict' : ''}`}
                style={{ top: b.top, height: b.height }}
                title={`${b.leg.flight_number} ${b.leg.departure_airport}→${b.leg.arrival_airport} · ${b.leg.departure_time}–${b.leg.arrival_time} · ${b.leg.bank_name}`}>
                <span className="ag-bar-fn">{b.leg.flight_number}</span>
                <span className="ag-bar-rt">{b.leg.departure_airport}→{b.leg.arrival_airport}</span>
                <span className="ag-bar-tm">{b.leg.departure_time}–{b.leg.arrival_time}</span>
              </div>
            ))}
            {flightBars.filter(b => b.overflowDay === di).map(b => (
              <div key={`o-${b.id}`} className="ag-bar ag-bar--flight ag-bar--cont"
                style={{ top: 0, height: b.overflowHeight }}
                title={`${b.leg.flight_number} arrives ${b.leg.arrival_time}`}>
                <span className="ag-bar-tm">↳ {b.leg.arrival_time}</span>
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
  const [bankWish, setBankWish]               = useState({});   // bankId → 'HH:MM'
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
  const [autoName, setAutoName]   = useState(false);
  // Departure time per bank, in hub-local time. Two copies: what is typed (which
  // may be half-finished or nonsense) and the last valid value actually applied to
  // the draft — shifts are computed as a delta against the applied one, so typing
  // through an invalid intermediate never loses the reference point.
  const [bankTimeText, setBankTimeText]       = useState({});
  const [bankTimeApplied, setBankTimeApplied] = useState({});

  const headers = useMemo(() => ({ Authorization: `Bearer ${localStorage.getItem('token')}` }), []);
  const jsonHeaders = useMemo(() => ({ ...headers, 'Content-Type': 'application/json' }), [headers]);

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
    setBankTimeText({}); setBankTimeApplied({});
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
    setSelectedBankIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
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
  const setWish = (id, value) => {
    clearPlan();
    setBankWish(w => ({ ...w, [id]: value }));
  };

  // ── Compute ───────────────────────────────────────────────────────────────
  const computePlan = async () => {
    setError(''); setSuccess('');
    if (!fwdRoute) { setError('Select an outbound route.'); return; }
    if (!retRoute) { setError('No return route exists for this pairing — create the reverse route first.'); return; }
    if (selectedBankIds.length === 0) { setError('Select at least one bank.'); return; }
    if (selectedAcIds.length === 0) { setError('Select at least one aircraft.'); return; }

    setComputing(true);
    try {
      const res = await fetch(`${API_URL}/api/aircraft-groups/plan`, {
        method: 'POST', headers: jsonHeaders,
        body: JSON.stringify({
          forward_route_id: fwdRoute.id,
          return_route_id: retRoute.id,
          bank_ids: selectedBankIds,
          bank_departure_times: bankWish,
          aircraft_ids: selectedAcIds,
          strategy,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Could not compute a plan'); clearPlan(); }
      else {
        setPlan(data);
        setDraft(data.assignments.map(a => ({ ...a, legs: a.legs.map(l => ({ ...l })) })));
        setEditMode(false);
        setOpenSlots(new Set(data.assignments.length ? [data.assignments[0].slot] : []));
        const times = Object.fromEntries(data.banks.map(b => [b.id, b.departure_local]));
        setBankTimeText(times);
        setBankTimeApplied(times);
      }
    } catch { setError('Network error'); clearPlan(); }
    finally { setComputing(false); }
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
    setDraft(plan.assignments.map(a => ({ ...a, legs: a.legs.map(l => ({ ...l })) })));
    const times = Object.fromEntries(plan.banks.map(b => [b.id, b.departure_local]));
    setBankTimeText(times);
    setBankTimeApplied(times);
    setEditMode(false);
  };

  // Move a whole bank: every flight tagged with it — outbound and return, on every
  // aircraft in the group — shifts by the same delta, so the rotation keeps its
  // shape and only the wave moves. Days roll over the week boundary.
  const shiftBank = (bankId, value) => {
    setBankTimeText(t => ({ ...t, [bankId]: value }));
    const next = hhmmToMin(value);
    const cur  = hhmmToMin(bankTimeApplied[bankId]);
    if (next == null || cur == null || next === cur) return;
    const delta = next - cur;

    setDraft(d => d.map(a => ({
      ...a,
      legs: a.legs.map(l => {
        if (l.bank_id !== bankId) return l;
        const dep = hhmmToMin(l.departure_time) ?? 0;
        const arr = hhmmToMin(l.arrival_time) ?? 0;
        const block = (((arr - dep) % 1440) + 1440) % 1440;
        const abs = ((((l.day_of_week * 1440 + dep + delta) % WEEK_MIN) + WEEK_MIN) % WEEK_MIN);
        const nm = abs % 1440;
        return {
          ...l,
          day_of_week: Math.floor(abs / 1440),
          departure_time: minToHHMM(nm),
          arrival_time: minToHHMM(nm + block),
        };
      }),
    })));
    setBankTimeApplied(t => ({ ...t, [bankId]: minToHHMM(next) }));
  };

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

  // Suggested names in the shape players use by hand: DXB-JFK-B1.1 for the first
  // aircraft on bank 1, DXB-JFK-AB for a standby covering several banks.
  const suggestedName = useCallback((assignment) => {
    if (!plan || !fwdRoute) return '';
    const base = `${fwdRoute.departure_airport}-${fwdRoute.arrival_airport}`;
    if (assignment.bank_ids.length !== 1) return `${base}-AB`;
    const bankNo = plan.banks.findIndex(b => b.id === assignment.bank_ids[0]) + 1;
    const peers = draft.filter(a => a.bank_ids.length === 1 && a.bank_ids[0] === assignment.bank_ids[0]);
    const idx = peers.findIndex(a => a.slot === assignment.slot) + 1;
    return `${base}-B${bankNo}.${idx}`;
  }, [plan, fwdRoute, draft]);

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
    try {
      const res = await fetch(`${API_URL}/api/aircraft-groups/commit`, {
        method: 'POST', headers: jsonHeaders,
        body: JSON.stringify({
          forward_route_id: fwdRoute.id,
          return_route_id: retRoute.id,
          economy_price: ecoPrice,
          business_price: hasBusiness ? bizPrice : '',
          first_price: hasFirst ? firstPrice : '',
          service_profile_id: serviceProfileId ? parseInt(serviceProfileId) : undefined,
          assignments: draft.map(a => ({
            aircraft_id: a.aircraft_id,
            aircraft_name: autoName ? suggestedName(a) : undefined,
            legs: a.legs.map(l => ({
              route_id: l.route_id,
              day_of_week: l.day_of_week,
              departure_time: l.departure_time,
            })),
            maintenance: a.maintenance,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Could not write the plan');
      else {
        // left_grounded is not a failure: the aircraft was parked before the
        // plan and stays parked, schedule written, for the player to activate.
        const failed = (data.activation || []).filter(a => !a.activated && !a.left_grounded);
        setSuccess(data.message);
        if (failed.length) {
          setError(`Not activated: ${failed.map(f => `${f.registration} (${f.error})`).join(', ')}`);
        }
        clearPlan();
        const f = await fetch(`${API_URL}/api/aircraft/fleet`, { headers }).then(x => x.json());
        setFleet(f.fleet || []);
      }
    } catch { setError('Network error'); }
    finally { setCommitting(false); }
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
                <>
                  <div className="ag-bank-head">
                    <span>Bank</span><span>Window (hub local)</span><span>Wish departure</span>
                  </div>
                  {hubBanks.map(b => {
                    const on = selectedBankIds.includes(b.id);
                    return (
                      <div key={b.id} className={`ag-bank${on ? ' ag-bank--on' : ''}`}>
                        <label className="ag-bank-name">
                          <input type="checkbox" checked={on} onChange={() => toggleBank(b.id)} />
                          <span>{b.name}</span>
                        </label>
                        <span className="ag-bank-win">
                          arr {minToHHMM(b.earliest_arrival)}–{minToHHMM(b.latest_arrival)}
                          {' · '}dep {minToHHMM(b.earliest_departure)}–{minToHHMM(b.latest_departure)}
                        </span>
                        <input
                          className="ag-wish" type="text" placeholder="HH:MM"
                          value={bankWish[b.id] || ''} disabled={!on}
                          onChange={e => setWish(b.id, e.target.value)}
                        />
                      </div>
                    );
                  })}
                  <div className="ag-hint">
                    Leave the wish departure empty to let the planner pick the best minute inside the
                    window. A time you enter is used exactly, even outside the window — you'll get a
                    warning in the result if it falls outside.
                  </div>
                </>
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
                                      <td>
                                        {ac.airline_cabin_profile_name
                                          ? <span className="ag-ovcabin">{ac.airline_cabin_profile_name}</span>
                                          : <span className="ag-ovwarn">no cabin profile</span>}
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
              <button className="ag-btn-primary ag-btn-block" onClick={computePlan}
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
              <div className="ag-stats">
                <div className={`ag-stat${plan.missing_aircraft ? ' ag-stat--bad' : ''}`}>
                  <span className="ag-stat-v">{plan.required_aircraft}</span>
                  <span className="ag-stat-l">aircraft needed</span>
                </div>
                <div className="ag-stat">
                  <span className="ag-stat-v">{plan.summary.departures_per_week}</span>
                  <span className="ag-stat-l">round trips / week</span>
                </div>
                <div className="ag-stat">
                  <span className="ag-stat-v">{hoursLabel(plan.summary.round_trip_minutes)}</span>
                  <span className="ag-stat-l">per round trip</span>
                </div>
                <div className="ag-stat">
                  <span className="ag-stat-v">{plan.summary.total_flight_hours}h</span>
                  <span className="ag-stat-l">block hours / week</span>
                </div>
              </div>

              {plan.missing_aircraft > 0 && (
                <div className="ag-alert ag-alert--error" style={{ marginTop: '1rem' }}>
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

              {/* Move a whole wave: one field per bank, every flight follows */}
              <div className="ag-shift">
                <div className="ag-shift-hd">
                  Departure times
                  <span>Changing a time moves every flight of that bank, on all aircraft</span>
                </div>
                {plan.banks.map(b => {
                  const src = hubBanks.find(x => x.id === b.id);
                  const text = bankTimeText[b.id] ?? b.departure_local;
                  const min = hhmmToMin(text);
                  const invalid = min == null;
                  const outside = !invalid && src && !inWindow(min, src.earliest_departure, src.latest_departure);
                  const applied = hhmmToMin(bankTimeApplied[b.id] ?? b.departure_local);
                  const arrivalNow = applied != null ? minToHHMM(applied + b.elapsed_minutes) : b.arrival_local;
                  return (
                    <div key={b.id} className={`ag-shift-row${outside || invalid ? ' ag-shift-row--warn' : ''}`}>
                      <strong>{b.name}</strong>
                      <input
                        className={`ag-shift-inp${invalid ? ' ag-shift-inp--bad' : ''}`}
                        type="text" value={text}
                        onChange={e => shiftBank(b.id, e.target.value)}
                      />
                      <span className="ag-shift-info">
                        → arr {arrivalNow} ({hubCode} local) · {hoursLabel(b.elapsed_minutes)} out and back
                        {b.arr_bank_name !== b.name && <> · returns into {b.arr_bank_name}</>}
                      </span>
                      {invalid && <span className="ag-tag ag-tag--warn">enter HH:MM</span>}
                      {!invalid && outside && src && (
                        <span className="ag-tag ag-tag--warn">
                          outside bank window {minToHHMM(src.earliest_departure)}–{minToHHMM(src.latest_departure)}
                        </span>
                      )}
                    </div>
                  );
                })}
                {conflicts.size > 0 && (
                  <div className="ag-note ag-note--warn" style={{ marginTop: '0.65rem' }}>
                    ⚠ {conflicts.size} flight{conflicts.size === 1 ? '' : 's'} now clash with another flight
                    or with maintenance (marked red in the weeks below). The write will be rejected until
                    that is resolved.
                  </div>
                )}
              </div>

              <label className="ag-rename">
                <input type="checkbox" checked={autoName} onChange={e => setAutoName(e.target.checked)} />
                Rename aircraft to the plan pattern ({fwdRoute?.departure_airport}-{fwdRoute?.arrival_airport}-B1.1, …-AB)
              </label>

              {/* One accordion per aircraft, each showing its actual week */}
              <div className="ag-accordions">
                {draft.map(a => {
                  const open = openSlots.has(a.slot);
                  const legs = sortedLegs(a);
                  return (
                    <div key={a.slot} className="ag-acc">
                      <button className="ag-acc-hd" onClick={() => toggleSlot(a.slot)}>
                        <span className="ag-acc-chev">{open ? '▾' : '▸'}</span>
                        <span className="ag-acc-reg">
                          {a.registration || <em className="ag-missing">aircraft missing</em>}
                        </span>
                        <span className="ag-acc-bank">
                          {a.bank_names.length === 1 ? a.bank_names[0] : `Standby · ${a.bank_names.join(', ')}`}
                        </span>
                        <span className="ag-acc-days">{a.days.map(d => DAY_SHORT[d]).join(' ')}</span>
                        <span className="ag-acc-meta">
                          {legs.length} flights · {a.flight_hours}h · {a.utilisation_pct}% util
                        </span>
                      </button>
                      {open && (
                        <div className="ag-acc-body">
                          {autoName && a.aircraft_id && (
                            <div className="ag-note" style={{ marginBottom: '0.75rem' }}>
                              New name: <strong>{suggestedName(a)}</strong>
                            </div>
                          )}

                          <WeekGrid legs={legs} maintenance={a.maintenance} conflicts={conflicts} />

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

        /* Banks */
        .ag-bank-head, .ag-bank {
          display: grid; grid-template-columns: minmax(110px, 1fr) minmax(180px, 1.3fr) 92px;
          gap: 0.6rem; align-items: center;
        }
        .ag-bank-head {
          padding: 0 0.65rem 0.5rem; font-size: 0.7rem; font-weight: 700;
          color: #999; text-transform: uppercase; letter-spacing: 0.05em;
        }
        .ag-bank {
          padding: 0.55rem 0.65rem; border: 1px solid #E0E0E0; border-radius: 6px; margin-bottom: 0.4rem;
        }
        .ag-bank--on { border-color: #2C2C2C; background: #FAFAFA; }
        .ag-bank-name { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; color: #2C2C2C; cursor: pointer; }
        .ag-bank-name input { accent-color: #2C2C2C; }
        .ag-bank-win { font-size: 0.8rem; color: #666; font-variant-numeric: tabular-nums; }
        .ag-wish {
          padding: 0.35rem 0.5rem; border: 1px solid #E0E0E0; border-radius: 6px;
          font-size: 0.85rem; font-variant-numeric: tabular-nums; width: 100%; box-sizing: border-box;
        }
        .ag-wish:disabled { background: #F5F5F5; opacity: 0.5; }

        /* Aircraft list — mirrors the fleet Airplane List */
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
        .ag-ovwarn {
          font-size: 0.72rem; color: #B45309; background: #FFFBEB; border: 1px solid #FDE68A;
          border-radius: 4px; padding: 0.15rem 0.45rem; white-space: nowrap;
        }

        .ag-btn-primary {
          background: #2C2C2C; color: #fff; border: none; border-radius: 6px;
          padding: 0.7rem 1.4rem; font-size: 0.95rem; font-weight: 600; cursor: pointer;
        }
        .ag-btn-primary:hover:not(:disabled) { background: #1a1a1a; }
        .ag-btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
        .ag-btn-block { width: 100%; margin-top: 0.25rem; }

        /* Result */
        .ag-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; }
        .ag-stat {
          background: #F5F5F5; border: 1px solid #E0E0E0; border-radius: 8px;
          padding: 0.9rem 1rem; display: flex; flex-direction: column; gap: 0.2rem;
        }
        .ag-stat--bad { background: #FEF2F2; border-color: #FECACA; }
        .ag-stat-v { font-size: 1.35rem; font-weight: 700; color: #2C2C2C; font-variant-numeric: tabular-nums; }
        .ag-stat-l { font-size: 0.76rem; color: #888; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }

        /* Departure-time shifter */
        .ag-shift {
          margin-top: 1.25rem; padding: 1rem 1.1rem;
          background: #FAFAFA; border: 1px solid #E8E8E8; border-radius: 8px;
        }
        .ag-shift-hd {
          display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.75rem;
          font-size: 0.76rem; font-weight: 700; color: #2C2C2C;
          text-transform: uppercase; letter-spacing: 0.08em;
        }
        .ag-shift-hd span {
          font-size: 0.78rem; font-weight: 500; color: #999;
          text-transform: none; letter-spacing: 0;
        }
        .ag-shift-row {
          display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap;
          padding: 0.5rem 0.75rem; background: #fff;
          border: 1px solid #EDEDED; border-radius: 6px; margin-bottom: 0.4rem;
          font-size: 0.86rem; color: #666;
        }
        .ag-shift-row--warn { border-color: #FDE68A; background: #FFFDF7; }
        .ag-shift-row strong { color: #2C2C2C; min-width: 110px; }
        .ag-shift-inp {
          width: 76px; padding: 0.35rem 0.5rem; border: 1px solid #E0E0E0; border-radius: 6px;
          font-size: 0.9rem; font-weight: 600; color: #2C2C2C;
          font-variant-numeric: tabular-nums; text-align: center;
        }
        .ag-shift-inp:focus { outline: none; border-color: #2C2C2C; }
        .ag-shift-inp--bad { border-color: #FCA5A5; background: #FEF2F2; }
        .ag-shift-info { font-variant-numeric: tabular-nums; }
        .ag-tag { font-size: 0.72rem; font-weight: 700; border-radius: 4px; padding: 0.15rem 0.45rem; }
        .ag-tag--warn { background: #FFFBEB; color: #B45309; border: 1px solid #FDE68A; }

        .ag-rename {
          display: flex; align-items: center; gap: 0.55rem; margin-top: 1.25rem;
          font-size: 0.88rem; color: #666; cursor: pointer;
        }
        .ag-rename input { accent-color: #2C2C2C; }

        /* Accordions */
        .ag-accordions { margin-top: 1rem; border: 1px solid #E0E0E0; border-radius: 8px; overflow: hidden; }
        .ag-acc + .ag-acc { border-top: 1px solid #F0F0F0; }
        .ag-acc-hd {
          width: 100%; display: grid;
          grid-template-columns: 16px 110px minmax(150px, 1fr) minmax(130px, auto) minmax(200px, auto);
          gap: 0.75rem; align-items: center; text-align: left;
          background: #fff; border: none; padding: 0.85rem 1rem; cursor: pointer; font-size: 0.9rem;
        }
        .ag-acc-hd:hover { background: #FAFAFA; }
        .ag-acc-chev { color: #888; }
        .ag-acc-reg { font-weight: 700; color: #2C2C2C; letter-spacing: 0.02em; }
        .ag-missing { color: #B91C1C; font-style: italic; font-weight: 600; }
        .ag-acc-bank { color: #2C2C2C; font-weight: 600; }
        .ag-acc-days { color: #666; font-variant-numeric: tabular-nums; letter-spacing: 0.06em; }
        .ag-acc-meta { color: #888; font-size: 0.83rem; text-align: right; }
        .ag-acc-body { padding: 1rem; background: #FAFAFA; }

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
          .ag-row--half, .ag-row--7030 { grid-template-columns: 1fr; }
          .ag-stats { grid-template-columns: 1fr 1fr; }
          .ag-acc-hd { grid-template-columns: 16px 1fr; row-gap: 0.35rem; }
          .ag-acc-bank, .ag-acc-days, .ag-acc-meta { grid-column: 2; text-align: left; }
        }
        @media (max-width: 560px) {
          .ag-stats { grid-template-columns: 1fr; }
          .ag-boxbody { padding: 1rem; }
          .ag-bank-head { display: none; }
          .ag-bank { grid-template-columns: 1fr; gap: 0.4rem; }
        }
      `}</style>
    </div>
  );
}

export default AircraftGroups;
