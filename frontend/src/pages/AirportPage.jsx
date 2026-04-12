import { useState, useEffect, useCallback } from 'react';
import AirportMap from '../components/AirportMap.jsx';
import AirportLink from '../components/AirportLink.jsx';
import AirlineProfilePopup from '../components/AirlineProfilePopup.jsx';
import TopBar from '../components/TopBar.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

const GROUND_STAFF_BY_CAT = { 1: 2, 2: 4, 3: 7, 4: 10, 5: 14, 6: 18, 7: 22, 8: 25 };

const CATEGORY_LABELS = {
  1: 'Airstrip',
  2: 'Local',
  3: 'Regional',
  4: 'National',
  5: 'International',
  6: 'Continental',
  7: 'Major Hub',
  8: 'Mega Hub',
};

const WAKE_LABELS = { L: 'Light', M: 'Medium', H: 'Heavy' };

function formatFee(amount) {
  if (amount == null) return '—';
  return '$' + Math.round(amount).toLocaleString();
}

function formatRunway(m) {
  if (m == null) return '—';
  return m.toLocaleString() + ' m';
}

function formatBoardTime(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Berlin' });
}

function formatDayHeader(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'Europe/Berlin' });
}

function flightDate(isoStr) {
  return new Date(isoStr).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
}

// Time-based departure status
function getDepartureStatus(flight, now) {
  const dep = new Date(flight.departure_time).getTime();
  const diffMin = (dep - now) / 60000;
  if (diffMin > 60)  return { label: 'Scheduled', cls: 'ap-st-scheduled' };
  if (diffMin > 30)  return { label: 'On Time',   cls: 'ap-st-ontime-b' };
  if (diffMin > 3)   return { label: 'Boarding',  cls: 'ap-st-boarding' };
  if (diffMin >= 0)  return { label: 'Taxiing',   cls: 'ap-st-boarding' };
  if (diffMin >= -1) return { label: 'Departed',  cls: 'ap-st-ontime' };
  return null; // expired — filter out
}

// Time-based arrival status
function getArrivalStatus(flight, now) {
  const dep = flight.departure_time ? new Date(flight.departure_time).getTime() : null;
  const arr = new Date(flight.arrival_time).getTime();
  const diffToArr = (arr - now) / 60000;
  if (dep && now < dep)  return { label: 'Scheduled', cls: 'ap-st-scheduled' };
  if (diffToArr > 5)     return { label: 'In Flight', cls: 'ap-st-scheduled' };
  if (diffToArr >= 0)    return { label: 'Approach',  cls: 'ap-st-boarding' };
  if (diffToArr >= -1)   return { label: 'Landed',    cls: 'ap-st-ontime' };
  return null; // expired — filter out
}

function StatusDots({ cls, label }) {
  const isBlinking = cls === 'ap-st-boarding' || cls === 'ap-st-ontime-b';
  const isYellow   = cls === 'ap-st-ontime';
  const dotColor   = isYellow ? '#facc15' : isBlinking ? '#facc15' : 'rgba(255,255,255,0.25)';
  const textColor  = isYellow ? '#facc15' : isBlinking ? '#facc15' : 'rgba(255,255,255,0.45)';
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
      {label && (
        <span style={{ fontSize: '0.78rem', color: textColor, fontWeight: 500, whiteSpace: 'nowrap' }}>
          {label}
        </span>
      )}
      <span className={isBlinking ? 'ap-dot-blink-a' : undefined}
        style={{ width: 7, height: 7, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
          background: dotColor }} />
      <span className={isBlinking ? 'ap-dot-blink-b' : undefined}
        style={{ width: 7, height: 7, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
          background: dotColor }} />
    </span>
  );
}

function AirlineChip({ code, logoFilename, dark = true, onClick }) {
  const style = onClick ? { cursor: 'pointer' } : {};
  if (logoFilename) {
    return (
      <img
        src={logoFilename.startsWith('http') ? logoFilename : `${API_URL}/airline-logos/${logoFilename}`}
        alt={code}
        title={code}
        style={{ width: 120, height: 30, objectFit: 'contain', display: 'block', ...style }}
        onClick={onClick}
      />
    );
  }
  return <span className={`ap-chip ${dark ? 'ap-chip-dark' : 'ap-chip-board'}`} style={style} onClick={onClick}>{code}</span>;
}

