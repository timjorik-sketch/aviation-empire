import { useState, useEffect, useMemo } from 'react';
import TopBar from '../components/TopBar.jsx';
import Loader from '../components/Loader.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

const DAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

const fmt = {
  time: (t) => t ? t.slice(0, 5) : '—',
  flightNum: (fn) => fn.length > 4 ? fn.slice(0, fn.length - 4) + '\u00A0' + fn.slice(-4) : fn,
  reg: (r) => r ? r.replace('-', '–') : r,
};

// Classify a flight by great-circle distance into haul category
function haulCategory(distance_km) {
  if (distance_km == null) return null;
  if (distance_km < 1500) return 'short';
  if (distance_km <= 4000) return 'medium';
  return 'long';
}

// Build day→times map, then compress into display rows
function buildScheduleRows(slots) {
  const dayTimes = {};
  for (const s of slots) {
    const d = s.day_of_week;
    if (!dayTimes[d]) dayTimes[d] = new Set();
    dayTimes[d].add(fmt.time(s.departure_time));
  }

  // Serialize each day's times as sorted string key
  const dayPattern = {};
  for (const [d, set] of Object.entries(dayTimes)) {
    const key = [...set].sort().join('|');
    if (!dayPattern[key]) dayPattern[key] = { times: [...set].sort(), days: [] };
    dayPattern[key].days.push(Number(d));
  }

  const rows = Object.values(dayPattern).map(({ times, days }) => {
    days.sort((a, b) => a - b);
    let label;
    if (days.length === 7) {
      label = 'Daily';
    } else {
      // Split into consecutive runs, format each as range or single day
      const runs = [];
      let runStart = days[0], runEnd = days[0];
      for (let i = 1; i < days.length; i++) {
        if (days[i] === runEnd + 1) {
          runEnd = days[i];
        } else {
          runs.push(runStart === runEnd ? DAY_LABELS[runStart] : runEnd - runStart === 1 ? `${DAY_LABELS[runStart]} ${DAY_LABELS[runEnd]}` : `${DAY_LABELS[runStart]}–${DAY_LABELS[runEnd]}`);
          runStart = runEnd = days[i];
        }
      }
      runs.push(runStart === runEnd ? DAY_LABELS[runStart] : runEnd - runStart === 1 ? `${DAY_LABELS[runStart]} ${DAY_LABELS[runEnd]}` : `${DAY_LABELS[runStart]}–${DAY_LABELS[runEnd]}`);
      label = runs.join(', ');
    }
    return { label, times };
  });

  // Sort rows: daily first, then by first day index
  rows.sort((a, b) => {
    if (a.label === 'Daily') return -1;
    if (b.label === 'Daily') return 1;
    return 0;
  });
  return rows;
}

