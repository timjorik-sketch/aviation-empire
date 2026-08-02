import { useState, useEffect, useMemo, useCallback } from 'react';
import TopBar from '../components/TopBar.jsx';
import Loader from '../components/Loader.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const pad2 = (n) => String(n).padStart(2, '0');
const minToHHMM = (m) => `${pad2(Math.floor(((m % 1440) + 1440) % 1440 / 60))}:${pad2(((m % 1440) + 1440) % 1440 % 60)}`;
const hhmmToMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = parseInt(m[1]), mi = parseInt(m[2]);
  return h > 23 || mi > 59 ? null : h * 60 + mi;
};
const hoursLabel = (min) => `${Math.floor(min / 60)}h ${pad2(min % 60)}m`;

/**
 * Aircraft Groups — plan ONE round-trip route across SEVERAL aircraft so every
 * selected bank is served daily. Long-haul round trips run past 24 h, so a daily
 * service needs a small fleet flying an interleaved pattern; this page works that
 * pattern out, shows it per aircraft, and writes all weekly schedules at once.
 * Nothing is stored until "Write plan" — it is a planning assistant, not an entity.
 */
function AircraftGroups({ airline, onBack, backLabel = 'Fleet' }) {
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');

  const [routes, setRoutes]                 = useState([]);
  const [banks, setBanks]                   = useState([]);
  const [fleet, setFleet]                   = useState([]);
  const [serviceProfiles, setServiceProfiles] = useState([]);
  const [cabinProfiles, setCabinProfiles]   = useState([]);

  // ── Inputs ────────────────────────────────────────────────────────────────
  const [fwdRouteId, setFwdRouteId]         = useState('');
  const [selectedBankIds, setSelectedBankIds] = useState([]);
  const [bankWish, setBankWish]             = useState({});     // bankId → 'HH:MM'
  const [selectedAcIds, setSelectedAcIds]   = useState([]);
  const [strategy, setStrategy]             = useState('regular');
  const [ecoPrice, setEcoPrice]             = useState('');
  const [bizPrice, setBizPrice]             = useState('');
  const [firstPrice, setFirstPrice]         = useState('');
  const [serviceProfileId, setServiceProfileId] = useState('');

  // ── Plan / edit ───────────────────────────────────────────────────────────
  const [plan, setPlan]           = useState(null);
  const [draft, setDraft]         = useState([]);     // editable copy of plan.assignments
  const [computing, setComputing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [editMode, setEditMode]   = useState(false);
  const [openSlots, setOpenSlots] = useState(() => new Set());
  const [autoName, setAutoName]   = useState(false);

  const headers = useMemo(() => ({ Authorization: `Bearer ${localStorage.getItem('token')}` }), []);
  const jsonHeaders = useMemo(() => ({ ...headers, 'Content-Type': 'application/json' }), [headers]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [r, b, f, sp, cp] = await Promise.all([
          fetch(`${API_URL}/api/routes`, { headers }).then(x => x.json()),
          fetch(`${API_URL}/api/banks`, { headers }).then(x => x.json()),
          fetch(`${API_URL}/api/aircraft/fleet`, { headers }).then(x => x.json()),
          fetch(`${API_URL}/api/service-profiles`, { headers }).then(x => x.json()),
          fetch(`${API_URL}/api/cabin-profiles`, { headers }).then(x => x.json()),
        ]);
        if (cancelled) return;
        setRoutes(r.routes || []);
        setBanks(b.banks || []);
        setFleet(f.fleet || []);
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
  }, []);

  // Changing the route invalidates banks (they belong to a hub), the plan, and
  // pulls the route's saved pricing forward.
  useEffect(() => {
    clearPlan();
    setSelectedBankIds([]);
    if (fwdRoute) {
      setEcoPrice(fwdRoute.economy_price ? String(fwdRoute.economy_price) : '');
      setBizPrice(fwdRoute.business_price ? String(fwdRoute.business_price) : '');
      setFirstPrice(fwdRoute.first_price ? String(fwdRoute.first_price) : '');
    }
  }, [fwdRoute, clearPlan]);

  // Which cabin classes exist across the chosen aircraft decides which price
  // fields are meaningful.
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

  // Aircraft that could physically fly this route — range and both runways.
  // Grounded frames sort first: they are the ones free to be planned, while an
  // operating one has to be pulled out of service for the write.
  const capableFleet = useMemo(() => {
    if (!fwdRoute) return [];
    const dist = fwdRoute.distance_km;
    return fleet
      .filter(a => !a.range_km || dist <= a.range_km)
      .sort((x, y) => (x.is_active ? 1 : 0) - (y.is_active ? 1 : 0)
                   || (x.registration || '').localeCompare(y.registration || ''));
  }, [fleet, fwdRoute]);

  const groundedCount = useMemo(() => capableFleet.filter(a => !a.is_active).length, [capableFleet]);

  const toggleBank = (id) => {
    clearPlan();
    setSelectedBankIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  };
  const toggleAircraft = (id) => {
    clearPlan();
    setSelectedAcIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
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
          const block = ((oldArr - oldDep) % 1440 + 1440) % 1440;
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
    setEditMode(false);
  };

  const toggleSlot = (slot) => {
    setOpenSlots(s => {
      const next = new Set(s);
      if (next.has(slot)) next.delete(slot); else next.add(slot);
      return next;
    });
  };

  // Suggested aircraft names in the shape players use by hand:
  // DXB-JFK-B1.1 for the first aircraft on bank 1, DXB-JFK-AB for a standby that
  // covers several banks.
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

  return (
    <div className="ag-page">
      <div className="ag-container">
        <TopBar onBack={onBack} backLabel={backLabel} balance={airline?.balance} />

        <div className="ag-header">
          <h1>Aircraft Groups</h1>
          <p>
            Plan one round-trip route across several aircraft so every bank is served daily.
            Long-haul round trips run past 24 hours, so a daily departure needs an interleaved
            fleet — this works out the pattern, the maintenance slots and the crossovers.
          </p>
        </div>

        {error && <div className="ag-alert ag-alert--error">{error}</div>}
        {success && <div className="ag-alert ag-alert--ok">{success}</div>}

        {/* ── 1. Route ────────────────────────────────────────────────────── */}
        <section className="ag-card">
          <div className="ag-card-hd"><span className="ag-step">1</span> Route</div>
          <div className="ag-card-body">
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

        {/* ── 2. Banks + wish departure times ─────────────────────────────── */}
        <section className="ag-card">
          <div className="ag-card-hd"><span className="ag-step">2</span> Banks at {hubCode || 'the hub'}</div>
          <div className="ag-card-body">
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
                        className="ag-wish" type="text" placeholder="optional HH:MM"
                        value={bankWish[b.id] || ''} disabled={!on}
                        onChange={e => setWish(b.id, e.target.value)}
                      />
                    </div>
                  );
                })}
                <div className="ag-hint">
                  Leave the wish departure empty to let the planner pick the best minute inside the
                  window. A time you enter is used exactly, even if it falls outside the bank window —
                  you'll get a warning in the result if it does.
                </div>
              </>
            )}
          </div>
        </section>

        {/* ── 3. Aircraft ─────────────────────────────────────────────────── */}
        <section className="ag-card">
          <div className="ag-card-hd">
            <span className="ag-step">3</span> Aircraft
            <span className="ag-count">
              {selectedAcIds.length} selected
              {plan && <> · <strong>{plan.required_aircraft} needed</strong></>}
            </span>
          </div>
          <div className="ag-card-body">
            {!fwdRoute && <div className="ag-hint">Select a route first — the list only offers aircraft that can fly it.</div>}
            {fwdRoute && capableFleet.length === 0 && (
              <div className="ag-hint">No aircraft in your fleet has the range for {fwdRoute.distance_km?.toLocaleString()} km.</div>
            )}
            {capableFleet.length > 0 && (
              <>
                <div className="ag-ac-actions">
                  <button className="ag-btn-link" onClick={() => { clearPlan(); setSelectedAcIds(capableFleet.map(a => a.id)); }}>
                    Select all ({capableFleet.length})
                  </button>
                  <button className="ag-btn-link" onClick={() => { clearPlan(); setSelectedAcIds([]); }}>Clear</button>
                </div>
                <div className="ag-ac-list">
                  {capableFleet.map((a, i) => {
                    const on = selectedAcIds.includes(a.id);
                    // One divider where the grounded block ends and the operating
                    // one begins, so the sort order reads as intentional.
                    const startsOperating = a.is_active && i === groundedCount && groundedCount > 0;
                    return (
                      <div key={a.id} className="ag-ac-row">
                        {startsOperating && <div className="ag-ac-divider">Currently operating</div>}
                        <label className={`ag-ac${on ? ' ag-ac--on' : ''}`}>
                          <input type="checkbox" checked={on} onChange={() => toggleAircraft(a.id)} />
                          <span className={`ag-dot${a.is_active ? ' ag-dot--on' : ''}`} title={a.is_active ? 'Operating' : 'Grounded'} />
                          <span className="ag-ac-reg">{a.registration}</span>
                          <span className="ag-ac-name">{a.name || '—'}</span>
                          <span className="ag-ac-type">{a.full_name}</span>
                          {a.airline_cabin_profile_name
                            ? <span className="ag-ac-cabin">{a.airline_cabin_profile_name}</span>
                            : <span className="ag-ac-warn">no cabin profile</span>}
                          <span className="ag-ac-loc">{a.current_location || a.home_airport}</span>
                        </label>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </section>

        {/* ── 4. Pricing, service, strategy ───────────────────────────────── */}
        <section className="ag-card">
          <div className="ag-card-hd"><span className="ag-step">4</span> Pricing &amp; strategy</div>
          <div className="ag-card-body">
            <div className="ag-grid3">
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
            </div>
            <div className="ag-grid2">
              <div className="ag-field">
                <label>Service Profile</label>
                <select value={serviceProfileId} onChange={e => setServiceProfileId(e.target.value)}>
                  <option value="">— None —</option>
                  {serviceProfiles.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name} (E${p.economy_cost}{p.business_cost ? ` / B$${p.business_cost}` : ''}{p.first_cost ? ` / F$${p.first_cost}` : ''}/pax)
                    </option>
                  ))}
                </select>
              </div>
              <div className="ag-field">
                <label>Optimisation</label>
                <select value={strategy} onChange={e => { clearPlan(); setStrategy(e.target.value); }}>
                  <option value="regular">Regular — aircraft stay on one bank, plus standby</option>
                  <option value="fewest">Fewest aircraft — aircraft roll across banks</option>
                </select>
              </div>
            </div>
            <div className="ag-actions">
              <button className="ag-btn-primary" onClick={computePlan}
                disabled={computing || !fwdRoute || !retRoute || selectedBankIds.length === 0 || selectedAcIds.length === 0}>
                {computing ? 'Calculating…' : 'Calculate plan'}
              </button>
            </div>
          </div>
        </section>

        {/* ── Result ──────────────────────────────────────────────────────── */}
        {plan && (
          <section className="ag-card">
            <div className="ag-card-hd">
              Plan
              <span className="ag-card-hd-actions">
                {!editMode
                  ? <button className="ag-btn-ghost" onClick={() => setEditMode(true)}>Edit</button>
                  : <button className="ag-btn-ghost" onClick={resetDraft}>Discard edits</button>}
              </span>
            </div>
            <div className="ag-card-body">
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
                  {plan.missing_aircraft} more aircraft needed — the slots below without a registration
                  cannot be written. Select more aircraft, drop a bank, or switch to “Fewest aircraft”.
                </div>
              )}
              {plan.spare_aircraft.length > 0 && (
                <div className="ag-note" style={{ marginTop: '1rem' }}>
                  Not needed for this plan: {plan.spare_aircraft.map(a => a.registration).join(', ')}
                </div>
              )}
              {plan.note && <div className="ag-note ag-note--warn" style={{ marginTop: '1rem' }}>⚠ {plan.note}</div>}

              <div className="ag-banktimes">
                {plan.banks.map(b => (
                  <div key={b.id} className="ag-banktime">
                    <strong>{b.name}</strong>
                    <span>
                      dep {b.departure_local} → arr {b.arrival_local} ({hubCode} local)
                      {' · '}{hoursLabel(b.elapsed_minutes)} out and back
                      {b.arr_bank_name !== b.name && <> · returns into {b.arr_bank_name}</>}
                    </span>
                    {b.outside_window && <span className="ag-tag ag-tag--warn">wish time outside bank window</span>}
                  </div>
                ))}
              </div>

              <label className="ag-rename">
                <input type="checkbox" checked={autoName} onChange={e => setAutoName(e.target.checked)} />
                Rename aircraft to the plan pattern (e.g. {fwdRoute?.departure_airport}-{fwdRoute?.arrival_airport}-B1.1, …-AB)
              </label>

              {/* Accordions, one per aircraft */}
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
                        <span className="ag-acc-days">{a.days.map(d => DAYS_SHORT[d]).join(' ')}</span>
                        <span className="ag-acc-meta">
                          {legs.length} flights · {a.flight_hours}h · {a.utilisation_pct}% util
                        </span>
                      </button>
                      {open && (
                        <div className="ag-acc-body">
                          {autoName && a.aircraft_id && (
                            <div className="ag-note">New name: <strong>{suggestedName(a)}</strong></div>
                          )}
                          <table className="ag-legs">
                            <thead>
                              <tr>
                                <th>Day</th><th>Flight</th><th>Leg</th>
                                <th>Departure</th><th>Arrival</th><th>Bank</th>
                                {editMode && <th></th>}
                              </tr>
                            </thead>
                            <tbody>
                              {legs.map((l) => {
                                const realIdx = a.legs.indexOf(l);
                                return (
                                  <tr key={`${a.slot}-${realIdx}`}>
                                    <td>
                                      {editMode ? (
                                        <select value={l.day_of_week}
                                          onChange={e => updateLeg(a.slot, realIdx, { day_of_week: parseInt(e.target.value) })}>
                                          {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                                        </select>
                                      ) : DAYS[l.day_of_week]}
                                    </td>
                                    <td className="ag-mono">{l.flight_number}</td>
                                    <td>{l.departure_airport} → {l.arrival_airport}</td>
                                    <td>
                                      {editMode ? (
                                        <input className="ag-time" type="text" value={l.departure_time}
                                          onChange={e => updateLeg(a.slot, realIdx, { departure_time: e.target.value })} />
                                      ) : <span className="ag-mono">{l.departure_time}</span>}
                                    </td>
                                    <td className="ag-mono ag-muted">{l.arrival_time}</td>
                                    <td className="ag-muted">{l.bank_name}</td>
                                    {editMode && (
                                      <td>
                                        <button className="ag-btn-del" title="Remove this flight"
                                          onClick={() => deleteLeg(a.slot, realIdx)}>×</button>
                                      </td>
                                    )}
                                  </tr>
                                );
                              })}
                              {a.maintenance && (
                                <tr className="ag-maint">
                                  <td>{DAYS[a.maintenance.day_of_week]}</td>
                                  <td className="ag-mono">MAINT</td>
                                  <td>Routine maintenance</td>
                                  <td className="ag-mono">{a.maintenance.start_time}</td>
                                  <td className="ag-mono ag-muted">
                                    {minToHHMM(a.maintenance.start_minutes + a.maintenance.duration_minutes)}
                                  </td>
                                  <td className="ag-muted">{a.maintenance.duration_minutes} min</td>
                                  {editMode && <td></td>}
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="ag-commit">
                <div className="ag-commit-note">
                  Writing replaces the whole weekly schedule of every listed aircraft. They are
                  deactivated for the write and put back into operation afterwards.
                </div>
                <button className="ag-btn-primary" onClick={commitPlan}
                  disabled={committing || plan.missing_aircraft > 0}>
                  {committing ? 'Writing…' : `Confirm & write ${draft.length} schedules`}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>

      <style>{`
        .ag-page { min-height: 100vh; background: #F5F5F5; }
        .ag-container { max-width: 1200px; margin: 0 auto; padding: 1.5rem 1.5rem 4rem; }

        .ag-header { margin-bottom: 1.5rem; }
        .ag-header h1 { margin: 0 0 0.4rem; font-size: 1.9rem; font-weight: 700; color: #2C2C2C; }
        .ag-header p { margin: 0; max-width: 760px; color: #666666; font-size: 0.95rem; line-height: 1.55; }

        .ag-alert { padding: 0.85rem 1.1rem; border-radius: 8px; font-size: 0.92rem; margin-bottom: 1rem; }
        .ag-alert--error { background: #FEF2F2; border: 1px solid #FECACA; color: #B91C1C; }
        .ag-alert--ok { background: #F0FDF4; border: 1px solid #BBF7D0; color: #15803D; }

        .ag-card {
          background: #fff; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          margin-bottom: 1.25rem; overflow: hidden;
        }
        .ag-card-hd {
          display: flex; align-items: center; gap: 0.65rem;
          padding: 1rem 1.5rem; border-bottom: 1px solid #F0F0F0;
          font-weight: 700; color: #2C2C2C; font-size: 1.05rem;
        }
        .ag-card-hd-actions { margin-left: auto; display: flex; gap: 0.5rem; }
        .ag-card-body { padding: 1.5rem; }
        .ag-step {
          display: inline-flex; align-items: center; justify-content: center;
          width: 22px; height: 22px; border-radius: 50%;
          background: #2C2C2C; color: #fff; font-size: 0.78rem; font-weight: 700;
        }
        .ag-count { margin-left: auto; font-size: 0.88rem; font-weight: 600; color: #666; }

        .ag-field { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 1rem; }
        .ag-field label { font-size: 0.82rem; font-weight: 600; color: #666666; }
        .ag-field select, .ag-field input {
          padding: 0.6rem 0.75rem; border: 1px solid #E0E0E0; border-radius: 6px;
          font-size: 0.95rem; color: #2C2C2C; background: #fff; width: 100%;
        }
        .ag-field select:focus, .ag-field input:focus { outline: none; border-color: #2C2C2C; }
        .ag-field--off label, .ag-field--off input { opacity: 0.45; }
        .ag-grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
        .ag-grid2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; }

        .ag-note {
          background: #F5F5F5; border: 1px solid #E0E0E0; border-radius: 6px;
          padding: 0.6rem 0.85rem; font-size: 0.88rem; color: #666666;
        }
        .ag-note--warn { background: #FFFBEB; border-color: #FDE68A; color: #92400E; }
        .ag-hint { font-size: 0.86rem; color: #888888; line-height: 1.5; margin-top: 0.75rem; }

        /* Banks */
        .ag-bank-head, .ag-bank {
          display: grid; grid-template-columns: minmax(140px, 1fr) minmax(220px, 1.4fr) 150px;
          gap: 0.75rem; align-items: center;
        }
        .ag-bank-head {
          padding: 0 0.65rem 0.5rem; font-size: 0.75rem; font-weight: 700;
          color: #888; text-transform: uppercase; letter-spacing: 0.04em;
        }
        .ag-bank {
          padding: 0.6rem 0.65rem; border: 1px solid #E0E0E0; border-radius: 6px; margin-bottom: 0.4rem;
        }
        .ag-bank--on { border-color: #2C2C2C; background: #FAFAFA; }
        .ag-bank-name { display: flex; align-items: center; gap: 0.55rem; font-weight: 600; color: #2C2C2C; cursor: pointer; }
        .ag-bank-win { font-size: 0.85rem; color: #666; font-variant-numeric: tabular-nums; }
        .ag-wish {
          padding: 0.4rem 0.55rem; border: 1px solid #E0E0E0; border-radius: 6px;
          font-size: 0.88rem; font-variant-numeric: tabular-nums; width: 100%;
        }
        .ag-wish:disabled { background: #F5F5F5; opacity: 0.5; }

        /* Aircraft */
        .ag-ac-actions { display: flex; gap: 1rem; margin-bottom: 0.75rem; }
        .ag-btn-link {
          background: none; border: none; padding: 0; color: #2C2C2C;
          font-size: 0.85rem; font-weight: 600; cursor: pointer; text-decoration: underline;
        }
        .ag-ac-list { display: flex; flex-direction: column; gap: 0.3rem; max-height: 380px; overflow-y: auto; }
        .ag-ac-row { display: flex; flex-direction: column; gap: 0.3rem; }
        .ag-ac-divider {
          margin-top: 0.5rem; padding: 0 0.65rem 0.15rem;
          font-size: 0.72rem; font-weight: 700; color: #999;
          text-transform: uppercase; letter-spacing: 0.05em;
          border-bottom: 1px solid #F0F0F0;
        }
        .ag-ac {
          display: grid; grid-template-columns: 20px 12px 110px 1fr 1fr 1fr 60px;
          gap: 0.6rem; align-items: center; cursor: pointer;
          padding: 0.55rem 0.65rem; border: 1px solid #E0E0E0; border-radius: 6px; background: #fff;
        }
        .ag-ac:hover { border-color: #C8C8C8; }
        .ag-ac--on { border-color: #2C2C2C; background: #FAFAFA; }
        .ag-dot { width: 8px; height: 8px; border-radius: 50%; background: #D4D4D4; }
        .ag-dot--on { background: #22C55E; box-shadow: 0 0 0 3px rgba(34,197,94,0.18); }
        .ag-ac-reg { font-weight: 700; color: #2C2C2C; font-size: 0.9rem; letter-spacing: 0.02em; }
        .ag-ac-name, .ag-ac-type { font-size: 0.87rem; color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ag-ac-cabin { font-size: 0.85rem; color: #2C2C2C; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ag-ac-loc { font-size: 0.82rem; color: #888; font-weight: 600; }
        .ag-ac-warn {
          font-size: 0.72rem; color: #B45309; background: #FFFBEB; border: 1px solid #FDE68A;
          border-radius: 4px; padding: 0.15rem 0.4rem; justify-self: start; white-space: nowrap;
        }

        .ag-actions { display: flex; justify-content: flex-end; margin-top: 0.5rem; }
        .ag-btn-primary {
          background: #2C2C2C; color: #fff; border: none; border-radius: 6px;
          padding: 0.7rem 1.4rem; font-size: 0.95rem; font-weight: 600; cursor: pointer;
        }
        .ag-btn-primary:hover:not(:disabled) { background: #1a1a1a; }
        .ag-btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
        .ag-btn-ghost {
          background: #fff; border: 1px solid #E0E0E0; border-radius: 6px;
          padding: 0.4rem 0.85rem; font-size: 0.85rem; font-weight: 600; color: #2C2C2C; cursor: pointer;
        }
        .ag-btn-ghost:hover { background: #F5F5F5; border-color: #C8C8C8; }

        /* Result */
        .ag-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; }
        .ag-stat {
          background: #F5F5F5; border: 1px solid #E0E0E0; border-radius: 8px;
          padding: 0.9rem 1rem; display: flex; flex-direction: column; gap: 0.2rem;
        }
        .ag-stat--bad { background: #FEF2F2; border-color: #FECACA; }
        .ag-stat-v { font-size: 1.35rem; font-weight: 700; color: #2C2C2C; font-variant-numeric: tabular-nums; }
        .ag-stat-l { font-size: 0.76rem; color: #888; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }

        .ag-banktimes { margin-top: 1rem; display: flex; flex-direction: column; gap: 0.4rem; }
        .ag-banktime {
          display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap;
          padding: 0.55rem 0.85rem; background: #FAFAFA; border: 1px solid #F0F0F0; border-radius: 6px;
          font-size: 0.88rem; color: #666;
        }
        .ag-banktime strong { color: #2C2C2C; min-width: 110px; }
        .ag-tag { font-size: 0.72rem; font-weight: 700; border-radius: 4px; padding: 0.15rem 0.45rem; }
        .ag-tag--warn { background: #FFFBEB; color: #B45309; border: 1px solid #FDE68A; }

        .ag-rename {
          display: flex; align-items: center; gap: 0.55rem; margin-top: 1.25rem;
          font-size: 0.88rem; color: #666; cursor: pointer;
        }

        /* Accordions */
        .ag-accordions { margin-top: 1rem; border: 1px solid #E0E0E0; border-radius: 8px; overflow: hidden; }
        .ag-acc + .ag-acc { border-top: 1px solid #F0F0F0; }
        .ag-acc-hd {
          width: 100%; display: grid;
          grid-template-columns: 16px 110px minmax(150px, 1fr) minmax(130px, auto) minmax(210px, auto);
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
        .ag-acc-body { padding: 0 1rem 1.1rem; background: #FAFAFA; }

        .ag-legs { width: 100%; border-collapse: collapse; margin-top: 0.75rem; font-size: 0.88rem; }
        .ag-legs th {
          text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #E0E0E0;
          font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: #888; font-weight: 700;
        }
        .ag-legs td { padding: 0.45rem 0.6rem; border-bottom: 1px solid #F0F0F0; color: #2C2C2C; }
        .ag-legs select, .ag-time {
          padding: 0.3rem 0.4rem; border: 1px solid #E0E0E0; border-radius: 4px;
          font-size: 0.85rem; background: #fff; color: #2C2C2C;
        }
        .ag-time { width: 68px; font-variant-numeric: tabular-nums; }
        .ag-mono { font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
        .ag-muted { color: #888; }
        .ag-maint td { background: #F0F0F0; font-style: italic; }
        .ag-btn-del {
          background: none; border: none; color: #B91C1C; font-size: 1.05rem;
          cursor: pointer; line-height: 1; padding: 0 0.3rem;
        }

        .ag-commit {
          display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap;
          margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid #F0F0F0;
        }
        .ag-commit-note { flex: 1 1 320px; font-size: 0.85rem; color: #888; line-height: 1.5; }

        @media (max-width: 900px) {
          .ag-grid3, .ag-grid2, .ag-stats { grid-template-columns: 1fr 1fr; }
          .ag-bank-head { display: none; }
          .ag-bank { grid-template-columns: 1fr; gap: 0.4rem; }
          .ag-ac { grid-template-columns: 20px 12px 1fr; row-gap: 0.3rem; }
          .ag-ac-type, .ag-ac-cabin, .ag-ac-warn, .ag-ac-loc { grid-column: 3; }
          .ag-acc-hd { grid-template-columns: 16px 1fr; row-gap: 0.35rem; }
          .ag-acc-bank, .ag-acc-days, .ag-acc-meta { grid-column: 2; text-align: left; }
        }
        @media (max-width: 560px) {
          .ag-container { padding: 1rem 0.75rem 3rem; }
          .ag-grid3, .ag-grid2, .ag-stats { grid-template-columns: 1fr; }
          .ag-card-body { padding: 1rem; }
        }
      `}</style>
    </div>
  );
}

export default AircraftGroups;
