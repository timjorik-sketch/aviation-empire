import { useState, useEffect, useCallback, useMemo } from 'react';
import TopBar from '../components/TopBar.jsx';
import Toast from '../components/Toast.jsx';
import Loader from '../components/Loader.jsx';
import LiveFlightMap from '../components/LiveFlightMap.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

const fmtMoney = (n) => '$' + Math.round(n || 0).toLocaleString();

const PROGRAM_LABEL = { basic: 'Basic', enhanced: 'Enhanced', premium: 'Premium' };
const GH_LABEL      = { standard: 'Standard', priority: 'Priority', premium: 'Premium' };
const HP_LABEL      = { none: 'No Partnership', basic: 'Basic', premium: 'Premium', exclusive: 'Exclusive' };

const EVENT_LABEL = {
  technical_ground: 'Technical (Ground)',
  ground_ops:       'Ground Ops',
  atc:              'ATC',
  technical_air:    'Technical (Air)',
  medical:          'Medical',
  cascade:          'Cascade',
  medical_cascade:  'Medical Cascade',
  // legacy — kept so old report rows still render a label
  weather:          'Weather',
};
const OUTCOME_LABEL = {
  minor_delay: 'Minor Delay',
  cancelled:   'Cancelled',
  wet_leased:  'Wet-Leased',
  diverted:    'Diverted',
};

// ── Customer feedback message pools ──────────────────────────────────────────
const FEEDBACK_POOLS = {
  bev: {
    0: [
      "Not a single drink was offered. Truly unacceptable.",
      "No beverages at all on this flight. Hard to believe.",
      "I had nothing to drink the entire flight.",
      "Zero drink options. Won't be flying this airline again.",
    ],
    1: [
      "Only one drink option on a flight this long — disappointing.",
      "A bit more variety in drinks would go a long way.",
      "One beverage choice felt very limited for this route.",
      "Expected more drink options. Felt like a budget experience.",
    ],
    2: [
      "Decent selection, but still missing something for this distance.",
      "Two drinks is okay, but a flight this long deserves more.",
      "Could use one more beverage option on a route like this.",
      "Almost there on drinks — just one option short.",
    ],
  },
  food: {
    0: [
      "Not a single thing to eat. Absolutely nothing.",
      "No food whatsoever on this flight. Unbelievable.",
      "I was starving the entire journey. No food at all.",
      "Zero food offered. This is not okay.",
    ],
    1: [
      "One meal for this distance? Still hungry when we landed.",
      "Expected a second meal on such a long flight.",
      "A single snack doesn't cut it for a flight this long.",
      "One meal is simply not enough. Left the plane hungry.",
    ],
    2: [
      "Two meals helped, but a flight this long really needs more.",
      "Almost enough food — could use one more service.",
      "Good effort on food, but we needed one more meal.",
      "Third meal service would have made a real difference here.",
    ],
  },
  amenity: [
    "No amenity kit at all. Felt very bare-bones.",
    "Would have appreciated at least a toothbrush on this flight.",
    "No amenity kit in this cabin class? Feels cheap.",
    "A small amenity kit would've made this flight much more comfortable.",
  ],
  sleep: [
    "Couldn't sleep a minute — a blanket would've helped enormously.",
    "10 hours with no pillow or blanket. My back is wrecked.",
    "No sleep kit on an overnight flight. Truly a miss.",
    "A pillow and blanket should be standard on a flight this long.",
  ],
  ent: [
    "Hours with nothing to watch. Felt like forever.",
    "No entertainment system on this route? Hard to believe.",
    "Stared at the seat in front of me the whole flight.",
    "No IFE on a long-haul is simply not acceptable anymore.",
  ],
  lug: {
    1: [
      "Only cabin baggage included on this distance? Ridiculous.",
      "Had to pay extra just to bring a normal suitcase.",
      "No checked luggage included — felt very restrictive.",
      "Expected at least a checked bag to be included on this route.",
    ],
    2: [
      "The luggage allowance was too small for a trip this long.",
      "Had to leave half my clothes at home due to luggage limits.",
      "A larger bag allowance would be appreciated on this route.",
      "Luggage restrictions made packing for this trip a nightmare.",
    ],
  },
  seat_eco: [
    "Sat upright for 10 hours. Never again.",
    "An upright seat on this distance is genuinely painful.",
    "My back is completely destroyed. Upgrade the seats.",
    "Could not sleep at all in this seat. Far too uncomfortable.",
  ],
  seat_biz: [
    "Expected a lie-flat in business on this route. Very disappointing.",
    "Business class should mean a proper flat bed on long haul.",
    "Paid business class prices for what felt like a premium economy seat.",
    "No lie-flat in business on this distance is hard to justify.",
  ],
  seat_fir: [
    "First class without a suite on this route felt underwhelming.",
    "Expected full suite privacy in first class. Didn't get it.",
    "A suite is the minimum expectation in first on this distance.",
    "First class should mean a suite. This fell short.",
  ],
  maint: [
    "The seat was broken the entire flight.",
    "Everything felt worn out and poorly maintained.",
    "Multiple things weren't working properly. Felt unsafe.",
    "The cabin looked and felt like it hadn't been serviced in years.",
  ],
};

