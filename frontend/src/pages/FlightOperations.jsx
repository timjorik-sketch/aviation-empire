import { useState, useEffect, useCallback } from 'react';
import TopBar from '../components/TopBar.jsx';
import LiveFlightMap from '../components/LiveFlightMap.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';



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

/** Returns up to 3 feedback entries { msg, cabins } from the violated rules list, seeded by flightId. */
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

  return (
    <div className="fo-card">
      <div className="fo-card-hd">
        <span className="fo-card-reg">{flight.flight_number}</span>
        <span className="fo-card-type">{flight.aircraft_type}</span>
      </div>
      <div className="fo-fp-wrap">
        <div className="fo-fp-route">
          <div className="fo-fp-apt">
            <button className="fo-apt-link fo-fp-code" onClick={() => onNavigateToAirport?.(flight.departure_airport)}>
              {flight.departure_airport}
            </button>
            {flight.departure_name && <span className="fo-fp-apt-name">{flight.departure_name}</span>}
          </div>
          <div className="fo-fp-apt fo-fp-apt-r">
            <button className="fo-apt-link fo-fp-code" onClick={() => onNavigateToAirport?.(flight.arrival_airport)}>
              {flight.arrival_airport}
            </button>
            {flight.arrival_name && <span className="fo-fp-apt-name">{flight.arrival_name}</span>}
          </div>
        </div>
        <div className="fo-fp-bar">
          <div className="fo-fp-line" />
          <span className="fo-fp-plane" style={{ left: `calc(${pct}% - 9px)` }}>✈</span>
        </div>
        <div className="fo-fp-meta">
          <button className="fo-fp-reg" onClick={() => onNavigateToAircraft?.(flight.aircraft_id)}>
            {flight.aircraft_registration}
          </button>
          <span className="fo-fp-time">{timeStr}</span>
        </div>
      </div>
    </div>
  );
}

