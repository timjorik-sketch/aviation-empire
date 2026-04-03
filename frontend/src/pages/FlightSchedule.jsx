import { useState, useEffect } from 'react';
import TopBar from '../components/TopBar.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

const DAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

const fmt = {
  time: (t) => t ? t.slice(0, 5) : '—',
  flightNum: (fn) => fn.length > 4 ? fn.slice(0, fn.length - 4) + '\u00A0' + fn.slice(-4) : fn,
  reg: (r) => r ? r.replace('-', '–') : r,
};

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
      label = 'Täglich';
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

  // Sort rows: täglich first, then by first day index
  rows.sort((a, b) => {
    if (a.label === 'täglich') return -1;
    if (b.label === 'täglich') return 1;
    return 0;
  });
  return rows;
}

function FlightSchedule({ airline, onBack, onNavigateToAirport, onNavigateToAircraft }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    fetch(`${API_URL}/api/flights/weekly-schedule`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setEntries(d.entries || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

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
      `}</style>

      <div className="page-hero" style={{ backgroundImage: "linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.6)), url('/header-images/Headerimage_opertaions.png')" }}>
        <div className="page-hero-overlay">
          <h1>Flightplan</h1>
          <p>{airline.name}</p>
        </div>
      </div>

      <div className="container" style={{ paddingTop: '24px' }}>
        <TopBar onBack={onBack} balance={airline.balance} airline={airline} />

        <div className="info-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="card-header-bar" style={{ margin: 0 }}>
            <span className="card-header-bar-title">{airline.name} — Flightplan</span>
            <span style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.5)' }}>
              {totalRoutes} routes · {airports.length} airports
            </span>
          </div>

          {loading ? (
            <div className="fs-empty">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="fs-empty">No flights scheduled. Assign routes in fleet management.</div>
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