function seededRand(seed) {
  let s = seed >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
  s = (s ^ (s >>> 16)) >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0x100000000; };
}

const CABIN_SHORT = { economy: 'E', business: 'B', first: 'F' };
const RULE_CABIN = { seat_eco: ['economy'], seat_biz: ['business'], seat_fir: ['first'] };

function getFeedbackMessages(violations, flightId) {
  if (!violations || violations.length === 0) return [];
  const rand = seededRand(flightId || 0);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const messages = [];
  for (const v of violations.slice(0, 3)) {
    let pool = null;
    const { rule, have, cabins } = v;
    if (rule === 'bev')  pool = FEEDBACK_POOLS.bev[Math.min(have ?? 0, 2)];
    else if (rule === 'food') pool = FEEDBACK_POOLS.food[Math.min(have ?? 0, 2)];
    else if (rule === 'lug')  pool = FEEDBACK_POOLS.lug[Math.min(Math.max(have ?? 1, 1), 2)];
    else if (FEEDBACK_POOLS[rule] && Array.isArray(FEEDBACK_POOLS[rule])) pool = FEEDBACK_POOLS[rule];
    if (pool && pool.length > 0) {
      const resolvedCabins = RULE_CABIN[rule] || cabins || [];
      messages.push({ msg: pick(pool), cabins: resolvedCabins });
    }
  }
  return messages;
}