function FlightSchedule({ airline, onBack, onNavigateToAirport, onNavigateToAircraft }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('routes'); // 'routes' | 'distribution'
  const [selectedAirport, setSelectedAirport] = useState(null);
  const [haulFilter, setHaulFilter] = useState('all'); // 'all' | 'short' | 'medium' | 'long'

  useEffect(() => {
    const token = localStorage.getItem('token');
    fetch(`${API_URL}/api/flights/weekly-schedule`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setEntries(d.entries || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Distribution view: unique departure airports
  const distAirports = useMemo(() => {
    const map = new Map();
    for (const e of entries) {
      if (!map.has(e.departure_airport)) {
        map.set(e.departure_airport, { iata: e.departure_airport, name: e.departure_name });
      }
    }
    return [...map.values()].sort((a, b) => a.iata.localeCompare(b.iata));
  }, [entries]);

  // Default selectedAirport once entries load
  useEffect(() => {
    if (distAirports.length === 0) return;
    if (selectedAirport && distAirports.some(a => a.iata === selectedAirport)) return;
    const home = airline?.home_airport_code;
    const next = (home && distAirports.some(a => a.iata === home)) ? home : distAirports[0].iata;
    setSelectedAirport(next);
  }, [distAirports, selectedAirport, airline]);

  // Distribution rows: one row per unique departure time at selected airport.
  // Each row has 7 day columns; each cell holds a list of departures (arrival IATA + flight + aircraft).
  const distRows = useMemo(() => {
    if (!selectedAirport) return [];
    const byTime = new Map(); // "HH:MM" -> { time, days: { 0..6: [{...}] } }
    for (const e of entries) {
      if (e.departure_airport !== selectedAirport) continue;
      if (haulFilter !== 'all' && haulCategory(e.distance_km) !== haulFilter) continue;
      const t = fmt.time(e.departure_time);
      if (!byTime.has(t)) byTime.set(t, { time: t, days: {} });
      const row = byTime.get(t);
      if (!row.days[e.day_of_week]) row.days[e.day_of_week] = [];
      row.days[e.day_of_week].push({
        id: e.id,
        arrival_airport: e.arrival_airport,
        arrival_name: e.arrival_name,
        flight_number: e.flight_number,
        aircraft_id: e.aircraft_id,
        registration: e.registration,
      });
    }
    return [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
  }, [entries, selectedAirport, haulFilter]);

  // Group by departure_airport → flight_number
  const grouped = entries.reduce((acc, e) => {
    const depKey = e.departure_airport;
    if (!acc[depKey]) acc[depKey] = { iata: depKey, name: e.departure_name, byFlight: {} };
    const fnKey = e.flight_number;
    if (!acc[depKey].byFlight[fnKey]) {
      acc[depKey].byFlight[fnKey] = {
        flight_number: fnKey,
        arrival_airport: e.arrival_airport,
        arrival_name: e.arrival_name,
        slots: [],
        aircraft: {},
      };
    }
    acc[depKey].byFlight[fnKey].slots.push(e);
    acc[depKey].byFlight[fnKey].aircraft[e.aircraft_id] = {
      id: e.aircraft_id, registration: e.registration, is_operating: e.is_operating,
    };
    return acc;
  }, {});

  const airports = Object.values(grouped)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(ap => ({
      ...ap,
      flights: Object.values(ap.byFlight).sort((a, b) => a.flight_number.localeCompare(b.flight_number)),
    }));

  const totalRoutes = airports.reduce((s, ap) => s + ap.flights.length, 0);

  return (
    <div className="app">
      <style>{`
        /* Section header */
        .fs-apt-hd {
          display: flex; align-items: center; gap: 10px;
          padding: 9px 20px;
          background: #EFEFEF;
          border-top: 1px solid #E0E0E0;
          border-bottom: 1px solid #E0E0E0;
        }
        .fs-apt-hd:first-child { border-top: none; }
        .fs-apt-iata {
          font-family: monospace; font-size: 0.88rem; font-weight: 800;
          color: #2C2C2C; letter-spacing: 0.04em; background: none; border: none;
          padding: 0; cursor: pointer;
          text-decoration: underline; text-decoration-style: dashed;
          text-underline-offset: 3px; text-decoration-color: rgba(0,0,0,0.4);
        }
        .fs-apt-iata:hover { color: #555; }
        .fs-apt-name { font-size: 0.78rem; color: #999; }
        .fs-apt-count { font-size: 0.72rem; color: #BBB; margin-left: auto; }

        /* Flight row */
        .fs-row {
          display: grid;
          grid-template-columns: 72px 44px 1fr auto;
          align-items: start;
          gap: 12px;
          padding: 8px 20px;
          border-bottom: 0.5px solid #EBEBEB;
        }
        .fs-row:last-child { border-bottom: none; }
        .fs-row:hover { background: #F7F7F7; }

        /* Flight number */
        .fs-fn {
          font-family: monospace; font-size: 0.82rem; font-weight: 700;
          color: #2C2C2C; letter-spacing: 0.02em; padding-top: 1px;
        }

        /* Destination link */
        .fs-dest-link {
          font-family: monospace; font-size: 0.82rem; font-weight: 700;
          color: #2C2C2C; background: none; border: none; padding: 0; cursor: pointer;
          text-decoration: underline; text-decoration-style: dashed;
          text-underline-offset: 3px; text-decoration-color: rgba(0,0,0,0.4);
          padding-top: 1px;
        }
        .fs-dest-link:hover { color: #555; }

        /* Times column */
        .fs-times { display: flex; flex-direction: column; gap: 4px; }
        .fs-day-row { display: flex; align-items: center; gap: 6px; }
        .fs-day-lbl {
          font-size: 11px; color: #AAA; font-weight: 600;
          min-width: 58px; flex-shrink: 0;
        }
        .fs-pills { display: flex; flex-wrap: wrap; gap: 3px; }
        .fs-pill {
          font-size: 11px; font-variant-numeric: tabular-nums;
          background: #F2F2F2; border: 1px solid #E4E4E4;
          border-radius: 4px; padding: 1px 5px; color: #444;
          font-family: monospace;
        }

        /* Aircraft column */
        .fs-regs {
          display: flex; flex-direction: column; align-items: flex-end;
          gap: 2px; padding-top: 1px;
        }
        .fs-reg {
          font-size: 11px; color: #AAA; font-family: monospace;
          background: none; border: none; padding: 0; cursor: pointer;
          text-align: right;
        }
        .fs-reg:hover { color: #666; }

        .fs-empty { color: #AAA; font-style: italic; font-size: 0.85rem; padding: 2rem 1.5rem; }

        /* View mode pill (header) */
        .fs-view-pill {
          display: inline-flex;
          background: rgba(0,0,0,0.18);
          border: 1px solid rgba(255,255,255,0.25);
          border-radius: 6px;
          padding: 2px;
          gap: 2px;
          flex-shrink: 0;
        }
        .card-header-bar .fs-view-pill-btn {
          padding: 0.3rem 0.9rem;
          background: transparent;
          border: none;
          color: rgba(255,255,255,0.75);
          border-radius: 4px;
          font-size: 0.7rem;
          font-weight: 600;
          cursor: pointer;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          transition: background 0.15s, color 0.15s;
          white-space: nowrap;
        }
        .card-header-bar .fs-view-pill-btn:hover:not(.fs-view-pill-btn--active) {
          background: rgba(255,255,255,0.1);
          color: white;
        }
        .card-header-bar .fs-view-pill-btn--active {
          background: white;
          color: #2C2C2C;
        }

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
          display: flex; flex-wrap: wrap; gap: 3px;
          min-height: 32px;
          align-content: flex-start;
        }
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
          .fs-view-pill { flex-shrink: 0; }
        }

        @media (max-width: 480px) {
          .fs-row {
            grid-template-columns: 60px 38px 1fr;
            gap: 6px 8px;
            padding: 8px 12px;
          }
          .fs-regs { grid-column: 1 / -1; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 4px; }
          .fs-reg { font-size: 10px; }
          .fs-fn { font-size: 0.75rem; }
          .fs-dest-link { font-size: 0.75rem; }
          .fs-day-lbl { min-width: 46px; font-size: 10px; }
          .fs-pill { font-size: 10px; padding: 1px 4px; }
          .fs-apt-hd { padding: 7px 12px; gap: 8px; }
          .fs-apt-iata { font-size: 0.82rem; }
          .fs-apt-name { font-size: 0.72rem; }
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
                {totalRoutes} routes · {airports.length} airports
              </span>
            </div>
            <div className="fs-view-pill" role="tablist" aria-label="Flightplan view mode">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'routes'}
                className={`fs-view-pill-btn${viewMode === 'routes' ? ' fs-view-pill-btn--active' : ''}`}
                onClick={() => setViewMode('routes')}
              >
                Routes
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'distribution'}
                className={`fs-view-pill-btn${viewMode === 'distribution' ? ' fs-view-pill-btn--active' : ''}`}
                onClick={() => setViewMode('distribution')}
              >
                Time Distribution
              </button>
            </div>
          </div>

          {loading ? (
            <Loader />
          ) : entries.length === 0 ? (
            <div className="fs-empty">No flights scheduled. Assign routes in fleet management.</div>
          ) : viewMode === 'distribution' ? (
            <div className="fs-dist">
              <div className="fs-dist-controls">
                <label className="fs-dist-label">
                  <span>Departure Airport</span>
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
                  {distRows.length} departure time{distRows.length !== 1 ? 's' : ''}
                </span>
              </div>

              {distRows.length === 0 ? (
                <div className="fs-empty">No departures from {selectedAirport}.</div>
              ) : (
                <div className="fs-dist-grid">
                  <div className="fs-dist-head">
                    <span className="fs-dist-head-time">Time</span>
                    {DAY_LABELS.map(lbl => (
                      <span key={lbl} className="fs-dist-head-day">{lbl}</span>
                    ))}
                  </div>
                  {distRows.map(row => (
                    <div key={row.time} className="fs-dist-row">
                      <span className="fs-dist-time">{row.time}</span>
                      {DAY_LABELS.map((_, di) => {
                        const cell = row.days[di] || [];
                        return (
                          <div key={di} className="fs-dist-cell">
                            {cell.map(f => (
                              <button
                                key={f.id}
                                type="button"
                                className="fs-dist-pill"
                                title={`${f.flight_number} → ${f.arrival_airport} ${f.arrival_name} · ${fmt.reg(f.registration)}`}
                                onClick={() => onNavigateToAirport?.(f.arrival_airport)}
                              >
                                {f.arrival_airport}
                              </button>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            airports.map(ap => (
              <div key={ap.iata}>
                <div className="fs-apt-hd">
                  <button className="fs-apt-iata" onClick={() => onNavigateToAirport?.(ap.iata)}>
                    {ap.iata}
                  </button>
                  <span className="fs-apt-name">{ap.name}</span>
                  <span className="fs-apt-count">{ap.flights.length} route{ap.flights.length !== 1 ? 's' : ''}</span>
                </div>

                {ap.flights.map(f => {
                  const schedRows = buildScheduleRows(f.slots);
                  const acList = Object.values(f.aircraft);
                  return (
                    <div key={f.flight_number} className="fs-row">
                      {/* Col 1: flight number */}
                      <span className="fs-fn">{fmt.flightNum(f.flight_number)}</span>

                      {/* Col 2: destination */}
                      <button className="fs-dest-link" onClick={() => onNavigateToAirport?.(f.arrival_airport)}>
                        {f.arrival_airport}
                      </button>

                      {/* Col 3: departure times by day */}
                      <div className="fs-times">
                        {schedRows.map(row => (
                          <div key={row.label} className="fs-day-row">
                            <span className="fs-day-lbl">{row.label}</span>
                            <div className="fs-pills">
                              {row.times.map(t => (
                                <span key={t} className="fs-pill">{t}</span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Col 4: aircraft registrations */}
                      <div className="fs-regs">
                        {acList.map(ac => (
                          <button key={ac.id} className="fs-reg" onClick={() => onNavigateToAircraft?.(ac.id)}>
                            {fmt.reg(ac.registration)}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default FlightSchedule;