function BoardTable({ type, flights, now, onNavigateToAirport, onAirlineClick }) {
  const isArr = type === 'arrivals';

  // Filter and compute statuses
  const rows = flights.map(f => {
    const st = isArr ? getArrivalStatus(f, now) : getDepartureStatus(f, now);
    return st ? { ...f, _st: st } : null;
  }).filter(Boolean).slice(0, 30);

  if (rows.length === 0) {
    return <div className="ap-board-empty">No scheduled {type} in the next 3 days</div>;
  }

  // Group by day for separators
  const items = [];
  let lastDate = null;
  for (const f of rows) {
    const timeKey = isArr ? f.arrival_time : f.departure_time;
    const dateStr = flightDate(timeKey);
    if (dateStr !== lastDate) {
      items.push({ type: 'sep', label: formatDayHeader(timeKey), key: `sep-${dateStr}` });
      lastDate = dateStr;
    }
    items.push({ type: 'row', flight: f, key: f.id });
  }

  return (
    <table className="ap-board-table">
      <thead>
        <tr>
          <th>Airline</th>
          <th>Time</th>
          <th>Destination</th>
          <th>Flight</th>
          <th className="ap-th-status">Status</th>
        </tr>
      </thead>
      <tbody>
        {items.map(item => {
          if (item.type === 'sep') {
            return (
              <tr key={item.key} className="ap-day-sep-row">
                <td colSpan={5} className="ap-day-sep-cell">{item.label}</td>
              </tr>
            );
          }
          const f = item.flight;
          const time = isArr ? f.arrival_time : f.departure_time;
          const airportCode = isArr ? f.origin : f.destination;
          const airportName = isArr ? f.origin_name : f.destination_name;
          return (
            <tr key={f.id}>
              <td><AirlineChip code={f.airline_code} logoFilename={f.logo_filename} dark={false} onClick={onAirlineClick ? () => onAirlineClick(f.airline_code) : undefined} /></td>
              <td className="ap-time">{formatBoardTime(time)}</td>
              <td className="ap-apt-col">
                <AirportLink code={airportCode} name={airportName || undefined} onNavigate={onNavigateToAirport} />
              </td>
              <td className="ap-fn">{f.flight_number}</td>
              <td className="ap-td-status"><StatusDots cls={f._st.cls} label={f._st.label} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const DEST_TYPE_LABELS = {
  home_base:   'Home Base',
  hub:         'Hub',
  base:        'Base',
  destination: 'Destination',
};

function DestinationStatusCard({ destStatus, airportCode }) {
  if (!destStatus.is_opened) return null;

  const label = DEST_TYPE_LABELS[destStatus.effective_type] || 'Destination';

  return (
    <div className="ap-al-info-body">
      <table className="ap-al-info-table">
        <tbody>
          <tr className="ap-al-info-divider">
            <td colSpan={2} className="ap-al-info-section">Status</td>
          </tr>
          <tr>
            <td className="ap-al-info-label">Category</td>
            <td className="ap-al-info-val">
              <span className="ap-cat-badge">{label}</span>
            </td>
          </tr>
          <tr>
            <td className="ap-al-info-label">Weekly Flights</td>
            <td className="ap-al-info-val">{destStatus.weekly_flights ?? 0}</td>
          </tr>
          <tr className="ap-al-info-divider">
            <td colSpan={2} className="ap-al-info-section">Operations</td>
          </tr>
          <tr>
            <td className="ap-al-info-label">Aircraft Based</td>
            <td className="ap-al-info-val">{destStatus.aircraft_based ?? 0}</td>
          </tr>
          <tr>
            <td className="ap-al-info-label">Ground Staff</td>
            <td className="ap-al-info-val">{destStatus.ground_staff ?? 0}</td>
          </tr>
          <tr>
            <td className="ap-al-info-label">Flights Handled</td>
            <td className="ap-al-info-val">{(destStatus.completed_flights ?? 0).toLocaleString()}</td>
          </tr>
        </tbody>
      </table>

    </div>
  );
}

export default function AirportPage({ code, onBack, onNavigateToAirport, airline, onBalanceUpdate }) {
  const [airport, setAirport] = useState(null);
  const [departures, setDepartures] = useState([]);
  const [arrivals, setArrivals] = useState([]);
  const [airlines, setAirlines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [now, setNow] = useState(() => Date.now());

  const [profilePopupCode, setProfilePopupCode] = useState(null);
  const [showCapableModal, setShowCapableModal] = useState(false);
  const [capableAircraft, setCapableAircraft] = useState([]);
  const [capableLoading, setCapableLoading] = useState(false);

  const [destStatus, setDestStatus] = useState(null); // { is_opened, destination_type, effective_type, weekly_flights }
  const [addingDest, setAddingDest] = useState(false);

  const fetchBoards = useCallback(() => {
    Promise.all([
      fetch(`${API_URL}/api/airports/${code}/departures`).then(r => r.json()),
      fetch(`${API_URL}/api/airports/${code}/arrivals`).then(r => r.json()),
      fetch(`${API_URL}/api/airports/${code}/airlines`).then(r => r.json()),
    ]).then(([depData, arrData, airlinesData]) => {
      setDepartures(depData.flights || []);
      setArrivals(arrData.flights || []);
      setAirlines(airlinesData.airlines || []);
    }).catch(() => {});
  }, [code]);

  const openCapableModal = useCallback(() => {
    setShowCapableModal(true);
    if (capableAircraft.length > 0) return; // already loaded
    setCapableLoading(true);
    fetch(`${API_URL}/api/airports/${code}/capable-aircraft`)
      .then(r => r.json())
      .then(d => setCapableAircraft(d.aircraft || []))
      .catch(() => {})
      .finally(() => setCapableLoading(false));
  }, [code, capableAircraft.length]);

  useEffect(() => {
    setLoading(true);
    setError('');
    fetch(`${API_URL}/api/airports/${code}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) { setError(data.error); setLoading(false); return; }
        setAirport(data.airport);
        setLoading(false);
        fetchBoards();
        if (airline) {
          const token = localStorage.getItem('token');
          fetch(`${API_URL}/api/airports/${code}/airline-status`, {
            headers: { 'Authorization': `Bearer ${token}` }
          }).then(r => r.json()).then(setDestStatus).catch(() => {});
        }
      })
      .catch(() => { setError('Failed to load airport'); setLoading(false); });
  }, [code]);

  const handleAddDestination = useCallback(async () => {
    if (!airline || addingDest) return;
    setAddingDest(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/destinations/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ airport_code: code, destination_type: 'destination' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      if (onBalanceUpdate && json.new_balance != null) onBalanceUpdate(json.new_balance);
      // Refresh destination status
      const statusRes = await fetch(`${API_URL}/api/airports/${code}/airline-status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const statusJson = await statusRes.json();
      setDestStatus(statusJson);
    } catch (err) {
      setError(err.message);
    } finally {
      setAddingDest(false);
    }
  }, [airline, code, addingDest, onBalanceUpdate]);

  // Auto-refresh boards every 30 seconds
  useEffect(() => {
    const interval = setInterval(fetchBoards, 30000);
    return () => clearInterval(interval);
  }, [fetchBoards]);

  // Update "now" every 15 seconds so statuses stay current
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="ap-page">

      {/* ── Hero image banner ── */}
      <div className="ap-hero" />

      {/* ── Page container ── */}
      <div className="ap-container">

        <TopBar onBack={onBack} backLabel="Back" balance={airline?.balance} airline={airline} />

        {loading && (
          <div className="ap-center-msg">Loading airport data…</div>
        )}

        {!loading && (error || !airport) && (
          <div className="ap-center-msg" style={{ color: '#dc2626' }}>
            {error || 'Airport not found'}
          </div>
        )}

        {!loading && airport && (<>

          {/* ── Info strip: identity left + fees right ── */}
          <div className="ap-info-strip">

            {/* Left: airport identity */}
            <div className="ap-identity">
              <span className="ap-iata">{airport.iata_code}</span>
              <div className="ap-id-text">
                <div className="ap-airport-name">{airport.name}</div>
                <div className="ap-airport-country">{airport.country}</div>
              </div>
            </div>

            {/* Right: actions */}
            <div className="ap-strip-right">
              <div className="ap-strip-actions">
                {airline && destStatus && !destStatus.is_opened && (
                  <button
                    className="ap-btn-add-dest"
                    onClick={handleAddDestination}
                    disabled={addingDest}
                  >
                    {addingDest ? 'Opening…' : '+ Add as Destination'}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ── Map + Airport Information row ── */}
          <div className="ap-map-row">

            {/* Map */}
            {airport.latitude != null && airport.longitude != null && (
              <div className="ap-map-col">
                <AirportMap
                  lat={airport.latitude}
                  lng={airport.longitude}
                  airportName={airport.name}
                  iataCode={airport.iata_code}
                />
              </div>
            )}

            {/* Airport Information card */}
            <div className="ap-sidebar-card ap-info-col">
              <div className="ap-sidebar-title">Airport Information</div>
              <table className="ap-info-table">
                <tbody>
                  <tr>
                    <td className="ap-it-label">Category</td>
                    <td className="ap-it-val">
                      {airport.category
                        ? <span className="ap-cat-badge">Cat {airport.category} – {CATEGORY_LABELS[airport.category]}</span>
                        : '—'}
                    </td>
                  </tr>
                  <tr>
                    <td className="ap-it-label">Continent</td>
                    <td className="ap-it-val">{airport.continent || '—'}</td>
                  </tr>
                  <tr>
                    <td className="ap-it-label">Country</td>
                    <td className="ap-it-val">{airport.country || '—'}</td>
                  </tr>
                  <tr>
                    <td className="ap-it-label">Runway</td>
                    <td className="ap-it-val ap-it-runway">
                      <span>{formatRunway(airport.runway_length_m)}</span>
                      <button className="ap-capable-link" onClick={openCapableModal}>
                        Compatible Aircraft ↗
                      </button>
                    </td>
                  </tr>
                  <tr className="ap-it-section-row">
                    <td colSpan={3} className="ap-it-section-label">Personnel</td>
                  </tr>
                  <tr>
                    <td className="ap-it-label">Ground Staff</td>
                    <td className="ap-it-val">
                      {airport.category
                        ? <>{GROUND_STAFF_BY_CAT[airport.category] ?? '—'} <span style={{ color: '#999', fontSize: '0.78rem' }}>employees</span></>
                        : '—'}
                    </td>
                  </tr>
                  <tr className="ap-it-section-row">
                    <td className="ap-it-section-label">Fees</td>
                    <td className="ap-it-section-col-hd">Landing</td>
                    <td className="ap-it-section-col-hd">Ground</td>
                  </tr>
                  <tr>
                    <td className="ap-it-label">Light</td>
                    <td className="ap-it-fee">{formatFee(airport.landing_fee_light)}</td>
                    <td className="ap-it-fee">{formatFee(airport.ground_handling_fee_light ?? airport.ground_handling_fee)}</td>
                  </tr>
                  <tr>
                    <td className="ap-it-label">Medium</td>
                    <td className="ap-it-fee">{formatFee(airport.landing_fee_medium)}</td>
                    <td className="ap-it-fee">{formatFee(airport.ground_handling_fee_medium ?? airport.ground_handling_fee)}</td>
                  </tr>
                  <tr className="ap-it-last">
                    <td className="ap-it-label">Heavy</td>
                    <td className="ap-it-fee">{formatFee(airport.landing_fee_heavy)}</td>
                    <td className="ap-it-fee">{formatFee(airport.ground_handling_fee_heavy ?? airport.ground_handling_fee)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

          </div>

          {/* ── Main content: boards (left) + airlines sidebar (right) ── */}
          <div className="ap-main">

            {/* Boards column */}
            <div className="ap-boards-col">

              {/* Departures */}
              <div className="ap-board-wrap">
                <div className="ap-board-titlebar dep">
                  <img src="/icon/icon_departures.png" alt="" style={{ width: 18, height: 18, objectFit: 'contain', flexShrink: 0 }} />
                  <span className="ap-board-title">DEPARTURES</span>
                  <span className="ap-board-ct">{departures.length} shown</span>
                </div>
                <BoardTable type="departures" flights={departures} now={now} onNavigateToAirport={onNavigateToAirport} onAirlineClick={setProfilePopupCode} />
              </div>

              {/* Arrivals */}
              <div className="ap-board-wrap" style={{ marginTop: '1.25rem' }}>
                <div className="ap-board-titlebar arr">
                  <img src="/icon/icon_landing.png" alt="" style={{ width: 18, height: 18, objectFit: 'contain', flexShrink: 0 }} />
                  <span className="ap-board-title">ARRIVALS</span>
                  <span className="ap-board-ct">{arrivals.length} shown</span>
                </div>
                <BoardTable type="arrivals" flights={arrivals} now={now} onNavigateToAirport={onNavigateToAirport} onAirlineClick={setProfilePopupCode} />
              </div>

            </div>

            {/* Sidebar */}
            <div className="ap-sidebar-col">

              {/* Airlines Operating card */}
              <div className="ap-sidebar-card">
                <div className="ap-sidebar-title">Airlines Operating</div>
                {airlines.length === 0 ? (
                  <div className="ap-sidebar-empty">No airlines scheduled here yet</div>
                ) : (
                  <table className="ap-al-table">
                    <tbody>
                      {airlines.map((al, i) => (
                        <tr key={i} className={i === airlines.length - 1 ? 'ap-al-last' : ''}>
                          <td className="ap-al-name">
                            <button className="ap-al-name-link" onClick={() => setProfilePopupCode(al.airline_code)}>{al.name}</button>
                          </td>
                          <td className="ap-al-ct">{al.weekly_departures} dep/wk</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Your Airline */}
              {airline && destStatus && destStatus.is_opened && (
                <div className="ap-sidebar-card" style={{ marginTop: '1rem' }}>
                  <div className="ap-sidebar-title">Your Airline</div>
                  <DestinationStatusCard
                    destStatus={destStatus}
                    airportCode={code}
                  />
                </div>
              )}
            </div>

          </div>
        </>)}
      </div>

      {/* ── Compatible Aircraft Modal ── */}
      {showCapableModal && (
        <div className="ap-modal-backdrop" onClick={() => setShowCapableModal(false)}>
          <div className="ap-modal" onClick={e => e.stopPropagation()}>
            <div className="ap-modal-header">
              <div className="ap-modal-title">
                Compatible Aircraft
                {airport && <span className="ap-modal-sub"> — {airport.iata_code} · {formatRunway(airport.runway_length_m)} runway</span>}
              </div>
              <button className="ap-modal-close" onClick={() => setShowCapableModal(false)}>✕</button>
            </div>
            <div className="ap-modal-body">
              {capableLoading && <div className="ap-modal-loading">Loading…</div>}
              {!capableLoading && capableAircraft.length === 0 && (
                <div className="ap-modal-empty">No compatible aircraft found</div>
              )}
              {!capableLoading && capableAircraft.length > 0 && (() => {
                const WAKE_ORDER = ['L', 'M', 'H'];
                const grouped = {};
                WAKE_ORDER.forEach(w => { grouped[w] = []; });
                capableAircraft.forEach(ac => {
                  const w = ac.wake_turbulence_category || 'L';
                  if (!grouped[w]) grouped[w] = [];
                  grouped[w].push(ac);
                });
                WAKE_ORDER.forEach(w => grouped[w].sort((a, b) => a.full_name.localeCompare(b.full_name)));
                return (
                  <table className="ap-capable-table">
                    <thead>
                      <tr>
                        <th>Aircraft</th>
                        <th className="ap-ct-r">Min. Runway</th>
                      </tr>
                    </thead>
                    <tbody>
                      {WAKE_ORDER.filter(w => grouped[w].length > 0).map(w => (
                        <>
                          <tr key={`sep-${w}`} className="ap-capable-sep">
                            <td colSpan={2}>
                              <span className={`ap-wake-badge ap-wake-${w.toLowerCase()}`}>
                                {WAKE_LABELS[w]} ({grouped[w].length})
                              </span>
                            </td>
                          </tr>
                          {grouped[w].map(ac => (
                            <tr key={ac.id}>
                              <td className="ap-capable-name">
                                {ac.image_filename && (
                                  <img
                                    src={`/aircraft-images/${ac.image_filename}`}
                                    alt=""
                                    className="ap-capable-img"
                                    onError={e => { e.target.style.display = 'none'; }}
                                  />
                                )}
                                <span>{ac.full_name}</span>
                              </td>
                              <td className="ap-ct-r">{ac.min_runway_landing_m.toLocaleString()} m</td>
                            </tr>
                          ))}
                        </>
                      ))}
                    </tbody>
                  </table>
                );
              })()}
            </div>
            <div className="ap-modal-footer">
              <span className="ap-modal-count">{capableAircraft.length} aircraft type{capableAircraft.length !== 1 ? 's' : ''} compatible</span>
              <button className="ap-btn-close" onClick={() => setShowCapableModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        * { box-sizing: border-box; }

        .ap-page {
          min-height: 100vh;
          background: #F5F5F5;
        }

        /* ── Hero image ── */
        .ap-hero {
          width: 100%;
          height: 300px;
          background:
            linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.55)),
            url('/header-images/Headerimage_Airports.png')
            center / cover;
          position: relative;
          display: flex;
          align-items: flex-start;
          padding: 1rem 1.5rem;
        }
        @media (max-width: 768px) { .ap-hero { height: 220px; } }

        /* Back button overlaid on hero */
        .ap-btn-back {
          background: rgba(0,0,0,0.35);
          border: 1px solid rgba(255,255,255,0.35);
          color: white;
          padding: 0.45rem 1rem;
          border-radius: 6px;
          cursor: pointer;
          font-size: 0.85rem;
          font-weight: 500;
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          transition: background 0.15s;
        }
        .ap-btn-back:hover { background: rgba(0,0,0,0.55); }

        /* ── Page container ── */
        .ap-container {
          max-width: 1100px;
          margin: 0 auto;
          padding: 24px 24px 48px;
        }

        .ap-center-msg {
          display: flex; align-items: center; justify-content: center;
          min-height: 200px; color: #666; font-size: 0.95rem;
        }

        /* ── Info strip ── */
        .ap-info-strip {
          background: white;
          border-radius: 8px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          padding: 24px 28px;
          margin-top: 1.5rem;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1.5rem;
          flex-wrap: wrap;
        }

        /* Left: identity */
        .ap-identity {
          display: flex;
          align-items: center;
          gap: 20px;
        }
        .ap-iata {
          font-size: 3.5rem;
          font-weight: 900;
          font-family: monospace;
          color: #2C2C2C;
          letter-spacing: 0.06em;
          line-height: 1;
        }
        .ap-id-text { display: flex; flex-direction: column; gap: 4px; }
        .ap-airport-name { font-size: 1.2rem; font-weight: 700; color: #2C2C2C; }
        .ap-airport-country { font-size: 0.88rem; color: #666666; }

        /* Right: fees card + refresh */
        .ap-strip-right {
          display: flex;
          align-items: flex-start;
          gap: 20px;
          flex-wrap: wrap;
        }

        /* ── Airport Information table ── */
        .ap-info-table {
          width: 100%; border-collapse: collapse; font-size: 0.85rem;
        }
        .ap-info-table td {
          padding: 0.52rem 1rem; border-bottom: 1px solid #F0F0F0; vertical-align: middle;
        }
        .ap-info-table tr.ap-it-last td { border-bottom: none; }
        .ap-it-label { color: #666666; width: 48%; white-space: nowrap; }
        .ap-it-val { color: #2C2C2C; font-weight: 500; }
        .ap-it-fee { font-family: monospace; font-weight: 700; color: #2C2C2C; text-align: right; padding-right: 1rem !important; }
        .ap-it-section-col-hd {
          font-size: 0.66rem; font-weight: 600; color: #AAAAAA; text-transform: uppercase;
          letter-spacing: 0.08em; text-align: right; padding-right: 1rem;
        }
        .ap-it-runway { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
        .ap-it-section-row td {
          background: #F9F9F9; border-bottom: 1px solid #E8E8E8;
          padding: 0.3rem 1rem;
        }
        .ap-it-section-label {
          font-size: 0.66rem; font-weight: 700; text-transform: uppercase;
          letter-spacing: 0.09em; color: #999999;
        }

        .ap-cat-badge {
          display: inline-block;
          background: #2C2C2C; color: white;
          font-size: 0.72rem; font-weight: 700;
          padding: 0.15rem 0.5rem; border-radius: 4px;
          white-space: nowrap;
        }

        .ap-capable-link {
          background: none; border: none; cursor: pointer;
          color: #2C2C2C; font-size: 0.75rem; font-weight: 600;
          text-decoration: underline; text-underline-offset: 2px;
          padding: 0; white-space: nowrap;
          transition: opacity 0.15s;
        }
        .ap-capable-link:hover { opacity: 0.6; }

        /* ── Compatible Aircraft Modal ── */
        .ap-modal-backdrop {
          position: fixed; inset: 0;
          background: rgba(0,0,0,0.45);
          z-index: 1000;
          display: flex; align-items: center; justify-content: center;
          padding: 1rem;
        }
        .ap-modal {
          background: white; border-radius: 8px;
          box-shadow: 0 8px 40px rgba(0,0,0,0.25);
          width: 100%; max-width: 760px;
          max-height: 85vh;
          display: flex; flex-direction: column;
          overflow: hidden;
        }
        .ap-modal-header {
          background: #2C2C2C; color: white;
          padding: 0.85rem 1.2rem;
          display: flex; align-items: center; justify-content: space-between; gap: 1rem;
          flex-shrink: 0;
        }
        .ap-modal-title {
          font-size: 0.78rem; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.1em;
        }
        .ap-modal-sub { font-weight: 400; opacity: 0.65; text-transform: none; letter-spacing: 0; font-size: 0.8rem; }
        .ap-modal-close {
          background: none; border: none; color: rgba(255,255,255,0.7);
          cursor: pointer; font-size: 1rem; line-height: 1; padding: 0;
          transition: color 0.15s;
        }
        .ap-modal-close:hover { color: white; }
        .ap-modal-body {
          overflow-y: auto; flex: 1;
        }
        .ap-modal-loading, .ap-modal-empty {
          padding: 3rem 1.5rem; text-align: center;
          color: #AAAAAA; font-size: 0.88rem; font-style: italic;
        }
        .ap-modal-footer {
          border-top: 1px solid #E0E0E0; background: #FAFAFA;
          padding: 0.75rem 1.2rem;
          display: flex; align-items: center; justify-content: space-between;
          flex-shrink: 0;
        }
        .ap-modal-count { font-size: 0.78rem; color: #888888; }

        /* Capable aircraft table */
        .ap-capable-table {
          width: 100%; border-collapse: collapse; font-size: 0.84rem;
        }
        .ap-capable-table thead tr {
          background: #F9F9F9; border-bottom: 1px solid #E0E0E0;
        }
        .ap-capable-table th {
          padding: 0.5rem 0.9rem; text-align: left;
          font-size: 0.65rem; font-weight: 600; letter-spacing: 0.08em;
          text-transform: uppercase; color: #888; white-space: nowrap;
        }
        .ap-capable-table td {
          padding: 0.55rem 0.9rem; border-bottom: 1px solid #F0F0F0;
          color: #2C2C2C; vertical-align: middle;
        }
        .ap-capable-table tbody tr:last-child td { border-bottom: none; }
        .ap-capable-table tbody tr:hover td { background: #FAFAFA; }
        .ap-capable-sep td { background: #F5F5F5; padding: 6px 12px; border-bottom: 1px solid #E0E0E0; }
        .ap-capable-sep:hover td { background: #F5F5F5 !important; }
        .ap-ct-r { text-align: right !important; font-family: monospace; }
        .ap-capable-name {
          display: flex; align-items: center; gap: 0.6rem;
          font-weight: 500;
        }
        .ap-capable-img {
          width: 62px; aspect-ratio: 10/3; object-fit: cover;
          border-radius: 3px; background: #F5F5F5;
          flex-shrink: 0;
        }
        .ap-wake-badge {
          display: inline-block; padding: 0.12rem 0.45rem;
          border-radius: 3px; font-size: 0.68rem; font-weight: 700;
          letter-spacing: 0.04em; white-space: nowrap;
        }
        .ap-wake-l { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
        .ap-wake-m { background: #fffbeb; color: #b45309; border: 1px solid #fde68a; }
        .ap-wake-h { background: #fff1f2; color: #be123c; border: 1px solid #fecdd3; }

        .ap-strip-actions {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 6px;
          padding-top: 2px;
        }
        .ap-btn-add-dest {
          background: #2C2C2C;
          color: #fff;
          border: none;
          padding: 0.4rem 0.85rem;
          border-radius: 6px;
          cursor: pointer;
          font-size: 0.82rem;
          font-weight: 600;
          white-space: nowrap;
          transition: all 0.15s;
        }
        .ap-btn-add-dest:hover:not(:disabled) { background: #444; }
        .ap-btn-add-dest:disabled { opacity: 0.5; cursor: not-allowed; }
        .ap-btn-close {
          background: transparent;
          border: 1px solid #E0E0E0;
          padding: 0.4rem 0.85rem;
          border-radius: 6px;
          cursor: pointer;
          font-size: 0.82rem;
          color: #555;
          white-space: nowrap;
          transition: all 0.15s;
        }
        .ap-btn-close:hover { background: #F5F5F5; border-color: #AAAAAA; }

        /* ── Map + Info row ── */
        .ap-map-row {
          margin-top: 1.5rem;
          display: grid;
          grid-template-columns: 1fr 395px;
          gap: 1.5rem;
          align-items: stretch;
        }
        @media (max-width: 900px) {
          .ap-map-row { grid-template-columns: 1fr; }
        }
        .ap-map-col {
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          height: 400px;
        }
        .ap-info-col {
          /* stretches to match map height */
          align-self: stretch;
        }

        /* ── Main content grid ── */
        .ap-main {
          margin-top: 1.5rem;
          display: grid;
          grid-template-columns: 7fr 3fr;
          gap: 1.5rem;
          align-items: start;
        }
        @media (max-width: 900px) {
          .ap-main { grid-template-columns: 1fr; }
          .ap-sidebar-col { order: -1; }
        }

        /* ── Flight boards (FIDS style) ── */
        .ap-board-wrap {
          background: #0D1117;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 4px 20px rgba(0,0,0,0.25);
        }
        .ap-board-titlebar {
          padding: 0.7rem 1rem;
          display: flex; align-items: center; gap: 0.55rem;
          font-size: 0.7rem; font-weight: 800; letter-spacing: 0.16em; color: white;
        }
        .ap-board-titlebar.dep { background: #0F2040; }
        .ap-board-titlebar.arr { background: #0F2819; }
        .ap-board-arrow { font-size: 1rem; font-weight: 900; }
        .ap-board-title { flex: 1; }
        .ap-board-ct { font-size: 0.65rem; color: rgba(255,255,255,0.3); font-weight: 400; letter-spacing: 0; }

        .ap-board-empty {
          padding: 3rem 1.5rem; text-align: center;
          color: rgba(255,255,255,0.2); font-size: 0.83rem; font-style: italic;
        }

        /* Board table */
        .ap-board-table {
          width: 100%; border-collapse: collapse;
          font-family: 'Courier New', Courier, monospace;
        }
        .ap-board-table thead tr {
          background: rgba(255,255,255,0.04);
          border-bottom: 1px solid rgba(255,255,255,0.07);
        }
        .ap-board-table th {
          padding: 0.5rem 0.85rem; text-align: left;
          font-size: 0.65rem; font-weight: 700;
          letter-spacing: 0.1em; text-transform: uppercase;
          color: rgba(255,255,255,0.35); white-space: nowrap;
          font-family: system-ui, sans-serif;
        }
        .ap-board-table td {
          padding: 2px 0.85rem; color: #EDE8D0; height: 30px;
          font-size: 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.04);
          white-space: nowrap; vertical-align: middle;
        }
        .ap-board-table tbody tr:last-child td { border-bottom: none; }
        .ap-board-table tbody tr:hover td { background: rgba(255,255,255,0.03); }
        .ap-board-table tbody tr.ap-row-done td { opacity: 0.45; }

        .ap-fn { font-size: 0.88rem; font-weight: 500; color: #facc15 !important; letter-spacing: 0.04em; }
        .ap-apt-col { font-size: 0.88rem; font-weight: 500; color: rgba(255,255,255,0.65) !important; }
        .ap-apt-col button { font-size: 0.88rem; color: rgba(255,255,255,0.65) !important; text-decoration-color: rgba(255,255,255,0.25) !important; }
        .ap-time { font-size: 0.88rem !important; font-weight: 500; color: rgba(255,255,255,0.65) !important; }
        .ap-th-status { text-align: right !important; }
        .ap-td-status { text-align: right; }
        .ap-day-sep-row td { padding: 0; }
        .ap-day-sep-cell {
          padding: 0.35rem 0.85rem !important;
          font-size: 0.65rem !important; font-weight: 700 !important;
          letter-spacing: 0.1em; text-transform: uppercase;
          color: rgba(255,255,255,0.35) !important;
          background: rgba(255,255,255,0.04);
          border-top: 1px solid rgba(255,255,255,0.07) !important;
          border-bottom: 1px solid rgba(255,255,255,0.07) !important;
          font-family: system-ui, sans-serif !important;
        }

        /* Airline chip inside board */
        .ap-chip-board {
          display: inline-block; background: rgba(255,255,255,0.1);
          border: 1px solid rgba(255,255,255,0.15); color: rgba(255,255,255,0.85);
          font-size: 0.7rem; font-weight: 700; padding: 0.13rem 0.42rem;
          border-radius: 3px; letter-spacing: 0.05em; font-family: monospace;
        }

        /* Status dots */
        @keyframes ap-blink-a { 0%,100%{opacity:1} 50%{opacity:0.15} }
        @keyframes ap-blink-b { 0%,100%{opacity:0.15} 50%{opacity:1} }
        .ap-dot-blink-a { animation: ap-blink-a 1.2s ease-in-out infinite; }
        .ap-dot-blink-b { animation: ap-blink-b 1.2s ease-in-out infinite; }

        /* Status badges (kept for reference, not used in boards) */
        .ap-status {
          display: inline-block; padding: 0.17rem 0.55rem;
          border-radius: 3px; font-size: 0.68rem; font-weight: 700;
          letter-spacing: 0.05em; font-family: system-ui, sans-serif; white-space: nowrap;
        }
        .ap-st-scheduled{ background: rgba(148,163,184,0.12); color: rgba(255,255,255,0.45); border: 1px solid rgba(148,163,184,0.18); }
        .ap-st-ontime  { background: rgba(34,197,94,0.18);  color: #4ade80; border: 1px solid rgba(34,197,94,0.28); }
        .ap-st-boarding{ background: rgba(234,179,8,0.18);  color: #facc15; border: 1px solid rgba(234,179,8,0.28); }
        .ap-st-taxiing { background: rgba(249,115,22,0.18); color: #fb923c; border: 1px solid rgba(249,115,22,0.28); }
        .ap-st-gone    { background: rgba(148,163,184,0.12); color: rgba(255,255,255,0.32); border: 1px solid rgba(148,163,184,0.15); }

        /* ── Airlines sidebar ── */
        .ap-sidebar-card {
          background: white; border-radius: 8px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden;
        }
        .ap-sidebar-title {
          padding: 0.8rem 1.1rem; background: #2C2C2C; color: white;
          font-size: 0.7rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;
        }
        .ap-sidebar-empty {
          padding: 2rem 1.1rem; text-align: center;
          color: #AAAAAA; font-size: 0.85rem; font-style: italic;
        }
        /* Airlines Operating list */
        .ap-al-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
        .ap-al-table td { padding: 0.52rem 1rem; border-bottom: 1px solid #F0F0F0; vertical-align: middle; }
        .ap-al-table tr.ap-al-last td { border-bottom: none; }
        .ap-al-name { color: #2C2C2C; font-weight: 500; }
        .ap-al-ct { color: #666666; text-align: right; white-space: nowrap; }
        .ap-al-info-body { }
        .ap-al-info-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
        .ap-al-info-table td { padding: 0.52rem 1.1rem; border-bottom: 1px solid #F0F0F0; vertical-align: middle; }
        .ap-al-info-divider td { background: #F9F9F9; padding: 0.3rem 1.1rem; border-bottom: 1px solid #E0E0E0; }
        .ap-al-info-section { font-size: 0.66rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #888; }
        .ap-al-info-label { color: #666666; width: 50%; }
        .ap-al-info-val { color: #2C2C2C; font-weight: 500; }
        .ap-chip-dark {
          display: inline-block; background: #2C2C2C;
          color: white; font-size: 0.68rem; font-weight: 700;
          padding: 0.12rem 0.4rem; border-radius: 3px;
          letter-spacing: 0.06em; font-family: monospace; flex-shrink: 0;
        }
        .ap-al-name-link {
          background: none; border: none; color: #2C2C2C; cursor: pointer;
          font: inherit; padding: 0; text-decoration: underline;
          text-decoration-color: #CCC; text-underline-offset: 2px;
        }
        .ap-al-name-link:hover { text-decoration-color: #2C2C2C; }

        @media (max-width: 480px) {
          .ap-hero { height: 160px; padding: 0.75rem 1rem; }
          .ap-container { padding: 16px 10px 32px; }
          .ap-info-strip { padding: 16px; flex-direction: column; align-items: flex-start; gap: 1rem; }
          .ap-iata { font-size: 2.4rem; }
          .ap-airport-name { font-size: 1rem; }
          .ap-strip-right { width: 100%; }
          .ap-map-row { grid-template-columns: 1fr; gap: 1rem; margin-top: 1rem; }
          .ap-map-col { height: 250px; }
          .ap-info-table td { padding: 0.4rem 0.6rem; font-size: 0.8rem; }
          .ap-main { grid-template-columns: 1fr; gap: 1rem; margin-top: 1rem; }
          .ap-board-table th { padding: 0.35rem 0.5rem; font-size: 0.58rem; }
          .ap-board-table td { padding: 2px 0.5rem; font-size: 0.7rem; }
          .ap-fn { font-size: 0.78rem; }
          .ap-apt-col, .ap-apt-col button { font-size: 0.78rem; }
          .ap-time { font-size: 0.78rem !important; }
          .ap-board-wrap { border-radius: 6px; }
          .ap-sidebar-card { border-radius: 6px; }
          .ap-al-table td { padding: 0.4rem 0.7rem; font-size: 0.8rem; }
          .ap-modal { max-width: 100%; }
          .ap-capable-table th { padding: 0.35rem 0.5rem; }
          .ap-capable-table td { padding: 0.4rem 0.5rem; font-size: 0.78rem; }
          .ap-capable-img { width: 44px; }
          .ap-capable-name { gap: 0.4rem; }
        }
      `}</style>

      {profilePopupCode && (
        <AirlineProfilePopup airlineCode={profilePopupCode} onClose={() => setProfilePopupCode(null)} />
      )}
    </div>
  );
}