function FlightCard({ flight, onNavigateToAirport, onNavigateToAircraft }) {
  const now   = Date.now();
  const dep   = new Date(flight.departure_time).getTime();
  const arr   = new Date(flight.arrival_time).getTime();
  const total = arr - dep;
  const pct   = total > 0 ? Math.max(0, Math.min(100, ((now - dep) / total) * 100)) : 0;
  const remMs = Math.max(0, arr - now);
  const remH  = Math.floor(remMs / 3600000);
  const remM  = Math.floor((remMs % 3600000) / 60000);
  const timeStr = remMs > 0 ? `${remH}h ${String(remM).padStart(2, '0')}m remaining` : 'Landing';
  const isDiverted = flight.delay_reason === 'medical' && flight.diversion_airport_code;

  return (
    <div className="occ-card">
      <div className="occ-card-hd">
        <span className="occ-card-reg">{flight.flight_number}</span>
        <span className="occ-card-type">{flight.aircraft_type}</span>
        {isDiverted && (
          <span style={{ marginLeft: 'auto', fontSize: '0.68rem', fontWeight: 700, color: '#fff', background: '#f97316', padding: '2px 8px', borderRadius: 3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Diverted → {flight.diversion_airport_code}
          </span>
        )}
      </div>
      <div className="occ-fp-wrap">
        <div className="occ-fp-route">
          <div className="occ-fp-apt">
            <button className="occ-apt-link occ-fp-code" onClick={() => onNavigateToAirport?.(flight.departure_airport)}>
              {flight.departure_airport}
            </button>
            {flight.departure_name && <span className="occ-fp-apt-name">{flight.departure_name}</span>}
          </div>
          <div className="occ-fp-apt occ-fp-apt-r">
            <button className="occ-apt-link occ-fp-code" onClick={() => onNavigateToAirport?.(flight.arrival_airport)}>
              {flight.arrival_airport}
            </button>
            {flight.arrival_name && <span className="occ-fp-apt-name">{flight.arrival_name}</span>}
          </div>
        </div>
        <div className="occ-fp-bar">
          <div className="occ-fp-line" />
          <span className="occ-fp-plane" style={{ left: `calc(${pct}% - 9px)` }}>✈</span>
        </div>
        <div className="occ-fp-meta">
          <button className="occ-fp-reg" onClick={() => onNavigateToAircraft?.(flight.aircraft_id)}>
            {flight.aircraft_registration}
          </button>
          <span className="occ-fp-time">{timeStr}</span>
        </div>
      </div>
    </div>
  );
}

export default function OperationsControlCenter({ airline, onBack, backLabel = 'Dashboard', onBalanceUpdate, onNavigateToAircraft, onNavigateToAirport }) {
  const [tab, setTab] = useState('active');
  const [data, setData] = useState(null);
  const [report, setReport] = useState(null);
  const [flights, setFlights] = useState([]);
  const [clientFeedback, setClientFeedback] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [activePage, setActivePage] = useState(0);

  const ACTIVE_PAGE_SIZE = 24;

  const token = localStorage.getItem('token');
  const auth = useMemo(() => ({ 'Authorization': `Bearer ${token}` }), [token]);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/occ`, { headers: auth });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to load configuration');
      setData(d);
    } catch (e) { setError(e.message); }
  }, [auth]);

  const fetchReport = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/occ/weekly-report`, { headers: auth });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to load weekly report');
      setReport(d);
    } catch (e) { setError(e.message); }
  }, [auth]);

  const fetchFlights = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/flights`, { headers: auth });
      const d = await res.json();
      setFlights(d.flights || []);
      const airlineRes = await fetch(`${API_URL}/api/airline`, { headers: auth });
      const airlineData = await airlineRes.json();
      if (airlineData.airline && onBalanceUpdate && airline && airlineData.airline.balance !== airline.balance) {
        onBalanceUpdate(airlineData.airline.balance);
      }
    } catch { /* silent */ }
  }, [auth, onBalanceUpdate, airline]);

  const fetchClientFeedback = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/flights/client-feedback`, { headers: auth });
      const d = await res.json();
      setClientFeedback(d.items || []);
    } catch { /* silent */ }
  }, [auth]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([fetchConfig(), fetchReport(), fetchFlights(), fetchClientFeedback()]);
      setLoading(false);
    })();
    const flightsInterval = setInterval(fetchFlights, 10000);
    const fbInterval = setInterval(fetchClientFeedback, 60000);
    return () => { clearInterval(flightsInterval); clearInterval(fbInterval); };
  }, [fetchConfig, fetchReport, fetchFlights, fetchClientFeedback]);

  const patch = async (url, body, successMsg) => {
    setSaving(true); setError(''); setSuccess('');
    try {
      const res = await fetch(`${API_URL}${url}`, {
        method: 'PATCH',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Update failed');
      setSuccess(successMsg);
      await Promise.all([fetchConfig(), fetchReport()]);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  if (loading) {
    return (
      <div className="app">
        <div className="page-hero" style={{ backgroundImage: "url('/header-images/Headerimage_OCC.png')" }}>
          <div className="page-hero-overlay">
            <h1>Operations Control Center</h1>
            <p>{airline?.name}</p>
          </div>
        </div>
        <div className="container" style={{ paddingTop: 24 }}>
          <TopBar onBack={onBack} balance={airline?.balance} airline={airline} backLabel={backLabel} />
          <Loader />
        </div>
      </div>
    );
  }

  const cat = data?.catalog || {};
  const fleetCount = data?.fleet_count || 0;
  const hubCount   = data?.hub_count   || 0;

  // Weekly subscription cost preview
  const maintCfg = cat.maintenance_programs?.[data?.maintenance_program] || {};
  const ghCfg    = cat.ground_handling_levels?.[data?.ground_handling_level] || {};
  const weeklyMaint = (maintCfg.weeklyCost || 0) * fleetCount;
  const weeklyGh    = (ghCfg.weeklyCost    || 0) * hubCount;
  const weeklyHp    = cat.hotel_partnerships?.[data?.hotel_partnership]?.weeklyCost || 0;
  const weeklyTotal = weeklyMaint + weeklyGh + weeklyHp;

  // KPI values from report
  const f = report?.flights || {};
  const t = report?.totals || {};
  const stability = f.stability;
  const stabPct = stability != null ? (stability * 100).toFixed(1) + '%' : '—';
  const stabColor = stability == null ? '#2C2C2C' : stability >= 0.95 ? '#16a34a' : stability >= 0.85 ? '#eab308' : '#dc2626';

  const activeFlights = flights.filter(fl => fl.status === 'in-flight');
  const activePageCount = Math.max(1, Math.ceil(activeFlights.length / ACTIVE_PAGE_SIZE));
  const safeActivePage  = Math.min(activePage, activePageCount - 1);
  const activeFlightsPage = activeFlights.slice(safeActivePage * ACTIVE_PAGE_SIZE, (safeActivePage + 1) * ACTIVE_PAGE_SIZE);
  const feedbackCount = clientFeedback.length;

  return (
    <div className="app">
      <div className="page-hero" style={{ backgroundImage: "url('/header-images/Headerimage_OCC.png')" }}>
        <div className="page-hero-overlay">
          <h1>Operations Control Center</h1>
          <p>{airline?.name}</p>
        </div>
      </div>

      <div className="container" style={{ paddingTop: 24 }}>
        <TopBar onBack={onBack} balance={airline?.balance} airline={airline} backLabel={backLabel} />
        <Toast error={error} success={success} onClearError={() => setError('')} onClearSuccess={() => setSuccess('')} />

        {/* ── Live Map (top) ── */}
        <div className="info-card" style={{ padding: 0, overflow: 'hidden', marginBottom: '1rem' }}>
          <div className="card-header-bar" style={{ margin: 0, borderRadius: '8px 8px 0 0' }}>
            <span className="card-header-bar-title">Live Map</span>
          </div>
          <LiveFlightMap />
        </div>

        {/* ── Tab bar ── */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid #E0E0E0' }}>
          <TabBtn active={tab === 'active'}   onClick={() => setTab('active')}>Active Flights ({activeFlights.length})</TabBtn>
          <TabBtn active={tab === 'delays'}   onClick={() => setTab('delays')}>Delays</TabBtn>
          <TabBtn active={tab === 'feedback'} onClick={() => setTab('feedback')}>
            Customer Feedback{feedbackCount > 0 ? ` (${feedbackCount})` : ''}
          </TabBtn>
        </div>

        {tab === 'active' && (
          <div className="info-card">
            <div className="card-header-bar">
              <span className="card-header-bar-title">Active Flights ({activeFlights.length})</span>
            </div>
            {activeFlights.length === 0 ? (
              <div className="occ-empty">No flights currently in the air.</div>
            ) : (
              <>
                <div className="occ-grid">
                  {activeFlightsPage.map(fl => (
                    <FlightCard
                      key={fl.id}
                      flight={fl}
                      onNavigateToAirport={onNavigateToAirport}
                      onNavigateToAircraft={onNavigateToAircraft}
                    />
                  ))}
                </div>
                {activePageCount > 1 && (
                  <Pagination
                    page={safeActivePage}
                    pageCount={activePageCount}
                    pageSize={ACTIVE_PAGE_SIZE}
                    total={activeFlights.length}
                    onChange={setActivePage}
                  />
                )}
              </>
            )}
          </div>
        )}

        {tab === 'delays' && (
          <>
            {/* 4 KPI Cards */}
            <div style={{ display: 'flex', gap: '16px', marginBottom: '20px', flexWrap: 'wrap' }}>
              <KPI label="Weekly OCC Cost"  value={fmtMoney(weeklyTotal)} />
              <KPI label="Stability"        value={stabPct} valColor={stabColor} sub={`of ${f.finalized || 0} finalized flights`} />
              <KPI label="Cancellations"    value={(f.cancelled || 0).toLocaleString()} sub="Last 7 days" />
              <KPI label="Disruption Cost"  value={fmtMoney(t.disruption_cost)} sub="Last 7 days" />
            </div>

            {/* Configuration cards */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '16px',
              marginBottom: '20px',
            }}>
              <ConfigCard
                title="Maintenance Program"
                image="/occ/occ_maintenance.png"
                subtitle="Reduces Technical delay rates for the entire fleet."
                footnote={fleetCount > 0
                  ? `Per aircraft × ${fleetCount} → ${fmtMoney(weeklyMaint)} / week`
                  : 'No aircraft yet'}
              >
                <OptionStack>
                  {Object.entries(cat.maintenance_programs || {}).map(([k, cfg]) => (
                    <OptionCard
                      key={k}
                      selected={data.maintenance_program === k}
                      label={PROGRAM_LABEL[k] || k}
                      cost={cfg.weeklyCost}
                      costSuffix="per aircraft"
                      detail={cfg.technicalReduction > 0
                        ? `-${(cfg.technicalReduction * 100).toFixed(1)}% on technical delays`
                        : 'No reduction'}
                      disabled={saving}
                      onClick={() => patch('/api/occ/maintenance', { program: k }, `Maintenance set to ${PROGRAM_LABEL[k]}`)}
                    />
                  ))}
                </OptionStack>
              </ConfigCard>

              <ConfigCard
                title="Ground Handling Level"
                image="/occ/occ_ground.png"
                subtitle="Reduces Ground Ops delay rate at every hub."
                footnote={hubCount > 0
                  ? `Per hub × ${hubCount} → ${fmtMoney(weeklyGh)} / week`
                  : 'No hubs yet'}
              >
                <OptionStack>
                  {Object.entries(cat.ground_handling_levels || {}).map(([k, cfg]) => (
                    <OptionCard
                      key={k}
                      selected={data.ground_handling_level === k}
                      label={GH_LABEL[k] || k}
                      cost={cfg.weeklyCost}
                      costSuffix="per hub"
                      detail={cfg.groundOpsReduction > 0
                        ? `-${(cfg.groundOpsReduction * 100).toFixed(1)}% on ground ops delays`
                        : 'No reduction'}
                      disabled={saving}
                      onClick={() => patch('/api/occ/ground-handling', { level: k }, `Ground handling set to ${GH_LABEL[k]}`)}
                    />
                  ))}
                </OptionStack>
              </ConfigCard>

              <ConfigCard
                title="Hotel Partnership"
                image="/occ/occ_hotel.png"
                subtitle="Lowers hotel cost per pax when cancellations strand passengers at a non-hub."
                footnote="Flat fee — applies airline-wide"
              >
                <OptionStack>
                  {Object.entries(cat.hotel_partnerships || {}).map(([k, cfg]) => (
                    <OptionCard
                      key={k}
                      selected={data.hotel_partnership === k}
                      label={HP_LABEL[k] || k}
                      cost={cfg.weeklyCost}
                      detail={`$${cfg.hotelCostPerPax}/pax on cancel`}
                      disabled={saving}
                      onClick={() => patch('/api/occ/hotel-partnership', { partnership: k }, `Hotel partnership set to ${HP_LABEL[k]}`)}
                    />
                  ))}
                </OptionStack>
              </ConfigCard>
            </div>

            {/* Weekly Report */}
            {report && (
              <ReportView
                report={report}
                onNavigateToAircraft={onNavigateToAircraft}
                onNavigateToAirport={onNavigateToAirport}
              />
            )}
          </>
        )}

        {tab === 'feedback' && (
          <div className="info-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ background: '#2C2C2C', padding: '14px 20px', borderRadius: '8px 8px 0 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="card-header-bar-title" style={{ color: '#fff' }}>Customer Feedback</span>
              {clientFeedback.length > 0 && (
                <span style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.5)' }}>Last 24 h</span>
              )}
            </div>
            {clientFeedback.length === 0 ? (
              <div className="occ-empty">No feedback in the last 24 hours.</div>
            ) : (
              <div className="occ-fb-list">
                {clientFeedback.map(fb => {
                  const entries = getFeedbackMessages(fb.violated_rules, fb.id);
                  return (
                    <button
                      key={fb.id}
                      className="occ-fb-item"
                      onClick={() => onNavigateToAircraft?.(fb.aircraft_id)}
                    >
                      <div className="occ-fb-hd">
                        <span className="occ-fb-fn">{fb.flight_number}</span>
                        <span className="occ-fb-route">{fb.departure_airport} → {fb.arrival_airport}</span>
                        <span className="occ-fb-reg">{fb.registration}</span>
                      </div>
                      {entries.map(({ msg, cabins }, i) => (
                        <div key={i} className="occ-fb-msg-row">
                          {cabins.length > 0 && (
                            <span className="occ-fb-badges">
                              {cabins.map(c => (
                                <span key={c} className={`occ-fb-badge occ-fb-badge--${c}`}>{CABIN_SHORT[c] ?? c}</span>
                              ))}
                            </span>
                          )}
                          <span className="occ-fb-msg">"{msg}"</span>
                        </div>
                      ))}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        .occ-empty { color: #999; font-size: 0.88rem; font-style: italic; padding: 1.5rem 1.1rem; }
        .occ-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 0.85rem;
          padding: 1rem 1.1rem;
        }

        .occ-card { background: white; border-radius: 8px; border: 1px solid #EEEEEE; overflow: hidden; }
        .occ-card-hd {
          background: #F5F5F5; padding: 0.55rem 1rem;
          display: flex; align-items: baseline; gap: 0.6rem;
          border-bottom: 1px solid #EEEEEE;
        }
        .occ-card-reg { font-family: monospace; font-size: 1rem; font-weight: 900; color: #2C2C2C; letter-spacing: 0.04em; }
        .occ-card-type { font-size: 0.68rem; color: #888; font-weight: 500; }

        .occ-fp-wrap { padding: 12px 16px 14px; }
        .occ-fp-route { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 10px; }
        .occ-fp-apt { display: flex; flex-direction: column; gap: 5px; align-items: flex-start; }
        .occ-fp-apt-r { align-items: flex-end; text-align: right; }
        .occ-fp-code {
          font-family: monospace; font-size: 1.25rem; font-weight: 900; color: #2C2C2C;
          line-height: 1; background: none; border: none; padding: 0; cursor: pointer;
          text-decoration: underline; text-decoration-color: rgba(0,0,0,0.25); text-underline-offset: 2px;
        }
        .occ-fp-code:hover { color: #555; }
        .occ-fp-apt-name { font-size: 10px; color: #999; line-height: 1.2; max-width: 100px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .occ-fp-bar { position: relative; height: 24px; display: flex; align-items: center; margin-bottom: 8px; }
        .occ-fp-line { position: absolute; left: 0; right: 0; height: 2px; background: #E0E0E0; }
        .occ-fp-line::before, .occ-fp-line::after {
          content: ''; position: absolute; top: 50%; transform: translateY(-50%);
          width: 5px; height: 5px; border-radius: 50%; background: #2C2C2C;
        }
        .occ-fp-line::before { left: 0; }
        .occ-fp-line::after  { right: 0; }
        .occ-fp-plane { position: absolute; font-size: 16px; line-height: 1; top: 50%; transform: translateY(-50%); z-index: 1; }
        .occ-fp-meta { display: flex; align-items: center; gap: 8px; }
        .occ-fp-reg {
          font-family: monospace; font-size: 0.75rem; font-weight: 700; color: #2C2C2C;
          background: none; border: none; padding: 0; cursor: pointer;
          text-decoration: underline; text-decoration-color: rgba(0,0,0,0.25); text-underline-offset: 2px;
        }
        .occ-fp-reg:hover { color: #555; }
        .occ-fp-time { font-size: 0.75rem; color: #888; margin-left: auto; }
        .occ-apt-link {
          background: none; border: none; padding: 0; cursor: pointer; color: #2C2C2C; font-weight: 600;
          text-decoration: underline; text-decoration-color: rgba(0,0,0,0.25);
          text-underline-offset: 2px; font-family: inherit;
        }
        .occ-apt-link:hover { color: #555; }

        .occ-fb-list { display: flex; flex-direction: column; }
        .occ-fb-item {
          width: 100%; background: none; border: none; border-bottom: 1px solid #F2F2F2;
          padding: 10px 16px; cursor: pointer; text-align: left;
          transition: background 0.15s;
        }
        .occ-fb-item:last-child { border-bottom: none; }
        .occ-fb-item:hover { background: #FEF2F2; }
        .occ-fb-hd { display: flex; align-items: baseline; gap: 6px; margin-bottom: 4px; }
        .occ-fb-fn { font-family: monospace; font-size: 0.78rem; font-weight: 800; color: #2C2C2C; }
        .occ-fb-route { font-size: 0.72rem; color: #888; flex: 1; }
        .occ-fb-reg { font-family: monospace; font-size: 0.68rem; color: #BBB; }
        .occ-fb-msg-row {
          display: flex; align-items: baseline; gap: 5px; margin-top: 2px;
        }
        .occ-fb-badges { display: flex; gap: 3px; flex-shrink: 0; align-items: center; }
        .occ-fb-badge {
          display: inline-block; font-size: 0.6rem; font-weight: 800;
          padding: 1px 4px; border-radius: 3px; letter-spacing: 0.04em;
          font-family: monospace; line-height: 1.5;
        }
        .occ-fb-badge--economy         { background: #E8F4FD; color: #1565C0; border: 1px solid #BBDEFB; }
        .occ-fb-badge--business        { background: #1C3A6B; color: #E3F2FD; border: 1px solid #1565C0; }
        .occ-fb-badge--first           { background: #FFF8E1; color: #7B5E00; border: 1px solid #FFE082; }
        .occ-fb-badge--premium_economy { background: #EDE7F6; color: #4527A0; border: 1px solid #D1C4E9; }
        .occ-fb-msg {
          font-size: 0.75rem; color: #7F1D1D; font-style: italic; line-height: 1.4;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }

        @media (max-width: 480px) {
          .occ-grid { grid-template-columns: 1fr; padding: 0.75rem; gap: 0.65rem; }
          .occ-fp-route { gap: 4px; }
          .occ-fp-code { font-size: 1.1rem; }
          .occ-fp-apt-name { max-width: 80px; font-size: 9px; }
          .occ-fb-msg { white-space: normal; }
          .occ-fb-hd { flex-wrap: wrap; }
        }
      `}</style>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function KPI({ label, value, valColor = '#2C2C2C', sub }) {
  return (
    <div style={{ background: '#fff', borderRadius: '8px', padding: '20px 24px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', flex: '1 1 0', minWidth: '180px' }}>
      <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#999', marginBottom: '6px' }}>{label}</div>
      <div style={{ fontSize: '1.55rem', fontWeight: 700, color: valColor, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ marginTop: '6px', fontSize: '0.72rem', color: '#888', lineHeight: 1.3 }}>{sub}</div>}
    </div>
  );
}

function Pagination({ page, pageCount, pageSize, total, onChange }) {
  const from = page * pageSize + 1;
  const to   = Math.min(total, (page + 1) * pageSize);

  // Compact page list with ellipses (e.g., 1 … 4 5 6 … 12)
  const pages = [];
  const window = 1; // neighbors around current
  for (let i = 0; i < pageCount; i++) {
    if (i === 0 || i === pageCount - 1 || Math.abs(i - page) <= window) {
      pages.push(i);
    } else if (pages[pages.length - 1] !== '…') {
      pages.push('…');
    }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 12, padding: '12px 1.1rem 1rem', borderTop: '1px solid #F0F0F0', flexWrap: 'wrap',
    }}>
      <div style={{ fontSize: '0.78rem', color: '#888' }}>
        Showing <strong style={{ color: '#2C2C2C' }}>{from}–{to}</strong> of <strong style={{ color: '#2C2C2C' }}>{total}</strong>
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <PageBtn disabled={page === 0} onClick={() => onChange(page - 1)} aria-label="Previous page">‹</PageBtn>
        {pages.map((p, i) =>
          p === '…'
            ? <span key={`e${i}`} style={{ padding: '0 6px', color: '#BBB', fontSize: '0.85rem' }}>…</span>
            : <PageBtn key={p} active={p === page} onClick={() => onChange(p)}>{p + 1}</PageBtn>
        )}
        <PageBtn disabled={page >= pageCount - 1} onClick={() => onChange(page + 1)} aria-label="Next page">›</PageBtn>
      </div>
    </div>
  );
}

function PageBtn({ active, disabled, onClick, children, ...rest }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      {...rest}
      style={{
        minWidth: 30, height: 30, padding: '0 8px',
        background: active ? '#2C2C2C' : '#fff',
        color: active ? '#fff' : disabled ? '#CCC' : '#2C2C2C',
        border: `1px solid ${active ? '#2C2C2C' : '#E0E0E0'}`,
        borderRadius: 6,
        fontSize: '0.82rem', fontWeight: 600,
        cursor: disabled || active ? 'default' : 'pointer',
        transition: 'all 0.15s',
      }}
    >{children}</button>
  );
}

function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: 'transparent', border: 'none', cursor: 'pointer',
      padding: '10px 18px', fontSize: '0.95rem', fontWeight: 600,
      color: active ? '#2C2C2C' : '#888',
      borderBottom: active ? '2px solid #2C2C2C' : '2px solid transparent',
      marginBottom: -2,
    }}>{children}</button>
  );
}

function ConfigCard({ title, image, subtitle, footnote, children }) {
  return (
    <div className="info-card" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="card-header-bar">
        <span className="card-header-bar-title">{title}</span>
      </div>
      {image && (
        <img
          src={image}
          alt=""
          style={{
            display: 'block',
            width: 'calc(100% + 56px)',
            height: 'auto',
            margin: '-20px -28px 16px',
          }}
        />
      )}
      {subtitle && <p style={{ margin: '0 0 14px', color: '#666', fontSize: '0.85rem', lineHeight: 1.4 }}>{subtitle}</p>}
      <div style={{ flex: 1 }}>{children}</div>
      {footnote && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #F0F0F0', fontSize: '0.75rem', color: '#888' }}>
          {footnote}
        </div>
      )}
    </div>
  );
}

function OptionStack({ children }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>;
}

function OptionCard({ selected, label, cost, costSuffix, detail, disabled, onClick }) {
  const costLabel = cost > 0
    ? `${fmtMoney(cost)}${costSuffix ? ` ${costSuffix}` : ' / week'}`
    : 'Free';
  return (
    <button onClick={onClick} disabled={disabled || selected} style={{
      textAlign: 'left', padding: '12px 14px',
      background: selected ? '#2C2C2C' : '#fff',
      color: selected ? '#fff' : '#2C2C2C',
      border: selected ? '2px solid #2C2C2C' : '2px solid #E0E0E0',
      borderRadius: 6, cursor: selected ? 'default' : 'pointer',
      opacity: disabled && !selected ? 0.5 : 1,
      transition: 'all 0.15s',
    }}>
      <div style={{ fontSize: '0.9rem', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: '0.74rem', marginTop: 4, opacity: 0.85 }}>{costLabel}</div>
      <div style={{ fontSize: '0.72rem', marginTop: 6, opacity: 0.75, lineHeight: 1.3 }}>{detail}</div>
    </button>
  );
}

function EmptyState({ children }) {
  return (
    <div style={{ background: '#F5F5F5', padding: 24, borderRadius: 6, textAlign: 'center', color: '#666', fontSize: '0.9rem' }}>
      {children}
    </div>
  );
}

function ReportView({ report, onNavigateToAircraft, onNavigateToAirport }) {
  const f = report.flights || {};
  const t = report.totals || {};
  const stability = f.stability;
  const stabPct = stability != null ? (stability * 100).toFixed(1) + '%' : '—';

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px', marginBottom: '20px' }}>
        <div className="info-card" style={{ marginBottom: 0 }}>
          <div className="card-header-bar">
            <span className="card-header-bar-title">Summary — Last 7 Days</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              <ReportRow label="Flights Finalized"   value={(f.finalized || 0).toLocaleString()} />
              <ReportRow label="Stability"           value={stabPct} bold />
              <ReportRow label="Delayed (completed)" value={(f.delayed_completed || 0).toLocaleString()} />
              <ReportRow label="Cancelled"           value={(f.cancelled || 0).toLocaleString()} />
            </tbody>
          </table>
        </div>

        <div className="info-card" style={{ marginBottom: 0 }}>
          <div className="card-header-bar">
            <span className="card-header-bar-title">Cost & Impact</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              <ReportRow label="Disruption Cost"          value={fmtMoney(t.disruption_cost)} />
              <ReportRow label="Total Satisfaction Malus" value={`-${t.satisfaction_malus || 0}`} bold />
            </tbody>
          </table>
        </div>
      </div>

      <div className="info-card">
        <div className="card-header-bar">
          <span className="card-header-bar-title">Events Breakdown</span>
        </div>
        {(report.events || []).length === 0 ? (
          <EmptyState>No disruption events in the last 7 days.</EmptyState>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={tblStyle}>
              <thead>
                <tr>
                  <th style={th}>When</th>
                  <th style={th}>Flight</th>
                  <th style={th}>Aircraft</th>
                  <th style={th}>Route</th>
                  <th style={th}>Event</th>
                  <th style={th}>Outcome</th>
                  <th style={{ ...th, textAlign: 'right' }}>Delay</th>
                  <th style={{ ...th, textAlign: 'right' }}>Cost</th>
                  <th style={{ ...th, textAlign: 'right' }}>Sat</th>
                </tr>
              </thead>
              <tbody>
                {report.events.map((e) => (
                  <tr key={e.id} style={trStyle}>
                    <td style={{ ...td, fontSize: '0.78rem', color: '#888' }}>{formatTime(e.created_at)}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontWeight: 600 }}>{e.flight_number || '—'}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: '0.82rem' }}>
                      {e.aircraft_reg && e.aircraft_id && onNavigateToAircraft
                        ? <button onClick={() => onNavigateToAircraft(e.aircraft_id)} style={linkBtn}>{e.aircraft_reg}</button>
                        : <span style={{ color: '#666' }}>{e.aircraft_reg || '—'}</span>}
                    </td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: '0.82rem' }}>
                      {e.dep_airport && e.arr_airport ? (
                        <span>
                          {onNavigateToAirport
                            ? <button onClick={() => onNavigateToAirport(e.dep_airport)} style={linkBtn}>{e.dep_airport}</button>
                            : <span style={{ color: '#666' }}>{e.dep_airport}</span>}
                          <span style={{ color: '#999' }}> → </span>
                          {onNavigateToAirport
                            ? <button onClick={() => onNavigateToAirport(e.arr_airport)} style={linkBtn}>{e.arr_airport}</button>
                            : <span style={{ color: '#666' }}>{e.arr_airport}</span>}
                        </span>
                      ) : <span style={{ color: '#666' }}>—</span>}
                    </td>
                    <td style={td}>{EVENT_LABEL[e.event_type] || e.event_type}</td>
                    <td style={td}>
                      <span style={{ color: outcomeColor(e), fontWeight: 600 }}>{formatOutcome(e)}</span>
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>{e.delay_minutes ? `+${e.delay_minutes}m` : '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{e.cost ? fmtMoney(e.cost) : '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{e.satisfaction_malus ? `-${e.satisfaction_malus}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

const linkBtn = {
  background: 'transparent', border: 'none', padding: 0, font: 'inherit',
  color: '#2C2C2C', cursor: 'pointer', textDecoration: 'underline',
  textDecorationColor: 'rgba(0,0,0,0.25)', textUnderlineOffset: '2px',
};

// ── Event helpers ──────────────────────────────────────────────────────────
function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: 'short' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
}

function formatOutcome(e) {
  if (e.event_type === 'technical_air' && e.outcome === 'delayed') {
    return `Diverted (turnback) +${Math.round((e.delay_minutes || 0) / 60 * 10) / 10}h`;
  }
  if (e.event_type === 'medical' && e.outcome === 'diverted') {
    return e.diversion_airport
      ? `Diverted via ${e.diversion_airport}`
      : 'Medical diversion';
  }
  if (e.outcome === 'wet_leased') return 'Wet-Leased (legacy)';
  if (e.outcome === 'cancelled')  return 'Cancelled';
  if (e.outcome === 'minor_delay') return `Delayed +${e.delay_minutes || 0}m`;
  return OUTCOME_LABEL[e.outcome] || e.outcome;
}

function outcomeColor(e) {
  if (e.event_type === 'technical_air' && e.outcome === 'delayed') return '#f97316';
  if (e.event_type === 'medical' && e.outcome === 'diverted')      return '#f97316';
  if (e.outcome === 'wet_leased') return '#2563eb';
  if (e.outcome === 'cancelled')  return '#dc2626';
  if (e.outcome === 'minor_delay') return '#eab308';
  return '#666';
}

function ReportRow({ label, value, bold }) {
  return (
    <tr>
      <td style={{ padding: '0.45rem 0', fontSize: '0.85rem', color: bold ? '#2C2C2C' : '#555', fontWeight: bold ? 700 : 400, borderTop: bold ? '1px solid #E8E8E8' : 'none' }}>{label}</td>
      <td style={{ padding: '0.45rem 0', textAlign: 'right', fontSize: '0.88rem', fontWeight: bold ? 700 : 500, color: bold ? '#2C2C2C' : '#444', borderTop: bold ? '1px solid #E8E8E8' : 'none' }}>{value}</td>
    </tr>
  );
}

const tblStyle = { width: '100%', borderCollapse: 'collapse' };
const th = { padding: '8px 10px', textAlign: 'left', fontSize: '0.72rem', fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid #E0E0E0' };
const td = { padding: '12px 10px', fontSize: '0.88rem', color: '#2C2C2C', verticalAlign: 'middle' };
const trStyle = { borderTop: '1px solid #F0F0F0' };
