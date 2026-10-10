import { useState, useEffect, useMemo } from 'react';
import TopBar from '../components/TopBar.jsx';
import Loader from '../components/Loader.jsx';
import { bankColorMap, inWindow, minutesToHHMM, parseHM, windowLabel } from '../utils/bankWindows.js';

const API_URL = import.meta.env.VITE_API_URL || '';

const DAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

const fmt = {
  time: (t) => t ? t.slice(0, 5) : '—',
  reg: (r) => r ? r.replace('-', '–') : r,
};

// Schedule times are stored as Europe/Berlin wall-clock "HH:MM" (the single
// game-time source). For the Time Distribution boards we re-derive each
// airport's local wall-clock via the same longitude approximation used across
// the app (Berlin ≈ UTC+1 under round(lon/15)).
const BERLIN_LON_OFFSET = 1;
function lonOffsetHours(lon) {
  if (lon == null || isNaN(lon)) return null;
  return Math.round(lon / 15);
}
// Shift a Berlin "HH:MM" on weekday `day` (0=Mon) into local time at `lon`,
// rolling the weekday column when the shift crosses midnight.
function toAirportLocal(berlinHHMM, day, lon) {
  const off = lonOffsetHours(lon);
  const [h, m] = (berlinHHMM || '00:00').split(':').map(Number);
  let total = h * 60 + m;
  if (off != null) total += (off - BERLIN_LON_OFFSET) * 60;
  const dayShift = Math.floor(total / 1440);
  total = ((total % 1440) + 1440) % 1440;
  const nd = (((day + dayShift) % 7) + 7) % 7;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return { day: nd, time: `${hh}:${mm}` };
}

// Classify a flight by great-circle distance into haul category
function haulCategory(distance_km) {
  if (distance_km == null) return null;
  if (distance_km < 1500) return 'short';
  if (distance_km <= 4000) return 'medium';
  return 'long';
}

