import { useState, useEffect, useMemo, useCallback } from 'react';
import TopBar from '../components/TopBar.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

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

const CATEGORY_COLORS = {
  1: '#9ca3af',
  2: '#6b7280',
  3: '#60a5fa',
  4: '#3b82f6',
  5: '#8b5cf6',
  6: '#f59e0b',
  7: '#f97316',
  8: '#ef4444',
};

export default function AirportOverview({ airline, onBack, backLabel = 'Flight Operations', onNavigateToAirport, onBalanceUpdate }) {
  const [airports, setAirports] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [adding, setAdding]     = useState(null);
  const [popupCode, setPopupCode] = useState(null);
  const [popupData, setPopupData] = useState(null);
  const popupCacheRef = useMemo(() => ({}), []);

  const handleCardClick = useCallback(async (code) => {
    if (popupCode === code) { setPopupCode(null); return; }
    setPopupCode(code);
    if (popupCacheRef[code]) { setPopupData(popupCacheRef[code]); return; }
    setPopupData(null);
    try {
      const res = await fetch(`${API_URL}/api/airports/${code}/hover`);
      if (res.ok) { const d = await res.json(); popupCacheRef[code] = d; setPopupData(d); }
    } catch { /* ignore */ }
  }, [popupCode]);

  const fmtFee = (v) => v != null ? `$${Math.round(v).toLocaleString()}` : '—';

  const [search, setSearch]                   = useState('');
  const [filterContinent, setFilterContinent] = useState(null);
  const [filterCountry, setFilterCountry]     = useState(null);
  const [filterCategory, setFilterCategory]   = useState(null);
  const [continentOpen, setContinentOpen]     = useState(false);
  const [countryOpen, setCountryOpen]         = useState(false);
  const [categoryOpen, setCategoryOpen]       = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('token');
    fetch(`${API_URL}/api/airports/available`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(r => r.json())
      .then(d => { setAirports(d.airports || []); setLoading(false); })
      .catch(() => { setError('Failed to load airports'); setLoading(false); });
  }, []);

  const continents = useMemo(() => {
    const map = {};
    for (const a of airports) if (a.continent) map[a.continent] = (map[a.continent] || 0) + 1;
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [airports]);

  const countries = useMemo(() => {
    const map = {};
    const base = filterContinent ? airports.filter(a => a.continent === filterContinent) : airports;
    for (const a of base) map[a.country] = (map[a.country] || 0) + 1;
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [airports, filterContinent]);

  const categories = useMemo(() => {
    const map = {};
    for (const a of airports) if (a.category) map[a.category] = (map[a.category] || 0) + 1;
    return Object.entries(map)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([cat, count]) => [Number(cat), count]);
  }, [airports]);

  const filtered = useMemo(() => {
    let list = airports;
    if (filterContinent) list = list.filter(a => a.continent === filterContinent);
    if (filterCountry)   list = list.filter(a => a.country === filterCountry);
    if (filterCategory !== null) list = list.filter(a => a.category === filterCategory);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(a =>
        a.iata_code.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        a.country.toLowerCase().includes(q)
      );
    }
    return list;
  }, [airports, search, filterContinent, filterCountry, filterCategory]);

  // Group key depends on active filters:
  // - no continent filter → group by continent
  // - continent selected, no country → group by country
  // - country selected → single group (the country)
  const groups = useMemo(() => {
    const map = {};
    for (const a of filtered) {
      let key;
      if (filterCountry) key = a.country;
      else if (filterContinent) key = a.country || 'Other';
      else key = a.continent || 'Other';
      if (!map[key]) map[key] = [];
      map[key].push(a);
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered, filterContinent, filterCountry]);

  const handleAddDestination = async (e, code) => {
    e.stopPropagation();
    setAdding(code);
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/destinations/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ airport_code: code, destination_type: 'destination' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      if (data.new_balance != null) onBalanceUpdate?.(data.new_balance);
      setAirports(prev => prev.map(a => a.iata_code === code ? { ...a, is_opened: true } : a));
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(null);
    }
  };

  const hasFilters = filterContinent || filterCountry || filterCategory !== null || search;

  const resetFilters = () => {
    setFilterContinent(null);
    setFilterCountry(null);
    setFilterCategory(null);
    setSearch('');
    setContinentOpen(false);
    setCountryOpen(false);
    setCategoryOpen(false);
  };

  if (loading) return (
    <div className="am-page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: '#666' }}>
        Loading…
      </div>
    </div>
  );

  const networkCount = airports.filter(a => a.is_opened).length;

  return (
    <div className="am-page">
      {/* Hero */}
      <div className="am-hero">
        <div className="am-hero-overlay">
          <h1>Airport Overview</h1>
          <p>{airline.name} — {airports.length} Airports Worldwide</p>
        </div>
      </div>

      <div className="am-container">
        <TopBar airline={airline} onBack={onBack} backLabel={backLabel} />

        {error && <div className="am-msg am-msg--error">{error}</div>}

        <div className="am-layout">
          {/* ── SIDEBAR ── */}
          <aside className="am-sidebar">
            {/* Search */}
            <div className="am-sb-section">
              <input
                className="am-sb-search"
                placeholder="Search airport…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>

            {/* Continent — collapsible */}
            <div className="am-sb-section">
              <button className="ao-sb-toggle" onClick={() => setContinentOpen(o => !o)}>
                <span className="am-sb-label" style={{ margin: 0 }}>Continent</span>
                <span className="ao-sb-arrow">{continentOpen ? '▲' : '▼'}</span>
              </button>
              {(continentOpen || filterContinent) && (
                <>
                  <button
                    className={`am-sb-mfr-item${!filterContinent ? ' am-sb-mfr-item--active' : ''}`}
                    onClick={() => { setFilterContinent(null); setFilterCountry(null); }}
                  >
                    <span>All Continents</span>
                    <span className="am-sb-mfr-count">{airports.length}</span>
                  </button>
                  {continents.map(([cont, count]) => (
                    <button
                      key={cont}
                      className={`am-sb-mfr-item${filterContinent === cont ? ' am-sb-mfr-item--active' : ''}`}
                      onClick={() => {
                        setFilterContinent(filterContinent === cont ? null : cont);
                        setFilterCountry(null);
                      }}
                    >
                      <span>{cont}</span>
                      <span className="am-sb-mfr-count">{count}</span>
                    </button>
                  ))}
                </>
              )}
            </div>

            {/* Country — collapsible */}
            <div className="am-sb-section">
              <button
                className="ao-sb-toggle"
                onClick={() => setCountryOpen(o => !o)}
              >
                <span className="am-sb-label" style={{ margin: 0 }}>Country</span>
                <span className="ao-sb-arrow">{countryOpen ? '▲' : '▼'}</span>
              </button>
              {(countryOpen || filterCountry) && (
                <>
                  <button
                    className={`am-sb-mfr-item${!filterCountry ? ' am-sb-mfr-item--active' : ''}`}
                    onClick={() => setFilterCountry(null)}
                  >
                    <span>All Countries</span>
                    <span className="am-sb-mfr-count">{(filterContinent ? airports.filter(a => a.continent === filterContinent) : airports).length}</span>
                  </button>
                  {countries.map(([country, count]) => (
                    <button
                      key={country}
                      className={`am-sb-mfr-item${filterCountry === country ? ' am-sb-mfr-item--active' : ''}`}
                      onClick={() => setFilterCountry(filterCountry === country ? null : country)}
                    >
                      <span>{country}</span>
                      <span className="am-sb-mfr-count">{count}</span>
                    </button>
                  ))}
                </>
              )}
            </div>

            {/* Category — collapsible */}
            <div className="am-sb-section">
              <button className="ao-sb-toggle" onClick={() => setCategoryOpen(o => !o)}>
                <span className="am-sb-label" style={{ margin: 0 }}>Category</span>
                <span className="ao-sb-arrow">{categoryOpen ? '▲' : '▼'}</span>
              </button>
              {(categoryOpen || filterCategory !== null) && (
                <>
                  <button
                    className={`am-sb-mfr-item${filterCategory === null ? ' am-sb-mfr-item--active' : ''}`}
                    onClick={() => setFilterCategory(null)}
                  >
                    <span>All Categories</span>
                    <span className="am-sb-mfr-count">{airports.length}</span>
                  </button>
                  {categories.map(([cat, count]) => (
                    <button
                      key={cat}
                      className={`am-sb-mfr-item${filterCategory === cat ? ' am-sb-mfr-item--active' : ''}`}
                      onClick={() => setFilterCategory(filterCategory === cat ? null : cat)}
                    >
                      <span>{cat} · {CATEGORY_LABELS[cat]}</span>
                      <span className="am-sb-mfr-count">{count}</span>
                    </button>
                  ))}
                </>
              )}
            </div>

            {/* Reset */}
            {hasFilters && (
              <div className="am-sb-section">
                <button className="am-sb-reset" onClick={resetFilters}>Reset Filters</button>
              </div>
            )}
          </aside>

          {/* ── MAIN CONTENT ── */}
          <div className="am-content">
            {filtered.length === 0 ? (
              <div className="am-empty">No airports match your filters.</div>
            ) : (
              groups.map(([groupName, list]) => (
                <div key={groupName} className="am-mfr-section">
                  <div className="am-mfr-header">
                    <span className="am-mfr-name">{groupName}</span>
                    <span className="am-mfr-count">{list.length} airport{list.length !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="am-mfr-body">
                    <div className="am-grid">
                      {list.map(a => (
                        <div key={a.iata_code} className="ao-card" onClick={() => handleCardClick(a.iata_code)}>
                          <div className="ao-card-top">
                            <span className="ao-iata ao-iata-link" onClick={e => { e.stopPropagation(); onNavigateToAirport?.(a.iata_code); }}>{a.iata_code}</span>
                            <span className="ao-cat-badge">
                              {a.category} · {CATEGORY_LABELS[a.category] || '—'}
                            </span>
                          </div>
                          <div className="ao-name">{a.name}</div>
                          <div className="ao-country">{a.country}</div>
                          <div className="ao-card-foot">
                            {a.is_opened ? (
                              <button className="ao-btn-added" disabled onClick={e => e.stopPropagation()}>
                                ✓ Added
                              </button>
                            ) : (
                              <button
                                className="ao-btn-add"
                                disabled={adding === a.iata_code}
                                onClick={e => handleAddDestination(e, a.iata_code)}
                              >
                                {adding === a.iata_code ? '…' : '+ Add as Destination'}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {popupCode && (() => {
        const ap = airports.find(a => a.iata_code === popupCode);
        if (!ap) return null;
        return (
          <div className="ao-popup-backdrop" onClick={() => setPopupCode(null)}>
            <div className="ao-popup" onClick={e => e.stopPropagation()}>
              <div className="ao-popup-hero">
                <div className="ao-popup-hero-overlay">
                  <span className="ao-popup-code">{ap.iata_code}</span>
                  <span className="ao-popup-name">{ap.name}</span>
                </div>
              </div>
              {!popupData ? (
                <div style={{ padding: '1rem', textAlign: 'center', color: '#999', fontSize: '0.8rem' }}>Loading...</div>
              ) : (<>
                <div className="ao-popup-section">Fees</div>
                <table className="ao-popup-table">
                  <thead><tr><th></th><th>Landing</th><th>Handling</th></tr></thead>
                  <tbody>
                    <tr><td className="ao-popup-wake">Light</td><td>{fmtFee(popupData.fees.landing_light)}</td><td>{fmtFee(popupData.fees.handling_light)}</td></tr>
                    <tr><td className="ao-popup-wake">Medium</td><td>{fmtFee(popupData.fees.landing_medium)}</td><td>{fmtFee(popupData.fees.handling_medium)}</td></tr>
                    <tr><td className="ao-popup-wake">Heavy</td><td>{fmtFee(popupData.fees.landing_heavy)}</td><td>{fmtFee(popupData.fees.handling_heavy)}</td></tr>
                  </tbody>
                </table>
                <div className="ao-popup-section">
                  Compatible Aircraft ({popupData.aircraft.length})
                  {popupData.runway_length_m && <span style={{ fontWeight: 400, marginLeft: 6 }}>· {popupData.runway_length_m.toLocaleString()}m</span>}
                </div>
                <div className="ao-popup-ac-list">
                  {popupData.aircraft.map((ac, i) => (
                    <div key={i} className="ao-popup-ac-row">
                      <img src={`/aircraft-images/${ac.image_filename}`} alt="" className="ao-popup-ac-img" onError={e => { e.target.style.display = 'none'; }} />
                      <span className="ao-popup-ac-name">{ac.full_name}</span>
                      <span className="ao-popup-ac-pax">{ac.max_passengers}</span>
                    </div>
                  ))}
                </div>
              </>)}
              <button className="ao-popup-close" onClick={() => setPopupCode(null)}>&times;</button>
            </div>
          </div>
        );
      })()}

      <style>{`
        .am-page { min-height: 100vh; background: #F5F5F5; }

        .am-hero {
          width: 100%; height: 280px;
          background: linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.6)),
            url('/header-images/Headerimage_airportoverview.png') center/cover;
          display: flex; align-items: center; justify-content: center;
        }
        .am-hero-overlay { text-align: center; color: white; }
        .am-hero-overlay h1 { font-size: 2.8rem; margin: 0; text-shadow: 2px 2px 4px rgba(0,0,0,0.5); }
        .am-hero-overlay p  { font-size: 1.1rem; margin-top: 0.5rem; opacity: 0.9; }

        .am-container { max-width: 1400px; margin: 0 auto; padding: 2rem; }

        .am-msg { padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.9rem; }
        .am-msg--error { background: #FEE2E2; color: #DC2626; border: 1px solid #FCA5A5; }

        .am-layout { display: grid; grid-template-columns: 230px 1fr; gap: 1.5rem; align-items: start; }

        .am-sidebar {
          background: white; border-radius: 8px; padding: 1rem;
          box-shadow: 0 2px 8px rgba(0,0,0,0.08); position: sticky; top: 1rem;
          max-height: calc(100vh - 2rem); overflow-y: auto;
        }
        .am-sb-section { margin-bottom: 1.25rem; }
        .am-sb-section:last-child { margin-bottom: 0; }
        .am-sb-label {
          font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
          letter-spacing: 0.1em; color: #999; margin-bottom: 0.5rem;
        }
        .am-sb-search {
          width: 100%; padding: 0.5rem 0.7rem; border: 1px solid #E0E0E0;
          border-radius: 6px; font-size: 0.85rem; background: white; color: #2C2C2C;
          box-sizing: border-box;
        }
        .am-sb-search:focus { outline: none; border-color: #2C2C2C; }
        .am-sb-mfr-item {
          width: 100%; display: flex; justify-content: space-between; align-items: center;
          padding: 0.4rem 0.6rem; border: none; border-radius: 5px; cursor: pointer;
          font-size: 0.82rem; color: #444; background: transparent; text-align: left;
          transition: background 0.12s, color 0.12s;
        }
        .am-sb-mfr-item:hover { background: #F5F5F5; color: #2C2C2C; }
        .am-sb-mfr-item--active { background: #2C2C2C; color: white; font-weight: 600; }
        .am-sb-mfr-count {
          font-size: 0.72rem; opacity: 0.5; background: rgba(0,0,0,0.08);
          padding: 1px 5px; border-radius: 8px; flex-shrink: 0;
        }
        .am-sb-mfr-item--active .am-sb-mfr-count { background: rgba(255,255,255,0.2); opacity: 0.8; }
        .am-sb-reset {
          width: 100%; padding: 0.45rem; background: #FEE2E2; color: #DC2626;
          border: none; border-radius: 6px; font-size: 0.8rem; font-weight: 600; cursor: pointer;
        }
        .am-sb-reset:hover { background: #FECACA; }
        .ao-sb-toggle {
          width: 100%; display: flex; justify-content: space-between; align-items: center;
          background: none; border: none; cursor: pointer; padding: 0 0 0.4rem 0; margin: 0;
        }
        .ao-sb-toggle:hover .am-sb-label { color: #666; }
        .ao-sb-arrow { font-size: 0.55rem; color: #bbb; }

        .am-mfr-section { margin-bottom: 1.25rem; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .am-mfr-header {
          display: flex; justify-content: space-between; align-items: center;
          background: #2C2C2C; color: white; padding: 12px 18px;
        }
        .am-mfr-name { font-size: 0.82rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
        .am-mfr-count { font-size: 0.72rem; opacity: 0.55; }
        .am-mfr-body { background: white; padding: 1.25rem; }

        .am-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; }
        @media (max-width: 1300px) { .am-grid { grid-template-columns: repeat(3, 1fr); } }
        @media (max-width: 900px)  { .am-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 560px)  { .am-grid { grid-template-columns: 1fr; } }

        .am-empty {
          background: white; border-radius: 8px; padding: 3rem; text-align: center;
          color: #999; font-size: 0.9rem; box-shadow: 0 2px 8px rgba(0,0,0,0.06);
        }

        /* Airport cards */
        .ao-card {
          background: white; border-radius: 8px;
          border: 1px solid #F0F0F0; display: flex; flex-direction: column;
          padding: 12px 14px 10px; gap: 3px;
          cursor: pointer; transition: box-shadow 0.15s, border-color 0.15s;
        }
        .ao-card:hover { box-shadow: 0 4px 14px rgba(0,0,0,0.1); border-color: #D0D0D0; }

        .ao-card-top {
          display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2px;
        }
        .ao-iata {
          font-size: 1.28rem; font-weight: 900; font-family: monospace;
          color: #1A1A1A; letter-spacing: 0.04em; line-height: 1;
        }
        .ao-cat-badge {
          font-size: 0.65rem; font-weight: 700; background: #2C2C2C; color: white;
          border-radius: 4px; padding: 2px 7px; letter-spacing: 0.03em; white-space: nowrap;
          align-self: flex-start; margin-top: 3px;
        }
        .ao-name {
          font-size: 0.8rem; font-weight: 600; color: #2C2C2C;
          line-height: 1.3; margin-top: 2px;
        }
        .ao-country { font-size: 0.75rem; color: #999; }
        .ao-card-foot { margin-top: 8px; }
        .ao-btn-add {
          width: 100%; padding: 5px 10px; background: white; color: #2C2C2C;
          border: 1px solid #D0D0D0; border-radius: 5px; font-size: 0.78rem;
          font-weight: 600; cursor: pointer; transition: border-color 0.12s, background 0.12s;
        }
        .ao-btn-add:hover:not(:disabled) { border-color: #2C2C2C; background: #F5F5F5; }
        .ao-btn-add:disabled { opacity: 0.5; cursor: not-allowed; }
        .ao-btn-added {
          width: 100%; padding: 5px 10px; background: #F5F5F5; color: #22c55e;
          border: 1px solid #d1fae5; border-radius: 5px; font-size: 0.78rem;
          font-weight: 700; cursor: default;
        }

        /* IATA link style */
        .ao-iata-link {
          text-decoration: underline; text-decoration-color: #CCC;
          text-underline-offset: 3px; cursor: pointer;
        }
        .ao-iata-link:hover { text-decoration-color: #2C2C2C; }

        /* Airport info popup */
        .ao-popup-backdrop {
          position: fixed; inset: 0; background: rgba(0,0,0,0.4);
          display: flex; align-items: center; justify-content: center;
          z-index: 9999;
        }
        .ao-popup {
          position: relative; width: 360px; max-height: 80vh; overflow-y: auto;
          background: #fff; border-radius: 10px;
          box-shadow: 0 12px 40px rgba(0,0,0,0.25);
        }
        .ao-popup-hero {
          height: 80px;
          background: linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.6)),
            url('/header-images/Headerimage_Airports.png') center / cover;
          border-radius: 10px 10px 0 0;
          display: flex; align-items: flex-end; padding: 8px 12px;
        }
        .ao-popup-hero-overlay { display: flex; align-items: baseline; gap: 8px; }
        .ao-popup-code { font-family: monospace; font-size: 1.3rem; font-weight: 800; color: #fff; letter-spacing: 0.04em; }
        .ao-popup-name { font-size: 0.72rem; color: rgba(255,255,255,0.85); font-weight: 500; }
        .ao-popup-section {
          background: #F0F0F0; color: #666; font-size: 0.65rem; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.08em; padding: 4px 12px;
        }
        .ao-popup-table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
        .ao-popup-table th {
          text-align: left; padding: 4px 12px; font-size: 0.65rem; font-weight: 600;
          color: #999; text-transform: uppercase; letter-spacing: 0.05em;
        }
        .ao-popup-table td { padding: 3px 12px; color: #2C2C2C; border-bottom: 1px solid #F5F5F5; }
        .ao-popup-wake { font-weight: 600; color: #666; width: 60px; }
        .ao-popup-ac-list { max-height: 180px; overflow-y: auto; }
        .ao-popup-ac-row {
          display: flex; align-items: center; gap: 8px;
          padding: 3px 12px; border-bottom: 1px solid #F5F5F5;
        }
        .ao-popup-ac-row:last-child { border-bottom: none; }
        .ao-popup-ac-img {
          width: 52px; aspect-ratio: 1000/333; object-fit: cover;
          border-radius: 2px; background: #F5F5F5; flex-shrink: 0;
        }
        .ao-popup-ac-name { font-size: 0.72rem; font-weight: 500; color: #2C2C2C; flex: 1; }
        .ao-popup-ac-pax { font-size: 0.68rem; color: #888; white-space: nowrap; }
        .ao-popup-close {
          position: absolute; top: 6px; right: 8px;
          background: rgba(0,0,0,0.3); border: none; color: #fff;
          width: 22px; height: 22px; border-radius: 50%;
          font-size: 1rem; line-height: 1; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
        }
        .ao-popup-close:hover { background: rgba(0,0,0,0.5); }
      `}</style>
    </div>
  );
}