function FlightOperations({ airline, onBalanceUpdate, onBack, onNavigateToAirport, onNavigateToAircraft, onNavigate }) {
  const [flights, setFlights] = useState([]);
  const [loading, setLoading] = useState(true);
  const [clientFeedback, setClientFeedback] = useState([]);

  useEffect(() => {
    fetchFlights();
    fetchClientFeedback();
    const interval = setInterval(fetchFlights, 10000);
    const fbInterval = setInterval(fetchClientFeedback, 60000);
    return () => { clearInterval(interval); clearInterval(fbInterval); };
  }, []);

  const fetchFlights = async () => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/flights`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setFlights(data.flights || []);

      const airlineRes = await fetch(`${API_URL}/api/airline`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const airlineData = await airlineRes.json();
      if (airlineData.airline && airlineData.airline.balance !== airline.balance) {
        onBalanceUpdate(airlineData.airline.balance);
      }
    } catch (err) {
      console.error('Failed to refresh flights:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchClientFeedback = async () => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/flights/client-feedback`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setClientFeedback(data.items || []);
    } catch (err) { /* silent */ }
  };

  const activeFlights = flights.filter(f => f.status === 'in-flight');

  return (
    <div className="app">
      <div className="page-hero" style={{ backgroundImage: "url('/header-images/Headerimage_opertaions.png')" }}>
        <div className="page-hero-overlay">
          <h1>Flight Operations</h1>
          <p>{airline.name}</p>
        </div>
      </div>

      <div className="container" style={{ paddingTop: '24px' }}>
        <TopBar onBack={onBack} balance={airline.balance} airline={airline} />

        {/* Live Map */}
        <div className="info-card" style={{ padding: 0, overflow: 'hidden', marginBottom: '1rem' }}>
          <div className="card-header-bar" style={{ margin: 0, borderRadius: '8px 8px 0 0' }}>
            <span className="card-header-bar-title">Live Map</span>
          </div>
          <LiveFlightMap />
        </div>

        <div className="fo-layout">
          {/* Active Flights — 70% */}
          <div className="info-card fo-main">
            <div className="card-header-bar">
              <span className="card-header-bar-title">Active Flights ({activeFlights.length})</span>
            </div>
            {loading ? (
              <div className="fo-empty">Loading…</div>
            ) : activeFlights.length === 0 ? (
              <div className="fo-empty">No flights currently in the air.</div>
            ) : (
              <div className="fo-grid">
                {activeFlights.map(f => (
                  <FlightCard key={f.id} flight={f} onNavigateToAirport={onNavigateToAirport} onNavigateToAircraft={onNavigateToAircraft} />
                ))}
              </div>
            )}
          </div>

          {/* Right column */}
          <div className="fo-sidebar-col">
            {/* Manage Operations */}
            <div className="info-card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ background: '#2C2C2C', padding: '14px 20px', borderRadius: '8px 8px 0 0' }}>
                <span className="card-header-bar-title" style={{ color: '#fff' }}>Manage Operations</span>
              </div>
              <div className="fo-nav-list">
                {[
                  { label: 'Route Planning',      page: 'routes'            },
                  { label: 'Service Profiles',    page: 'service-profiles'  },
                  { label: 'Network',             page: 'hubs'              },
                  { label: 'Airport Overview',    page: 'airport-overview'  },
                ].map(({ label, page }) => (
                  <button key={page} className="fo-nav-btn" onClick={() => onNavigate?.(page)}>
                    {label}
                    <span className="fo-nav-arrow">›</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Client Feedback */}
            <div className="info-card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ background: '#2C2C2C', padding: '14px 20px', borderRadius: '8px 8px 0 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span className="card-header-bar-title" style={{ color: '#fff' }}>Client Feedback</span>
                {clientFeedback.length > 0 && (
                  <span style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.5)' }}>Last 24 h</span>
                )}
              </div>
              {clientFeedback.length === 0 ? (
                <div className="fo-empty">No feedback in the last 24 hours.</div>
              ) : (
                <div className="fo-fb-list">
                  {clientFeedback.map(fb => {
                    const entries = getFeedbackMessages(fb.violated_rules, fb.id);
                    return (
                      <button
                        key={fb.id}
                        className="fo-fb-item"
                        onClick={() => onNavigateToAircraft?.(fb.aircraft_id)}
                      >
                        <div className="fo-fb-hd">
                          <span className="fo-fb-fn">{fb.flight_number}</span>
                          <span className="fo-fb-route">{fb.departure_airport} → {fb.arrival_airport}</span>
                          <span className="fo-fb-reg">{fb.registration}</span>
                        </div>
                        {entries.map(({ msg, cabins }, i) => (
                          <div key={i} className="fo-fb-msg-row">
                            {cabins.length > 0 && (
                              <span className="fo-fb-badges">
                                {cabins.map(c => (
                                  <span key={c} className={`fo-fb-badge fo-fb-badge--${c}`}>{CABIN_SHORT[c] ?? c}</span>
                                ))}
                              </span>
                            )}
                            <span className="fo-fb-msg">"{msg}"</span>
                          </div>
                        ))}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .fo-layout { display: flex; gap: 1rem; align-items: flex-start; }
        .fo-main { flex: 7; min-width: 0; }
        .fo-sidebar-col { flex: 3; display: flex; flex-direction: column; gap: 1rem; }
        .fo-nav-list { display: flex; flex-direction: column; padding: 0.5rem 0; }
        .fo-nav-btn { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 1.1rem; background: none; border: none; border-bottom: 1px solid #F2F2F2; cursor: pointer; font-size: 0.88rem; color: #2C2C2C; font-weight: 500; text-align: left; transition: background 0.15s; width: 100%; }
        .fo-nav-btn:hover { background: #F5F5F5; }
        .fo-nav-btn:last-child { border-bottom: none; }
        .fo-nav-arrow { color: #AAAAAA; font-size: 1.1rem; }

        .fo-empty { color: #999; font-size: 0.88rem; font-style: italic; padding: 1.5rem 1.1rem; }
        .fo-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 0.85rem;
          padding: 1rem 1.1rem;
        }

        /* Card */
        .fo-card { background: white; border-radius: 8px; border: 1px solid #EEEEEE; overflow: hidden; }
        .fo-card-hd {
          background: #F5F5F5; padding: 0.55rem 1rem;
          display: flex; align-items: baseline; gap: 0.6rem;
          border-bottom: 1px solid #EEEEEE;
        }
        .fo-card-reg { font-family: monospace; font-size: 1rem; font-weight: 900; color: #2C2C2C; letter-spacing: 0.04em; }
        .fo-card-type { font-size: 0.68rem; color: #888; font-weight: 500; }

        /* Flight progress */
        .fo-fp-wrap { padding: 12px 16px 14px; }
        .fo-fp-route { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 10px; }
        .fo-fp-apt { display: flex; flex-direction: column; gap: 5px; align-items: flex-start; }
        .fo-fp-apt-r { align-items: flex-end; text-align: right; }
        .fo-fp-code {
          font-family: monospace; font-size: 1.25rem; font-weight: 900; color: #2C2C2C;
          line-height: 1; background: none; border: none; padding: 0; cursor: pointer;
          text-decoration: underline; text-decoration-color: rgba(0,0,0,0.25); text-underline-offset: 2px;
        }
        .fo-fp-code:hover { color: #555; }
        .fo-fp-apt-name { font-size: 10px; color: #999; line-height: 1.2; max-width: 100px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .fo-fp-bar { position: relative; height: 24px; display: flex; align-items: center; margin-bottom: 8px; }
        .fo-fp-line { position: absolute; left: 0; right: 0; height: 2px; background: #E0E0E0; }
        .fo-fp-line::before, .fo-fp-line::after {
          content: ''; position: absolute; top: 50%; transform: translateY(-50%);
          width: 5px; height: 5px; border-radius: 50%; background: #2C2C2C;
        }
        .fo-fp-line::before { left: 0; }
        .fo-fp-line::after  { right: 0; }
        .fo-fp-plane { position: absolute; font-size: 16px; line-height: 1; top: 50%; transform: translateY(-50%); z-index: 1; }
        .fo-fp-meta { display: flex; align-items: center; gap: 8px; }
        .fo-fp-reg {
          font-family: monospace; font-size: 0.75rem; font-weight: 700; color: #2C2C2C;
          background: none; border: none; padding: 0; cursor: pointer;
          text-decoration: underline; text-decoration-color: rgba(0,0,0,0.25); text-underline-offset: 2px;
        }
        .fo-fp-reg:hover { color: #555; }
        .fo-fp-time { font-size: 0.75rem; color: #888; margin-left: auto; }
        .fo-apt-link {
          background: none; border: none; padding: 0; cursor: pointer; color: #2C2C2C; font-weight: 600;
          text-decoration: underline; text-decoration-color: rgba(0,0,0,0.25);
          text-underline-offset: 2px; font-family: inherit;
        }
        .fo-apt-link:hover { color: #555; }

        /* Client Feedback */
        .fo-fb-list { display: flex; flex-direction: column; }
        .fo-fb-item {
          width: 100%; background: none; border: none; border-bottom: 1px solid #F2F2F2;
          padding: 10px 16px; cursor: pointer; text-align: left;
          transition: background 0.15s;
        }
        .fo-fb-item:last-child { border-bottom: none; }
        .fo-fb-item:hover { background: #FEF2F2; }
        .fo-fb-hd { display: flex; align-items: baseline; gap: 6px; margin-bottom: 4px; }
        .fo-fb-fn { font-family: monospace; font-size: 0.78rem; font-weight: 800; color: #2C2C2C; }
        .fo-fb-route { font-size: 0.72rem; color: #888; flex: 1; }
        .fo-fb-reg { font-family: monospace; font-size: 0.68rem; color: #BBB; }
        .fo-fb-msg-row {
          display: flex; align-items: baseline; gap: 5px; margin-top: 2px;
        }
        .fo-fb-badges { display: flex; gap: 3px; flex-shrink: 0; align-items: center; }
        .fo-fb-badge {
          display: inline-block; font-size: 0.6rem; font-weight: 800;
          padding: 1px 4px; border-radius: 3px; letter-spacing: 0.04em;
          font-family: monospace; line-height: 1.5;
        }
        .fo-fb-badge--economy         { background: #E8F4FD; color: #1565C0; border: 1px solid #BBDEFB; }
        .fo-fb-badge--business        { background: #1C3A6B; color: #E3F2FD; border: 1px solid #1565C0; }
        .fo-fb-badge--first           { background: #FFF8E1; color: #7B5E00; border: 1px solid #FFE082; }
        .fo-fb-badge--premium_economy { background: #EDE7F6; color: #4527A0; border: 1px solid #D1C4E9; }
        .fo-fb-msg {
          font-size: 0.75rem; color: #7F1D1D; font-style: italic; line-height: 1.4;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }

        @media (max-width: 480px) {
          .fo-layout { flex-direction: column; }
          .fo-main { flex: none; width: 100%; }
          .fo-sidebar-col { flex: none; width: 100%; }
          .fo-grid { grid-template-columns: 1fr; padding: 0.75rem; gap: 0.65rem; }
          .fo-fp-route { gap: 4px; }
          .fo-fp-code { font-size: 1.1rem; }
          .fo-fp-apt-name { max-width: 80px; font-size: 9px; }
          .fo-fb-msg { white-space: normal; }
          .fo-fb-hd { flex-wrap: wrap; }
        }
      `}</style>

    </div>
  );
}

export default FlightOperations;