function FlightSchedule({ airline, onBack, onNavigateToAirport }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedAirport, setSelectedAirport] = useState(null);
  const [distMode, setDistMode] = useState('departure'); // 'departure' | 'arrival'
  const [haulFilter, setHaulFilter] = useState('all'); // 'all' | 'short' | 'medium' | 'long'
  const [banks, setBanks] = useState([]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    fetch(`${API_URL}/api/flights/weekly-schedule`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setEntries(d.entries || []))
      .catch(() => {})
      .finally(() => setLoading(false));
    fetch(`${API_URL}/api/banks`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setBanks(d.banks || []))
      .catch(() => {});
  }, []);

  // Bank windows are hub-local; the relevant window follows the mode — departure window for departures, arrival window for arrivals.
  const bankWindow = (b, mode) => mode === 'departure'
    ? [b.earliest_departure, b.latest_departure]
    : [b.earliest_arrival, b.latest_arrival];
  const bankColors = useMemo(() => bankColorMap(banks), [banks]);
  const bankStyle = (b) => b ? { '--bk': bankColors[b.id] } : undefined;
  const airportBanks = useMemo(
    () => banks.filter(b => b.hub_airport_code === selectedAirport),
    [banks, selectedAirport]
  );

  // Every airport we touch (as origin or destination), with longitude
  const distAirports = useMemo(() => {
    const map = new Map();
    for (const e of entries) {
      if (!map.has(e.departure_airport)) {
        map.set(e.departure_airport, { iata: e.departure_airport, name: e.departure_name, longitude: e.departure_longitude });
      }
      if (!map.has(e.arrival_airport)) {
        map.set(e.arrival_airport, { iata: e.arrival_airport, name: e.arrival_name, longitude: e.arrival_longitude });
      }
    }
    return [...map.values()].sort((a, b) => a.iata.localeCompare(b.iata));
  }, [entries]);

  const selectedAirportLon = useMemo(
    () => distAirports.find(a => a.iata === selectedAirport)?.longitude ?? null,
    [distAirports, selectedAirport]
  );

  // Default selectedAirport once entries load
  useEffect(() => {
    if (distAirports.length === 0) return;
    if (selectedAirport && distAirports.some(a => a.iata === selectedAirport)) return;
    const home = airline?.home_airport_code;
    const next = (home && distAirports.some(a => a.iata === home)) ? home : distAirports[0].iata;
    setSelectedAirport(next);
  }, [distAirports, selectedAirport, airline]);

  // Distribution rows: one row per unique local time at the selected airport.
  // In 'departure' mode the time is the local departure time and the pill shows
  // the destination; in 'arrival' mode it is the local arrival time and the pill
  // shows the origin. Times are converted to the selected airport's local zone,
  // rolling the weekday column when the conversion crosses midnight.
  const distRows = useMemo(() => {
    if (!selectedAirport) return [];
    const isDep = distMode === 'departure';
    const byTime = new Map(); // "HH:MM" -> { time, days: { 0..6: [{...}] } }
    for (const e of entries) {
      const hub = isDep ? e.departure_airport : e.arrival_airport;
      if (hub !== selectedAirport) continue;
      if (haulFilter !== 'all' && haulCategory(e.distance_km) !== haulFilter) continue;

      const depT = fmt.time(e.departure_time);
      const arrT = fmt.time(e.arrival_time);
      let berlinTime = isDep ? depT : arrT;
      let berlinDay = e.day_of_week;
      // Arrival times stored as Berlin wall-clock: overnight legs land the next day.
      if (!isDep && arrT !== '—' && depT !== '—' && arrT <= depT) berlinDay = (berlinDay + 1) % 7;

      const local = toAirportLocal(berlinTime, berlinDay, selectedAirportLon);
      if (!byTime.has(local.time)) byTime.set(local.time, { time: local.time, days: {} });
      const row = byTime.get(local.time);
      if (!row.days[local.day]) row.days[local.day] = [];
      row.days[local.day].push({
        id: e.id,
        airport: isDep ? e.arrival_airport : e.departure_airport,
        airport_name: isDep ? e.arrival_name : e.departure_name,
        flight_number: e.flight_number,
        aircraft_id: e.aircraft_id,
        registration: e.registration,
      });
    }
    // Empty rows at each window edge so a bank's band stays visible even
    // where it has no flights yet.
    for (const b of airportBanks) {
      for (const m of bankWindow(b, distMode)) {
        const t = minutesToHHMM(m);
        if (!byTime.has(t)) byTime.set(t, { time: t, days: {} });
      }
    }
    return [...byTime.values()]
      .map(row => {
        const min = parseHM(row.time);
        return { ...row, banks: airportBanks.filter(b => inWindow(min, ...bankWindow(b, distMode))) };
      })
      .sort((a, b) => a.time.localeCompare(b.time));
  }, [entries, selectedAirport, selectedAirportLon, haulFilter, distMode, airportBanks]);

  // Header counts: routes = distinct flight numbers per origin airport
  const totalRoutes = new Set(entries.map(e => `${e.departure_airport}|${e.flight_number}`)).size;
  const originCount = new Set(entries.map(e => e.departure_airport)).size;

  return (
    <div className="app">
      <style>{`
        .fs-empty { color: #AAA; font-style: italic; font-size: 0.85rem; padding: 2rem 1.5rem; }

        /* Distribution view */
        .fs-dist-controls {
          display: flex; align-items: center; justify-content: space-between;
          gap: 16px;
          padding: 14px 20px;
          background: #FAFAFA;
          border-bottom: 1px solid #E8E8E8;
          flex-wrap: wrap;
        }
        .fs-dist-label {
          display: flex; align-items: center; gap: 10px;
          font-size: 0.72rem; color: #666; font-weight: 600;
          text-transform: uppercase; letter-spacing: 0.05em;
        }
        .fs-dist-select {
          font-family: monospace; font-size: 0.85rem; font-weight: 600;
          padding: 6px 10px;
          background: white;
          border: 1px solid #DDD;
          border-radius: 6px;
          color: #2C2C2C;
          cursor: pointer;
          min-width: 220px;
        }
        .fs-dist-select:focus { outline: none; border-color: #2C2C2C; }
        .fs-dist-summary {
          font-size: 0.72rem; color: #999;
          font-variant-numeric: tabular-nums;
        }

        /* Haul-length pill filter */
        .fs-haul-filter {
          display: inline-flex;
          gap: 2px;
          background: #EFEFEF;
          border: 1px solid #DDD;
          border-radius: 6px;
          padding: 2px;
        }
        .fs-haul-btn {
          padding: 5px 12px;
          background: transparent;
          border: none;
          border-radius: 4px;
          font-size: 0.72rem;
          font-weight: 600;
          color: #777;
          cursor: pointer;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          white-space: nowrap;
          transition: background 0.15s, color 0.15s;
        }
        .fs-haul-btn:hover:not(.fs-haul-btn--active) {
          background: rgba(0,0,0,0.05);
          color: #2C2C2C;
        }
        .fs-haul-btn--active {
          background: white;
          color: #2C2C2C;
          box-shadow: 0 1px 2px rgba(0,0,0,0.12);
        }

        .fs-dist-grid {
          display: flex; flex-direction: column;
        }
        .fs-dist-head,
        .fs-dist-row {
          display: grid;
          grid-template-columns: 64px repeat(7, 1fr);
          gap: 1px;
          background: #EBEBEB;
        }
        .fs-dist-row {
          border-bottom: 1px solid #EBEBEB;
        }
        .fs-dist-row:last-child { border-bottom: none; }
        .fs-dist-head {
          position: sticky; top: 0; z-index: 1;
          border-bottom: 1px solid #DADADA;
        }
        .fs-dist-head-time,
        .fs-dist-head-day {
          padding: 8px 6px;
          background: #F0F0F0;
          font-size: 0.68rem; font-weight: 700;
          color: #888;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          text-align: center;
        }
        .fs-dist-head-time { text-align: left; padding-left: 12px; }

        .fs-dist-time {
          padding: 8px 12px;
          background: #F7F7F7;
          font-family: monospace; font-size: 0.82rem; font-weight: 700;
          color: #2C2C2C;
          letter-spacing: 0.02em;
          display: flex; align-items: flex-start;
          font-variant-numeric: tabular-nums;
        }
        .fs-dist-cell {
          background: white;
          padding: 6px;
          display: flex; flex-direction: column; gap: 3px;
          min-height: 32px;
        }
        /* One slot per destination, in a shared order across all 7 day columns,
           so the same destination sits at the same height every day. */
        .fs-dist-slot { display: flex; flex-wrap: wrap; gap: 3px; }
        .fs-dist-pill {
          font-family: monospace; font-size: 0.75rem; font-weight: 700;
          letter-spacing: 0.02em;
          background: #F2F2F2;
          border: 1px solid #E0E0E0;
          color: #2C2C2C;
          border-radius: 4px;
          padding: 2px 6px;
          cursor: pointer;
          transition: background 0.15s, border-color 0.15s;
        }
        .fs-dist-pill:hover { background: #2C2C2C; color: white; border-color: #2C2C2C; }

        /* Bank windows: light hatching in the bank's own colour (--bk = "r,g,b") */
        .fs-dist-row--bank .fs-dist-cell,
        .fs-dist-row--bank .fs-dist-time {
          background-color: rgba(var(--bk), 0.04);
          background-image: repeating-linear-gradient(135deg, rgba(var(--bk), 0.16) 0 2px, transparent 2px 7px);
        }
        .fs-dist-row--bank .fs-dist-time { box-shadow: inset 3px 0 0 rgba(var(--bk), 0.7); }
        .fs-bank-legend {
          display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px;
          padding: 8px 20px; font-size: 0.72rem; color: #777;
          border-bottom: 1px solid #E8E8E8;
        }
        .fs-bank-legend-sw {
          display: inline-block; width: 18px; height: 10px; margin-right: 6px; vertical-align: -1px;
          border: 1px solid rgba(var(--bk), 0.5); border-radius: 2px;
          background-image: repeating-linear-gradient(135deg, rgba(var(--bk), 0.45) 0 2px, transparent 2px 5px);
        }
        @media (max-width: 720px) {
          .fs-dist-head,
          .fs-dist-row { grid-template-columns: 54px repeat(7, 1fr); }
          .fs-dist-time { padding: 6px 8px; font-size: 0.75rem; }
          .fs-dist-cell { padding: 4px; min-height: 28px; }
          .fs-dist-pill { font-size: 0.68rem; padding: 1px 4px; }
          .fs-dist-head-time, .fs-dist-head-day { font-size: 0.62rem; padding: 6px 4px; }

          .fs-dist-controls { flex-direction: column; align-items: stretch; }
          .fs-dist-label { flex-direction: column; align-items: flex-start; }
          .fs-dist-select { min-width: 0; width: 100%; }
          .fs-haul-filter { width: 100%; justify-content: stretch; }
          .fs-haul-btn { flex: 1; text-align: center; }

          .fs-header-titles { overflow: hidden; }
          .fs-header-titles .card-header-bar-title {
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          }
          .fs-header-sub { display: none; }
        }
      `}</style>

      <div className="page-hero" style={{ backgroundImage: "url('/header-images/Headerimage_opertaions.png')" }}>
        <div className="page-hero-overlay">
          <h1>Flightplan</h1>
          <p>{airline.name}</p>
        </div>
      </div>

      <div className="container" style={{ paddingTop: '24px' }}>
        <TopBar onBack={onBack} balance={airline.balance} airline={airline} />

        <div className="info-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="card-header-bar" style={{ margin: 0 }}>
            <div className="fs-header-titles" style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
              <span className="card-header-bar-title">{airline.name} — Flightplan</span>
              <span className="fs-header-sub" style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.5)' }}>
                {totalRoutes} routes · {originCount} airports
              </span>
            </div>
          </div>

          {loading ? (
            <Loader />
          ) : entries.length === 0 ? (
            <div className="fs-empty">No flights scheduled. Assign routes in fleet management.</div>
          ) : (
            <div className="fs-dist">
              <div className="fs-dist-controls">
                <label className="fs-dist-label">
                  <span>Airport</span>
                  <select
                    className="fs-dist-select"
                    value={selectedAirport || ''}
                    onChange={e => setSelectedAirport(e.target.value)}
                  >
                    {distAirports.map(ap => (
                      <option key={ap.iata} value={ap.iata}>
                        {ap.iata} — {ap.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="fs-haul-filter" role="group" aria-label="Departures or arrivals">
                  {[
                    { key: 'departure', label: 'Departures' },
                    { key: 'arrival', label: 'Arrivals' },
                  ].map(opt => (
                    <button
                      key={opt.key}
                      type="button"
                      className={`fs-haul-btn${distMode === opt.key ? ' fs-haul-btn--active' : ''}`}
                      aria-pressed={distMode === opt.key}
                      onClick={() => setDistMode(opt.key)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="fs-haul-filter" role="group" aria-label="Filter by haul length">
                  {[
                    { key: 'all', label: 'All' },
                    { key: 'short', label: 'Short' },
                    { key: 'medium', label: 'Medium' },
                    { key: 'long', label: 'Long' },
                  ].map(opt => (
                    <button
                      key={opt.key}
                      type="button"
                      className={`fs-haul-btn${haulFilter === opt.key ? ' fs-haul-btn--active' : ''}`}
                      aria-pressed={haulFilter === opt.key}
                      onClick={() => setHaulFilter(opt.key)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <span className="fs-dist-summary">
                  {distRows.length} {distMode === 'departure' ? 'departure' : 'arrival'} time{distRows.length !== 1 ? 's' : ''} · {selectedAirport} local
                </span>
              </div>

              {airportBanks.length > 0 && (
                <div className="fs-bank-legend">
                  <span>{distMode === 'departure' ? 'Departure windows' : 'Arrival windows'}:</span>
                  {airportBanks.map(b => {
                    const [s0, e0] = bankWindow(b, distMode);
                    return (
                      <span key={b.id} style={bankStyle(b)}>
                        <span className="fs-bank-legend-sw" />
                        <strong style={{ color: `rgb(${bankColors[b.id]})` }}>{b.name}</strong> {windowLabel(s0, e0)}
                      </span>
                    );
                  })}
                </div>
              )}

              {distRows.length === 0 ? (
                <div className="fs-empty">
                  No {distMode === 'departure' ? 'departures from' : 'arrivals at'} {selectedAirport}.
                </div>
              ) : (
                <div className="fs-dist-grid">
                  <div className="fs-dist-head">
                    <span className="fs-dist-head-time">Time</span>
                    {DAY_LABELS.map(lbl => (
                      <span key={lbl} className="fs-dist-head-day">{lbl}</span>
                    ))}
                  </div>
                  {distRows.map(row => {
                    // Shared, stable airport order for this time row (across all days)
                    const aps = [...new Set(
                      DAY_LABELS.flatMap((_, di) => (row.days[di] || []).map(f => f.airport))
                    )].sort();
                    const arrow = distMode === 'departure' ? '→' : '←';
                    return (
                      <div key={row.time} className={`fs-dist-row${row.banks.length ? ' fs-dist-row--bank' : ''}`} style={bankStyle(row.banks[0])}>
                        <span className="fs-dist-time"
                          title={row.banks.length ? row.banks.map(b => `${b.name} · ${distMode === 'departure' ? 'departure' : 'arrival'} window`).join('\n') : undefined}>
                          {row.time}
                        </span>
                        {DAY_LABELS.map((_, di) => {
                          const cell = row.days[di] || [];
                          const byAp = {};
                          for (const f of cell) (byAp[f.airport] ||= []).push(f);
                          return (
                            <div key={di} className="fs-dist-cell">
                              {aps.map(ap => {
                                const flights = byAp[ap];
                                if (!flights) {
                                  // Invisible placeholder keeps this airport's slot at the same height
                                  return (
                                    <span key={ap} className="fs-dist-slot" aria-hidden="true">
                                      <span className="fs-dist-pill" style={{ visibility: 'hidden' }}>{ap}</span>
                                    </span>
                                  );
                                }
                                return (
                                  <span key={ap} className="fs-dist-slot">
                                    {flights.map(f => (
                                      <button
                                        key={f.id}
                                        type="button"
                                        className="fs-dist-pill"
                                        title={`${f.flight_number} ${arrow} ${f.airport} ${f.airport_name} · ${fmt.reg(f.registration)}`}
                                        onClick={() => onNavigateToAirport?.(f.airport)}
                                      >
                                        {f.airport}
                                      </button>
                                    ))}
                                  </span>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default FlightSchedule;
