import { useState, useEffect, Component } from 'react';

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '2rem', fontFamily: 'monospace', background: '#fff1f2', border: '2px solid #dc2626', borderRadius: 8, margin: '2rem' }}>
          <div style={{ color: '#dc2626', fontWeight: 700, marginBottom: 8 }}>⚠ Render Error (DEV)</div>
          <pre style={{ color: '#991b1b', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{this.state.error.message}</pre>
          <pre style={{ color: '#6b7280', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 8 }}>{this.state.error.stack}</pre>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop: 12, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 16px', cursor: 'pointer', fontWeight: 600 }}>
            Dismiss
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
import Login from './pages/Login';
import Register from './pages/Register';
import FleetPage from './pages/FleetPage';
import AircraftDetail from './pages/AircraftDetail';
import AircraftMarketplace from './pages/AircraftMarketplace';
import RoutePlanner from './pages/RoutePlanner';
import FlightOperations from './pages/FlightOperations';
import FlightSchedule from './pages/FlightSchedule';
import Finances from './pages/Finances';
import ServiceProfiles from './pages/ServiceProfiles';
import CabinProfiles from './pages/CabinProfiles';
import AirportPage from './pages/AirportPage';
import HubsDestinations from './pages/HubsDestinations';
import AirportOverview from './pages/AirportOverview';
import Personnel from './pages/Personnel.jsx';
import EditProfile from './pages/EditProfile';
import RouteMap from './pages/RouteMap';
import AirportLink from './components/AirportLink.jsx';
import RoutePreviewMap from './components/RoutePreviewMap.jsx';
import SatisfactionRating, { getSatColor, scoreToRating } from './components/SatisfactionRating.jsx';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || '';

function CreateAirlineForm({ onCreated, onCancel }) {
  const [name, setName] = useState('');
  const [airlineCode, setAirlineCode] = useState('');
  const [selectedCountry, setSelectedCountry] = useState('');
  const [homeAirport, setHomeAirport] = useState('');
  const [airports, setAirports] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/airline/airports`)
      .then(r => r.json())
      .then(d => setAirports(d.airports || []))
      .catch(console.error);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/airline`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ name, airline_code: airlineCode, home_airport_code: homeAirport })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.errors?.[0]?.msg || 'Failed to create airline');
      onCreated(data.airline);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const countries = [...new Set(airports.map(a => a.country))].sort();
  const airportsInCountry = airports.filter(a => a.country === selectedCountry);

  return (
    <div>
      <h3 style={{ margin: '0 0 20px', color: '#2C2C2C', fontSize: '18px' }}>Create New Airline</h3>
      {error && <div className="error-message">{error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Airline Name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g., Sky Express Airways"
            minLength={3}
            maxLength={50}
            required
          />
        </div>
        <div className="form-group">
          <label>IATA Code</label>
          <input
            type="text"
            value={airlineCode}
            onChange={e => setAirlineCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3))}
            placeholder="e.g., SE"
            required
          />
          <small style={{ color: '#888', fontSize: '12px', marginTop: '4px', display: 'block' }}>
            2-3 uppercase letters — your unique airline identifier
          </small>
        </div>
        <div className="form-group">
          <label>Country</label>
          <select value={selectedCountry} onChange={e => { setSelectedCountry(e.target.value); setHomeAirport(''); }} required>
            <option value="">Select country…</option>
            {countries.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Home Airport</label>
          <select value={homeAirport} onChange={e => setHomeAirport(e.target.value)} disabled={!selectedCountry} required>
            <option value="">{selectedCountry ? 'Select airport…' : 'Select a country first'}</option>
            {airportsInCountry.map(ap => (
              <option key={ap.iata_code} value={ap.iata_code}>{ap.name} ({ap.iata_code})</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
          <button
            type="submit"
            className="btn-primary"
            disabled={loading}
            style={{ flex: 1, padding: '12px', margin: 0 }}
          >
            {loading ? 'Creating...' : 'Create Airline'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="btn-secondary"
            style={{ flex: 1, padding: '12px' }}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ⚠️ DEV ONLY — DELETE BEFORE RELEASE
function DevRouteCalc() {
  const [dep, setDep] = useState('');
  const [arr, setArr] = useState('');
  const [ecoPx, setEcoPx] = useState('');
  const [bizPx, setBizPx] = useState('');
  const [firPx, setFirPx] = useState('');
  const [condition, setCondition] = useState('95');
  const [spId, setSpId] = useState('');
  const [cpId, setCpId] = useState('');
  const [ecoCap, setEcoCap] = useState('150');
  const [bizCap, setBizCap] = useState('0');
  const [firCap, setFirCap] = useState('0');
  const [serviceProfiles, setServiceProfiles] = useState([]);
  const [cabinProfiles, setCabinProfiles] = useState([]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('token');
    const h = { Authorization: `Bearer ${token}` };
    fetch(`${API_URL}/api/service-profiles`, { headers: h })
      .then(r => r.json()).then(d => setServiceProfiles(d.profiles || [])).catch(() => {});
    fetch(`${API_URL}/api/cabin-profiles`, { headers: h })
      .then(r => r.json()).then(d => setCabinProfiles(d.profiles || [])).catch(() => {});
  }, []);

  // When cabin profile changes → auto-fill seat caps
  useEffect(() => {
    if (!cpId) return;
    const profile = cabinProfiles.find(p => String(p.id) === cpId);
    if (!profile) return;
    const cap = (ct) => profile.classes?.find(c => c.class_type === ct)?.actual_capacity ?? 0;
    setEcoCap(String(cap('economy')));
    setBizCap(String(cap('business')));
    setFirCap(String(cap('first')));
  }, [cpId, cabinProfiles]);

  const selectedCp = cabinProfiles.find(p => String(p.id) === cpId) || null;

  const calculate = async () => {
    setErr(''); setResult(null); setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const params = new URLSearchParams({ dep, arr, eco_price: ecoPx, biz_price: bizPx,
        fir_price: firPx, condition, service_profile_id: spId,
        eco_cap: ecoCap, biz_cap: bizCap, fir_cap: firCap });
      const res = await fetch(`${API_URL}/api/flights/dev/route-calc?${params}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      setResult(data);
    } catch (e) { setErr(e.message); } finally { setLoading(false); }
  };

  const attrColor = (v) => {
    if (v === null) return '#999';
    if (v >= 1.5) return '#16a34a';
    if (v >= 1.0) return '#65a30d';
    if (v >= 0.5) return '#d97706';
    if (v >= 0.1) return '#dc2626';
    return '#991b1b';
  };
  const attrLabel = (v) => {
    if (v === null) return '—';
    if (v >= 1.5) return 'Very High';
    if (v >= 1.0) return 'Good';
    if (v >= 0.5) return 'Moderate';
    if (v >= 0.1) return 'Low';
    return 'Very Low';
  };
  const pct = (a, b) => b > 0 ? `${Math.round(a/b*100)}%` : '—';

  const inp = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 4, padding: '5px 8px', fontSize: 13, color: '#2C2C2C', width: '100%' };
  const lbl = { fontSize: 11, color: '#6b7280', fontWeight: 600, display: 'block', marginBottom: 2 };

  return (
    <div style={{ marginTop: '1.5rem', background: '#fff7ed', border: '2px solid #dc2626', borderRadius: 8, overflow: 'hidden' }}>
      <button onClick={() => setOpen(o => !o)} style={{ width: '100%', background: '#7f1d1d', color: '#fff', border: 'none', padding: '10px 20px', textAlign: 'left', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}>
        <span>⚠ DEV — Route Price Calculator</span>
        <span>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ padding: '16px 20px' }}>
          {/* Input grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '10px 14px', marginBottom: 12 }}>
            <div>
              <label style={lbl}>DEP</label>
              <input style={inp} value={dep} onChange={e => setDep(e.target.value.toUpperCase().slice(0,4))} placeholder="ZRH" />
            </div>
            <div>
              <label style={lbl}>ARR</label>
              <input style={inp} value={arr} onChange={e => setArr(e.target.value.toUpperCase().slice(0,4))} placeholder="LHR" />
            </div>
            <div>
              <label style={lbl}>Economy $</label>
              <input style={inp} type="number" value={ecoPx} onChange={e => setEcoPx(e.target.value)} placeholder="250" />
            </div>
            <div>
              <label style={lbl}>Business $</label>
              <input style={inp} type="number" value={bizPx} onChange={e => setBizPx(e.target.value)} placeholder="900" />
            </div>
            <div>
              <label style={lbl}>First $</label>
              <input style={inp} type="number" value={firPx} onChange={e => setFirPx(e.target.value)} placeholder="1800" />
            </div>
            <div>
              <label style={lbl}>Condition %</label>
              <input style={inp} type="number" value={condition} onChange={e => setCondition(e.target.value)} min="0" max="100" />
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <label style={lbl}>Cabin Profile</label>
              <select style={inp} value={cpId} onChange={e => setCpId(e.target.value)}>
                <option value="">— Manual input —</option>
                {cabinProfiles.map(cp => (
                  <option key={cp.id} value={cp.id}>
                    {cp.name} ({cp.aircraft_type_name || 'unknown type'} · {cp.total_capacity} seats)
                  </option>
                ))}
              </select>
              {selectedCp && (
                <div style={{ marginTop: 4, fontSize: 11, color: '#6b7280', display: 'flex', gap: 10 }}>
                  {selectedCp.classes?.map(c => (
                    <span key={c.class_type}>
                      <b>{c.class_type.charAt(0).toUpperCase() + c.class_type.slice(1)}:</b> {c.actual_capacity}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {!cpId && (<>
              <div>
                <label style={lbl}>Eco Seats</label>
                <input style={inp} type="number" value={ecoCap} onChange={e => setEcoCap(e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Biz Seats</label>
                <input style={inp} type="number" value={bizCap} onChange={e => setBizCap(e.target.value)} />
              </div>
              <div>
                <label style={lbl}>First Seats</label>
                <input style={inp} type="number" value={firCap} onChange={e => setFirCap(e.target.value)} />
              </div>
            </>)}
            <div>
              <label style={lbl}>Service Profile</label>
              <select style={inp} value={spId} onChange={e => setSpId(e.target.value)}>
                <option value="">None</option>
                {serviceProfiles.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
              </select>
            </div>
          </div>
          <button onClick={calculate} disabled={loading || !dep || !arr} style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 5, padding: '8px 22px', fontWeight: 700, fontSize: 13, cursor: 'pointer', opacity: (!dep || !arr) ? 0.5 : 1 }}>
            {loading ? 'Calculating…' : 'Calculate'}
          </button>
          {err && <div style={{ marginTop: 8, color: '#dc2626', fontSize: 12 }}>{err}</div>}

          {result && (
            <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {/* Route info */}
              <div style={{ gridColumn: '1 / -1', background: '#1e293b', color: '#fff', borderRadius: 6, padding: '8px 14px', fontSize: 12, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                <span><b>{result.route.dep}</b> {result.route.dep_name} → <b>{result.route.arr}</b> {result.route.arr_name}</span>
                <span>📏 {result.route.dist_km.toLocaleString()} km</span>
                <span>🏢 Cat {result.route.dep_cat} → Cat {result.route.arr_cat}</span>
              </div>

              {/* Market prices */}
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '10px 14px' }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: '#166534', marginBottom: 6 }}>Market Prices</div>
                {[['Economy', result.market_prices.eco, parseFloat(ecoPx)],
                  ['Business', result.market_prices.biz, parseFloat(bizPx)],
                  ['First', result.market_prices.first, parseFloat(firPx)]].map(([cls, mkt, px]) => (
                  <div key={cls} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                    <span style={{ color: '#555' }}>{cls}</span>
                    <span>
                      <b style={{ color: '#166534' }}>${mkt.toLocaleString()}</b>
                      {px > 0 && <span style={{ color: px > mkt ? '#dc2626' : '#2563eb', marginLeft: 6 }}>
                        (your: ${px.toLocaleString()} = {pct(px, mkt)})
                      </span>}
                    </span>
                  </div>
                ))}
              </div>

              {/* Attractiveness */}
              <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, padding: '10px 14px' }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: '#92400e', marginBottom: 6 }}>Price Attractiveness</div>
                {[['Economy', result.attractiveness.eco],
                  ['Business', result.attractiveness.biz],
                  ['First', result.attractiveness.fir]].map(([cls, v]) => (
                  <div key={cls} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                    <span style={{ color: '#555' }}>{cls}</span>
                    <span style={{ fontWeight: 700, color: attrColor(v) }}>
                      {v !== null ? v.toFixed(2) : '—'} — {attrLabel(v)}
                    </span>
                  </div>
                ))}
              </div>

              {/* Factors */}
              <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '10px 14px' }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: '#1e40af', marginBottom: 6 }}>Demand Factors</div>
                {[
                  ['Base demand/hr', result.factors.base_demand_per_hr],
                  ['Dist modifier', result.factors.dist_mod],
                  ['Apt premium', result.factors.airport_premium],
                  ['Service (Eco)', result.factors.service_factor_eco],
                  ['Service (Biz)', result.factors.service_factor_biz],
                  ['Service (Fir)', result.factors.service_factor_fir],
                  ['Condition factor', result.factors.cond_factor],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                    <span style={{ color: '#555' }}>{k}</span>
                    <b>{typeof v === 'number' ? v.toFixed(2) : v}</b>
                  </div>
                ))}
              </div>

              {/* Booking rate */}
              <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 6, padding: '10px 14px' }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: '#6d28d9', marginBottom: 6 }}>Bookings / Hour</div>
                {[['Economy', result.bookings_per_hr.eco],
                  ['Business', result.bookings_per_hr.biz],
                  ['First', result.bookings_per_hr.fir]].map(([cls, v]) => (
                  <div key={cls} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                    <span style={{ color: '#555' }}>{cls}</span>
                    <b>{v} pax/hr</b>
                  </div>
                ))}
              </div>

              {/* 72h forecast */}
              <div style={{ gridColumn: '1 / -1', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, padding: '10px 14px' }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: '#2C2C2C', marginBottom: 8 }}>72h Booking Window Forecast</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr) 1fr', gap: 8, marginBottom: 10 }}>
                  {[['Economy', result.expected_72h.eco, result.capacity.eco, parseFloat(ecoPx)],
                    ['Business', result.expected_72h.biz, result.capacity.biz, parseFloat(bizPx)],
                    ['First', result.expected_72h.fir, result.capacity.fir, parseFloat(firPx)],
                    ['TOTAL', result.expected_72h.total, result.capacity.total, null]].map(([cls, exp, cap, px]) => (
                    <div key={cls} style={{ textAlign: 'center', background: '#f9fafb', borderRadius: 5, padding: '8px 4px' }}>
                      <div style={{ fontSize: 10, color: '#666', fontWeight: 600 }}>{cls}</div>
                      <div style={{ fontSize: 18, fontWeight: 900, color: '#2C2C2C' }}>{exp}</div>
                      <div style={{ fontSize: 10, color: '#888' }}>/ {cap} seats</div>
                      {px > 0 && <div style={{ fontSize: 10, color: '#16a34a', fontWeight: 600 }}>${(exp * px).toLocaleString()}</div>}
                    </div>
                  ))}
                </div>
                {/* Load factor bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 12, color: '#555', whiteSpace: 'nowrap' }}>Load Factor</span>
                  <div style={{ flex: 1, height: 12, background: '#e5e7eb', borderRadius: 6, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${result.load_factor_pct}%`, background: result.load_factor_pct >= 70 ? '#16a34a' : result.load_factor_pct >= 40 ? '#d97706' : '#dc2626', borderRadius: 6, transition: 'width 0.4s' }} />
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 900, color: '#2C2C2C', whiteSpace: 'nowrap' }}>{result.load_factor_pct}%</span>
                </div>
                <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span style={{ color: '#555' }}>Expected Revenue (72h)</span>
                  <b style={{ color: '#16a34a', fontFamily: 'monospace' }}>${result.expected_revenue.toLocaleString()}</b>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Passenger satisfaction helpers ──────────────────────────────────────────

function App() {
  const [user, setUser] = useState(null);
  const [airlines, setAirlines] = useState([]);
  const [activeAirline, setActiveAirline] = useState(null);
  const [showRegister, setShowRegister] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showChangeModal, setShowChangeModal] = useState(false);
  const [currentPage, setCurrentPage] = useState('dashboard');
  const [previousPage, setPreviousPage] = useState('dashboard');
  const [selectedAircraftId, setSelectedAircraftId] = useState(null);
  const [selectedAirportCode, setSelectedAirportCode] = useState(null);
  const [airportReturnPage, setAirportReturnPage] = useState('routes');
  const [hubsBackPage, setHubsBackPage] = useState('dashboard');
  const [loading, setLoading] = useState(true);
  const [airlineStats, setAirlineStats] = useState({ destinations_count: 0, hubs: [], weekly_revenue: 0, avg_satisfaction: null, daily_passengers: 0, total_passengers: 0 });
  const [departures, setDepartures] = useState([]);
  const [arrivals, setArrivals] = useState([]);
  const [fleetSummary, setFleetSummary] = useState([]);
  const [activeRoutes, setActiveRoutes] = useState([]);
  const [levelUpNotif, setLevelUpNotif] = useState(null);
  const [showLevelPopup, setShowLevelPopup] = useState(false);
  const [nextLevelAircraft, setNextLevelAircraft] = useState([]);

  useEffect(() => {
    const savedUser = localStorage.getItem('user');
    if (savedUser) {
      setUser(JSON.parse(savedUser));
      fetchAllAirlines();
    } else {
      setLoading(false);
    }
  }, []);

  const fetchAllAirlines = async () => {
    const token = localStorage.getItem('token');
    if (!token) { setLoading(false); return; }
    try {
      const res = await fetch(`${API_URL}/api/airline/all`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      const list = data.airlines || [];
      setAirlines(list);
      setActiveAirline(list.find(a => a.is_active) || null);
    } catch (err) {
      console.error('Failed to fetch airlines:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectAirline = async (airlineId) => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/airline/select/${airlineId}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        // Clear all airline-specific state before loading new airline
        setDepartures([]);
        setArrivals([]);
        setFleetSummary([]);
        setActiveRoutes([]);
        setAirlineStats({ destinations_count: 0, hubs: [], weekly_revenue: 0, avg_satisfaction: null, daily_passengers: 0, total_passengers: 0 });
        setCurrentPage('dashboard');
        await fetchAllAirlines();
      }
    } catch (err) {
      console.error('Failed to select airline:', err);
    }
  };

  const handleLogin = async (userData) => {
    setUser(userData);
    await fetchAllAirlines();
  };

  const handleRegister = (userData) => {
    setUser(userData);
    setAirlines([]);
    setActiveAirline(null);
    setLoading(false);
  };

  const handleAirlineCreated = async () => {
    setShowCreateForm(false);
    await fetchAllAirlines();
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
    setAirlines([]);
    setActiveAirline(null);
    setCurrentPage('dashboard');
  };

  const handleBalanceUpdate = (newBalance) => {
    setActiveAirline(prev => prev ? { ...prev, balance: newBalance } : null);
    setAirlines(prev => prev.map(a =>
      a.id === activeAirline?.id ? { ...a, balance: newBalance } : a
    ));
  };

  // Fetch aircraft unlocking at next level when popup opens
  useEffect(() => {
    if (!showLevelPopup || !activeAirline) return;
    const nextLvl = Math.min(15, (activeAirline.level || 1) + 1);
    const token = localStorage.getItem('token');
    fetch(`${API_URL}/api/aircraft/types`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => setNextLevelAircraft((data.aircraft_types || []).filter(t => t.required_level === nextLvl)))
      .catch(() => setNextLevelAircraft([]));
  }, [showLevelPopup, activeAirline?.level]);

  // Poll XP/level every 30s while an airline is active
  useEffect(() => {
    if (!activeAirline) return;
    const token = localStorage.getItem('token');
    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/api/airline/xp`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const { level, total_points } = await res.json();
        setActiveAirline(prev => {
          if (!prev) return prev;
          if (level > prev.level) setLevelUpNotif({ newLevel: level });
          return { ...prev, level, total_points };
        });
        setAirlines(prev => prev.map(a =>
          a.id === activeAirline.id ? { ...a, level, total_points } : a
        ));
      } catch { /* ignore */ }
    };
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, [activeAirline?.id]);

  useEffect(() => {
    if (!activeAirline) { setDepartures([]); setArrivals([]); setFleetSummary([]); setAirlineStats({ destinations_count: 0, hubs: [], weekly_revenue: 0, avg_satisfaction: null, daily_passengers: 0, total_passengers: 0 }); setActiveRoutes([]); return; }
    const token = localStorage.getItem('token');
    const h = { 'Authorization': `Bearer ${token}` };
    Promise.all([
      fetch(`${API_URL}/api/airline/departures`, { headers: h }).then(r => r.json()),
      fetch(`${API_URL}/api/airline/arrivals`, { headers: h }).then(r => r.json()),
      fetch(`${API_URL}/api/airline/fleet-summary`, { headers: h }).then(r => r.json()),
      fetch(`${API_URL}/api/airline/stats`, { headers: h }).then(r => r.json()),
      fetch(`${API_URL}/api/airline/active-routes`, { headers: h }).then(r => r.json()),
    ]).then(([dep, arr, fleet, stats, routesData]) => {
      setDepartures(dep.flights || []);
      setArrivals(arr.flights || []);
      setFleetSummary(fleet.fleet || []);
      setAirlineStats({ destinations_count: stats.destinations_count || 0, hubs: stats.hubs || [], weekly_revenue: stats.weekly_revenue || 0, avg_satisfaction: stats.avg_satisfaction ?? null, daily_passengers: stats.daily_passengers || 0, total_passengers: stats.total_passengers || 0 });
      setActiveRoutes(routesData.routes || []);
    }).catch(() => {});
  }, [activeAirline?.id]);

  // Loading state
  if (loading) {
    return (
      <div className="app">
        <div className="container">
          <div className="header">
            <h1>Aviation Empire</h1>
            <p className="subtitle">Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  // Auth screens
  if (!user) {
    if (showRegister) {
      return <Register onRegister={handleRegister} onSwitchToLogin={() => setShowRegister(false)} />;
    }
    return <Login onLogin={handleLogin} onSwitchToRegister={() => setShowRegister(true)} />;
  }

  const PAGE_LABELS = {
    dashboard: 'Dashboard',
    fleet: 'Fleet',
    flights: 'Flight Operations',
    'flight-schedule': 'Flugplan',
    finances: 'Finances',
    routes: 'Route Planning',
    hubs: 'Network',
    'service-profiles': 'Service Profiles',
    'cabin-profiles': 'Cabin Profiles',
    personnel: 'Personnel',
    marketplace: 'Marketplace',
    'airport-overview': 'Airport Overview',
  };

  const navigate = (page) => {
    if (page === 'hubs') setHubsBackPage(currentPage);
    setPreviousPage(currentPage);
    setCurrentPage(page);
  };

  const navigateToAirport = (code, fromPage = 'routes') => {
    setSelectedAirportCode(code);
    setAirportReturnPage(fromPage);
    setCurrentPage('airport');
  };

  // Sub-pages — all use activeAirline
  if (currentPage === 'airport' && selectedAirportCode) {
    return (
      <AirportPage
        code={selectedAirportCode}
        onBack={() => setCurrentPage(airportReturnPage)}
        onNavigateToAirport={(code) => navigateToAirport(code, airportReturnPage)}
        airline={activeAirline}
        onBalanceUpdate={handleBalanceUpdate}
      />
    );
  }
  if (currentPage === 'aircraft-detail' && selectedAircraftId) {
    return (
      <ErrorBoundary>
        <AircraftDetail
          aircraftId={selectedAircraftId}
          airline={activeAirline}
          onBack={() => { setSelectedAircraftId(null); setCurrentPage('fleet'); }}
          onNavigateToAirport={(code) => navigateToAirport(code, 'fleet')}
        />
      </ErrorBoundary>
    );
  }
  if (currentPage === 'fleet') {
    return (
      <FleetPage
        airline={activeAirline}
        onBack={() => setCurrentPage('dashboard')}
        onSelectAircraft={(id) => { setSelectedAircraftId(id); setCurrentPage('aircraft-detail'); }}
        onOpenMarketplace={() => setCurrentPage('marketplace')}
        onNavigateToAirport={(code) => navigateToAirport(code, 'fleet')}
        onNavigate={(page) => navigate(page)}
      />
    );
  }
  if (currentPage === 'marketplace') {
    return (
      <AircraftMarketplace
        airline={activeAirline}
        onBalanceUpdate={handleBalanceUpdate}
        onBack={() => setCurrentPage('fleet')}
      />
    );
  }
  if (currentPage === 'routes') {
    return (
      <RoutePlanner
        airline={activeAirline}
        onBack={() => setCurrentPage(previousPage)}
        backLabel={PAGE_LABELS[previousPage] || 'Dashboard'}
        onNavigateToAirport={(code) => navigateToAirport(code, 'routes')}
        onNavigateToAircraft={(id) => { setPreviousPage('routes'); setSelectedAircraftId(id); setCurrentPage('aircraft-detail'); }}
      />
    );
  }
  if (currentPage === 'flights') {
    return (
      <FlightOperations
        airline={activeAirline}
        onBalanceUpdate={handleBalanceUpdate}
        onBack={() => setCurrentPage('dashboard')}
        onNavigateToAirport={(code) => navigateToAirport(code, 'flights')}
        onNavigateToAircraft={(id) => { setSelectedAircraftId(id); setCurrentPage('aircraft-detail'); }}
        onNavigate={(page) => navigate(page)}
      />
    );
  }
  if (currentPage === 'flight-schedule') {
    return (
      <FlightSchedule
        airline={activeAirline}
        onBack={() => setCurrentPage(previousPage || 'dashboard')}
        onNavigateToAirport={(code) => navigateToAirport(code, 'flight-schedule')}
        onNavigateToAircraft={(id) => { setSelectedAircraftId(id); setCurrentPage('aircraft-detail'); }}
      />
    );
  }
  if (currentPage === 'finances') {
    return <Finances airline={activeAirline} onBack={() => setCurrentPage('dashboard')} onNavigateToAirport={(code) => navigateToAirport(code, 'finances')} />;
  }
  if (currentPage === 'service-profiles') {
    return <ServiceProfiles airline={activeAirline} onBack={() => setCurrentPage(previousPage)} backLabel={PAGE_LABELS[previousPage] || 'Dashboard'} />;
  }
  if (currentPage === 'cabin-profiles') {
    return <CabinProfiles airline={activeAirline} onBack={() => setCurrentPage(previousPage)} backLabel={PAGE_LABELS[previousPage] || 'Dashboard'} />;
  }
  if (currentPage === 'hubs') {
    return <HubsDestinations airline={activeAirline} onBack={() => setCurrentPage(hubsBackPage)} backLabel={PAGE_LABELS[hubsBackPage] || 'Dashboard'} onNavigateToAirport={(code) => navigateToAirport(code, 'hubs')} onBalanceUpdate={handleBalanceUpdate} onNavigate={(page) => navigate(page)} />;
  }
  if (currentPage === 'airport-overview') {
    return <AirportOverview airline={activeAirline} onBack={() => setCurrentPage(previousPage)} backLabel={PAGE_LABELS[previousPage] || 'Flight Operations'} onNavigateToAirport={(code) => navigateToAirport(code, 'airport-overview')} onBalanceUpdate={handleBalanceUpdate} />;
  }
  if (currentPage === 'personnel') {
    return <Personnel airline={activeAirline} onBack={() => setCurrentPage('dashboard')} />;
  }
  if (currentPage === 'edit-profile') {
    return (
      <EditProfile
        user={user}
        onBack={() => setCurrentPage('dashboard')}
        onLogout={handleLogout}
        onAirlinesChanged={fetchAllAirlines}
      />
    );
  }
  if (currentPage === 'route-map') {
    return (
      <RouteMap
        airline={activeAirline}
        onBack={() => setCurrentPage('dashboard')}
      />
    );
  }

  const closeChangeModal = () => { setShowChangeModal(false); setShowCreateForm(false); };

  function formatBoardTime(dt) {
    if (!dt) return '—';
    return new Date(String(dt).replace(' ', 'T')).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin'
    });
  }
  function boardDayKey(dt) {
    if (!dt) return '';
    return new Date(String(dt).replace(' ', 'T')).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  }
  function boardDayLabel(dt) {
    if (!dt) return '';
    const d = new Date(String(dt).replace(' ', 'T'));
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Berlin' });
  }
  function groupByDay(flights, timeKey, statusFn) {
    const items = [];
    let lastDay = null;
    for (const f of flights) {
      if (statusFn && statusFn(f) === null) continue;
      const dayKey = boardDayKey(f[timeKey]);
      if (dayKey !== lastDay) {
        items.push({ _sep: true, label: boardDayLabel(f[timeKey]), key: `sep-${dayKey}` });
        lastDay = dayKey;
      }
      items.push(f);
    }
    return items;
  }

  function StatusDots({ cls, label }) {
    const isBlinking = cls === 'board' || cls === 'ontime';
    const isYellow   = cls === 'arr';
    const dotColor   = isYellow ? '#facc15' : isBlinking ? '#facc15' : 'rgba(255,255,255,0.25)';
    const textColor  = isYellow ? '#facc15' : isBlinking ? '#facc15' : 'rgba(255,255,255,0.45)';
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
        {label && <span style={{ fontSize: '0.78rem', color: textColor, fontWeight: 500, whiteSpace: 'nowrap' }}>{label}</span>}
        <span className={isBlinking ? 'hp-dot-blink-a' : undefined}
          style={{ width: 7, height: 7, borderRadius: '50%', display: 'inline-block', flexShrink: 0, background: dotColor }} />
        <span className={isBlinking ? 'hp-dot-blink-b' : undefined}
          style={{ width: 7, height: 7, borderRadius: '50%', display: 'inline-block', flexShrink: 0, background: dotColor }} />
      </span>
    );
  }

  function getDepStatus(f) {
    const now = Date.now();
    const dep = new Date(f.departure_time).getTime();
    const diffMin = (dep - now) / 60000;
    if (diffMin > 60)   return { label: 'Scheduled', cls: 'sched' };
    if (diffMin > 30)   return { label: 'On Time',   cls: 'ontime' };
    if (diffMin > 3)    return { label: 'Boarding',  cls: 'board' };
    if (diffMin >= 0)   return { label: 'Taxiing',   cls: 'board' };
    if (diffMin >= -1)  return { label: 'Departed',  cls: 'arr' };
    return null;
  }
  function getArrStatus(f) {
    const now = Date.now();
    const dep = f.departure_time ? new Date(f.departure_time).getTime() : null;
    const arr = new Date(f.arrival_time).getTime();
    const diffToArr = (arr - now) / 60000;
    if (dep && now < dep)   return { label: 'Scheduled', cls: 'sched' };
    if (diffToArr > 5)      return { label: 'In Flight', cls: 'sched' };
    if (diffToArr >= 0)     return { label: 'Approach',  cls: 'board' };
    if (diffToArr >= -1)    return { label: 'Landed',    cls: 'arr' };
    return null;
  }

  return (
    <div className="app">

      {/* ── Level-up toast ── */}
      {levelUpNotif && (
        <div style={{
          position: 'fixed', bottom: '2rem', right: '2rem', zIndex: 9999,
          background: '#2C2C2C', color: '#fff', borderRadius: '10px',
          padding: '1rem 1.5rem', boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
          display: 'flex', alignItems: 'center', gap: '12px', minWidth: 260,
          animation: 'fadeInUp 0.3s ease',
        }}>
          <div style={{ fontSize: '2rem', lineHeight: 1 }}>🏆</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '1rem' }}>Level Up!</div>
            <div style={{ fontSize: '0.85rem', color: '#ccc', marginTop: 2 }}>
              You reached <strong style={{ color: '#fff' }}>Level {levelUpNotif.newLevel}</strong>
            </div>
          </div>
          <button
            onClick={() => setLevelUpNotif(null)}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }}
          >×</button>
        </div>
      )}

      {/* ── Level Popup ── */}
      {showLevelPopup && activeAirline && (() => {
        const XP_THRESH = [0, 1000, 3500, 8500, 18500, 36500, 66500, 111500, 176500, 266500, 386500, 546500, 756500, 1036500, 1406500];
        const lvl       = Math.max(1, Math.min(15, activeAirline.level || 1));
        const xp        = activeAirline.total_points || 0;
        const isMax     = lvl >= 15;
        const nextThresh = isMax ? XP_THRESH[14] : XP_THRESH[lvl];
        const prevThresh = XP_THRESH[lvl - 1] || 0;
        const progress  = isMax ? 1 : Math.min(1, (xp - prevThresh) / Math.max(1, nextThresh - prevThresh));
        const nextLvl   = Math.min(15, lvl + 1);
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
               onClick={() => setShowLevelPopup(false)}>
            <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 500, padding: '2rem', boxShadow: '0 8px 40px rgba(0,0,0,0.2)' }}
                 onClick={e => e.stopPropagation()}>
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                <div>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#999' }}>Progression</div>
                  <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#2C2C2C', lineHeight: 1.1 }}>Level {lvl}</div>
                </div>
                <button onClick={() => setShowLevelPopup(false)}
                  style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: '#999', lineHeight: 1 }}>×</button>
              </div>

              {/* XP bar */}
              <div style={{ marginBottom: '1.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: '#666', marginBottom: 6 }}>
                  <span>{xp.toLocaleString()} XP earned</span>
                  <span>{isMax ? 'MAX LEVEL' : `${nextThresh.toLocaleString()} XP to reach Level ${nextLvl}`}</span>
                </div>
                <div style={{ height: 10, background: '#F0F0F0', borderRadius: 6, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(progress * 100).toFixed(1)}%`, background: '#2C2C2C', borderRadius: 6, transition: 'width 0.4s ease' }} />
                </div>
                {!isMax && (
                  <div style={{ fontSize: '0.75rem', color: '#AAA', marginTop: 4 }}>
                    {Math.max(0, nextThresh - xp).toLocaleString()} XP remaining
                  </div>
                )}
              </div>

              {/* Next unlocks */}
              {!isMax && nextLevelAircraft.length > 0 && (
                <div>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#999', marginBottom: 8 }}>
                    Unlocks at Level {nextLvl}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8 }}>
                    {nextLevelAircraft.map(ac => (
                      <div key={ac.id} style={{ background: '#F5F5F5', borderRadius: 8, overflow: 'hidden', border: '1px solid #E8E8E8' }}>
                        <img src={`/aircraft-images/${ac.image_filename}`} alt=""
                          style={{ width: '100%', height: 52, objectFit: 'cover', display: 'block', background: '#E8E8E8' }}
                          onError={e => { e.target.style.background='#E0E0E0'; e.target.style.display='block'; e.target.src=''; }} />
                        <div style={{ padding: '6px 8px' }}>
                          <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#2C2C2C', lineHeight: 1.2 }}>{ac.full_name}</div>
                          <div style={{ fontSize: '0.68rem', color: '#888', marginTop: 2 }}>{ac.max_passengers} pax · {ac.range_km.toLocaleString()} km</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!isMax && nextLevelAircraft.length === 0 && (
                <div style={{ fontSize: '0.8rem', color: '#AAA', textAlign: 'center', padding: '1rem 0' }}>No new aircraft at next level.</div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ── Hero banner ── */}
      <div className="page-hero">
        <div className="page-hero-overlay">
          <h1>Aviation Empire</h1>
        </div>
      </div>

      <div className="hp-container">

        {/* ── Info strip ── */}
        <div className="hp-info-strip">
          <div className="hp-identity">
            {activeAirline ? (
              <>
                <span className="hp-code">{activeAirline.airline_code}</span>
                <div className="hp-id-text">
                  <div className="hp-airline-name">{activeAirline.name}</div>
                  <div className="hp-airline-sub">Welcome, {user.username}</div>
                </div>
              </>
            ) : (
              <>
                <span className="hp-code" style={{ color: '#CCCCCC' }}>—</span>
                <div className="hp-id-text">
                  <div className="hp-airline-name">No Airline Selected</div>
                  <div className="hp-airline-sub">Welcome, {user.username}</div>
                </div>
              </>
            )}
          </div>
          <div className="hp-strip-actions">
            <button className="hp-btn-change" onClick={() => setShowChangeModal(true)}>
              {airlines.length === 0 ? '+ Create Airline' : 'Change Airline'}
            </button>
            <button className="hp-btn-logout-strip" onClick={() => setCurrentPage('edit-profile')}>Edit Profile</button>
            <button className="hp-btn-logout-strip" onClick={handleLogout}>Logout</button>
          </div>
        </div>

        {/* ── Active airline content ── */}
        {activeAirline ? (
          <>
            {/* Logo + Info row */}
            <div className="hp-content-row">

              {/* Left: map + boards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

                {/* Airline Information Test */}
                <div className="hp-sidebar-card">
                  <div className="hp-sidebar-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>Airline Information Test</span>
                    <button
                      onClick={() => setCurrentPage('flight-schedule')}
                      style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.3)', color: 'rgba(255,255,255,0.7)', padding: '0.22rem 0.65rem', borderRadius: '4px', fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer', letterSpacing: '0.03em' }}
                    >
                      Flightplan
                    </button>
                  </div>
                  {/* Two columns */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1px', background: '#F0F0F0', alignItems: 'stretch' }}>

                    {/* Left column: Logo → Passengers + Progression → Finances → Network */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>

                      {/* Identity card: Section header + Code/Name row + full-width Logo */}
                      <div style={{ background: '#fff', borderBottom: '1px solid #F0F0F0' }}>
                        <div className="hp-it-section-label">Airline</div>
                        {/* Code + Name on one line */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 1.1rem' }}>
                          <span style={{ fontFamily: 'monospace', fontSize: '1.5rem', fontWeight: 700, color: '#2C2C2C', letterSpacing: '0.05em', flexShrink: 0 }}>{activeAirline.airline_code}</span>
                          <span style={{ fontSize: '1rem', fontWeight: 600, color: '#2C2C2C', lineHeight: 1.2 }}>{activeAirline.name}</span>
                        </div>
                        {/* Full-width logo with hover upload */}
                        <label
                          style={{ display: 'block', position: 'relative', cursor: 'pointer', borderTop: '1px solid #F0F0F0' }}
                          title="Upload logo (480 × 120 px)"
                        >
                          {activeAirline.logo_filename
                            ? <img src={activeAirline.logo_filename.startsWith('http') ? activeAirline.logo_filename : `${API_URL}/airline-logos/${activeAirline.logo_filename}`} alt="logo" style={{ display: 'block', width: '100%', height: 'auto', aspectRatio: '4/1', objectFit: 'contain' }} />
                            : <div style={{ aspectRatio: '4/1', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#CCC', fontSize: '0.8rem' }}>Logo hochladen (480 × 120 px)</div>
                          }
                          <div className="ait-logo-hover-overlay">↑ Upload</div>
                          <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" style={{ display: 'none' }}
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              const url = URL.createObjectURL(file);
                              const img = new Image();
                              img.onload = async () => {
                                URL.revokeObjectURL(url);
                                if (img.naturalWidth !== 480 || img.naturalHeight !== 120) {
                                  alert(`Logo muss genau 480 × 120 px sein.\nDieses Bild ist ${img.naturalWidth} × ${img.naturalHeight} px.`);
                                  e.target.value = '';
                                  return;
                                }
                                const form = new FormData();
                                form.append('logo', file);
                                const token = localStorage.getItem('token');
                                const res = await fetch(`${API_URL}/api/airline/logo`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
                                if (res.ok) fetchAllAirlines();
                                e.target.value = '';
                              };
                              img.onerror = () => { URL.revokeObjectURL(url); alert('Datei konnte nicht gelesen werden.'); };
                              img.src = url;
                            }}
                          />
                        </label>
                      </div>

                      {/* Passengers + Progression + Finances + Network */}
                      <div style={{ background: '#fff' }}>
                        <table className="hp-info-table">
                          <tbody>
                            <tr className="hp-it-divider">
                              <td colSpan={2} className="hp-it-section-label">Passengers</td>
                            </tr>
                            <tr>
                              <td className="hp-it-label">Daily</td>
                              <td className="hp-it-val">{(airlineStats.daily_passengers || 0).toLocaleString()}</td>
                            </tr>
                            <tr>
                              <td className="hp-it-label">Total</td>
                              <td className="hp-it-val">{(airlineStats.total_passengers || 0).toLocaleString()}</td>
                            </tr>
                            <tr>
                              <td className="hp-it-label">Satisfaction</td>
                              <td className="hp-it-val">
                                {airlineStats.avg_satisfaction != null
                                  ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                      {scoreToRating(airlineStats.avg_satisfaction)?.toFixed(1)}
                                      <SatisfactionRating score={airlineStats.avg_satisfaction} hideLabel />
                                    </span>
                                  : <span style={{ color: '#aaa', fontFamily: 'inherit', fontWeight: 400 }}>—</span>}
                              </td>
                            </tr>
                            <tr className="hp-it-divider">
                              <td colSpan={2} className="hp-it-section-label">Progression</td>
                            </tr>
                            <tr style={{ cursor: 'pointer' }} onClick={() => setShowLevelPopup(true)}>
                              <td className="hp-it-label">Level</td>
                              <td className="hp-it-val">
                                LVL {activeAirline.level || 1}
                                <span style={{ fontSize: '0.72rem', color: '#888', marginLeft: 6, fontFamily: 'inherit', fontWeight: 400 }}>▸ details</span>
                              </td>
                            </tr>
                            <tr className="hp-it-divider">
                              <td colSpan={2} className="hp-it-section-label">Finances</td>
                            </tr>
                            <tr>
                              <td className="hp-it-label">Balance</td>
                              <td className="hp-it-val">${activeAirline.balance.toLocaleString()}</td>
                            </tr>
                            <tr>
                              <td className="hp-it-label">Weekly Revenue</td>
                              <td className="hp-it-val">${Math.round(airlineStats.weekly_revenue).toLocaleString()}</td>
                            </tr>
                            <tr className="hp-it-divider">
                              <td colSpan={2} className="hp-it-section-label">Network</td>
                            </tr>
                            <tr>
                              <td className="hp-it-label">Home Airport</td>
                              <td className="hp-it-val">
                                <AirportLink
                                  code={activeAirline.home_airport_code}
                                  name={activeAirline.home_airport_name}
                                  onNavigate={(code) => navigateToAirport(code, 'dashboard')}
                                />
                              </td>
                            </tr>
                            <tr>
                              <td className="hp-it-label">Hubs</td>
                              <td className="hp-it-val">
                                {airlineStats.hubs.length === 0
                                  ? '—'
                                  : airlineStats.hubs.length <= 3
                                    ? airlineStats.hubs.map((h, i) => (
                                        <span key={h.code}>
                                          {i > 0 && ', '}
                                          <AirportLink code={h.code} onNavigate={(code) => navigateToAirport(code, 'dashboard')} />
                                        </span>
                                      ))
                                    : `${airlineStats.hubs.length} Airports`}
                              </td>
                            </tr>
                            <tr className="hp-it-last">
                              <td className="hp-it-label">Destinations</td>
                              <td className="hp-it-val">
                                {airlineStats.destinations_count} destination{airlineStats.destinations_count !== 1 ? 's' : ''}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>

                    </div>

                    {/* Right column: Fleet — absolutely positioned so it doesn't affect grid row height */}
                    <div style={{ position: 'relative', overflow: 'hidden' }}>
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#fff' }}>
                      <div className="hp-it-section-label" style={{ flexShrink: 0 }}>Fleet ({activeAirline.fleet_count})</div>
                      <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
                        {fleetSummary.length === 0 ? (
                          <div style={{ padding: '2.5rem 1.1rem', textAlign: 'center', color: '#AAAAAA', fontSize: '0.85rem', fontStyle: 'italic' }}>
                            No aircraft in fleet
                          </div>
                        ) : (
                          <table className="hp-fleet-table">
                            <tbody>
                              {fleetSummary.map((type, i) => (
                                <tr key={i} style={i > 0 && type.manufacturer !== fleetSummary[i - 1].manufacturer ? { borderTop: '2px solid #F0F0F0' } : {}}>
                                  <td>
                                    {type.image_filename && (
                                      <img src={`/aircraft-images/${type.image_filename}`} className="hp-fleet-img" alt={type.full_name} />
                                    )}
                                  </td>
                                  <td className="hp-fleet-name">{type.full_name}</td>
                                  <td className="hp-fleet-count">{type.count}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                      </div>
                    </div>

                  </div>

                  {/* Routes map — full width below both columns */}
                  <div style={{ background: '#fff', borderTop: '1px solid #F0F0F0', overflow: 'hidden' }}>
                    <div className="hp-it-section-label" style={{ padding: '6px 1.1rem' }}>Routes</div>
                    <RoutePreviewMap routes={activeRoutes} />
                  </div>

                </div>

              </div>

              {/* Right: Manage navigation */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div className="info-card" style={{ padding: 0, overflow: 'hidden', marginBottom: 0 }}>
                  <div style={{ background: '#2C2C2C', padding: '14px 20px', borderRadius: '8px 8px 0 0' }}>
                    <span className="card-header-bar-title">Manage {activeAirline.name}</span>
                  </div>
                  <div className="fo-nav-list">
                    {[
                      { label: 'Fleet Management', page: 'fleet'      },
                      { label: 'Flight Operations', page: 'flights'   },
                      { label: 'Finances',          page: 'finances'  },
                      { label: 'Personnel',         page: 'personnel' },
                    ].map(({ label, page }) => (
                      <button key={page} className="fo-nav-btn" onClick={() => setCurrentPage(page)}>
                        {label}
                        <span className="fo-nav-arrow">›</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

            </div>

            {/* Departures + Arrivals boards — full width below the content row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1.5rem' }}>
              <div className="hp-board-wrap">
                <div className="hp-board-titlebar hp-board-dep">
                  <img src="/icon/icon_departures.png" alt="" style={{ width: 18, height: 18, objectFit: 'contain', flexShrink: 0 }} />
                  <span>NEXT DEPARTURES</span>
                </div>
                {departures.length === 0 ? (
                  <div className="hp-board-empty">No upcoming departures</div>
                ) : (
                  <table className="hp-board-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Route</th>
                        <th>Type</th>
                        <th>Flight</th>
                        <th style={{ textAlign: 'right' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupByDay(departures, 'departure_time', getDepStatus).map((item, i) =>
                        item._sep ? (
                          <tr key={item.key} className="hp-day-sep-row">
                            <td colSpan={5} className="hp-day-sep-cell">{item.label}</td>
                          </tr>
                        ) : (
                          <tr key={item.flight_number + item.departure_time}>
                            <td className="hp-board-time">{formatBoardTime(item.departure_time)}</td>
                            <td className="hp-board-apt">
                              <AirportLink code={item.departure_airport} onNavigate={(code) => navigateToAirport(code, 'dashboard')} /> – <AirportLink code={item.arrival_airport} onNavigate={(code) => navigateToAirport(code, 'dashboard')} />
                            </td>
                            <td className="hp-board-type">{item.aircraft_type}</td>
                            <td className="hp-board-fn">{item.flight_number}</td>
                            <td style={{ textAlign: 'right' }}>{(() => { const s = getDepStatus(item); return <StatusDots cls={s.cls} label={s.label} />; })()}</td>
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="hp-board-wrap">
                <div className="hp-board-titlebar hp-board-arr">
                  <img src="/icon/icon_landing.png" alt="" style={{ width: 18, height: 18, objectFit: 'contain', flexShrink: 0 }} />
                  <span>NEXT ARRIVALS</span>
                </div>
                {arrivals.length === 0 ? (
                  <div className="hp-board-empty">No upcoming arrivals</div>
                ) : (
                  <table className="hp-board-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Route</th>
                        <th>Type</th>
                        <th>Flight</th>
                        <th style={{ textAlign: 'right' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupByDay(arrivals, 'arrival_time', getArrStatus).map((item, i) =>
                        item._sep ? (
                          <tr key={item.key} className="hp-day-sep-row">
                            <td colSpan={5} className="hp-day-sep-cell">{item.label}</td>
                          </tr>
                        ) : (
                          <tr key={item.flight_number + item.arrival_time}>
                            <td className="hp-board-time">{formatBoardTime(item.arrival_time)}</td>
                            <td className="hp-board-apt">
                              <AirportLink code={item.departure_airport} onNavigate={(code) => navigateToAirport(code, 'dashboard')} /> – <AirportLink code={item.arrival_airport} onNavigate={(code) => navigateToAirport(code, 'dashboard')} />
                            </td>
                            <td className="hp-board-type">{item.aircraft_type}</td>
                            <td className="hp-board-fn">{item.flight_number}</td>
                            <td style={{ textAlign: 'right' }}>{(() => { const s = getArrStatus(item); return <StatusDots cls={s.cls} label={s.label} />; })()}</td>
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* ⚠️ DEV PANEL — DELETE BEFORE RELEASE */}
            <DevRouteCalc />
            <div style={{
              marginTop: '0.5rem', padding: '16px 20px',
              background: '#fff0f0', border: '2px solid #dc2626', borderRadius: 8,
              display: 'flex', alignItems: 'center', gap: 16,
            }}>
              <span style={{ color: '#dc2626', fontWeight: 700, fontSize: 13 }}>⚠ DEV</span>
              <button
                style={{
                  background: '#1a6dc4', color: '#fff', border: 'none', borderRadius: 6,
                  padding: '8px 18px', fontWeight: 600, fontSize: 14, cursor: 'pointer',
                }}
                onClick={() => setCurrentPage('route-map')}
              >
                Route Map
              </button>
              <button
                style={{
                  background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6,
                  padding: '8px 18px', fontWeight: 600, fontSize: 14, cursor: 'pointer',
                }}
                onClick={async () => {
                  const token = localStorage.getItem('token');
                  const res = await fetch(`${API_URL}/api/airline/dev/add-money`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ amount: 10_000_000 }),
                  });
                  const data = await res.json();
                  if (data.new_balance != null) handleBalanceUpdate(data.new_balance);
                }}
              >
                + $10,000,000
              </button>
              <button
                style={{
                  background: '#b45309', color: '#fff', border: 'none', borderRadius: 6,
                  padding: '8px 18px', fontWeight: 600, fontSize: 14, cursor: 'pointer',
                }}
                onClick={async () => {
                  const token = localStorage.getItem('token');
                  const res = await fetch(`${API_URL}/api/aircraft/dev/fill-market`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` },
                  });
                  const data = await res.json();
                  alert(data.message || data.error);
                }}
              >
                Fill Market
              </button>
              <button
                style={{
                  background: '#6b7280', color: '#fff', border: 'none', borderRadius: 6,
                  padding: '8px 18px', fontWeight: 600, fontSize: 14, cursor: 'pointer',
                }}
                onClick={async () => {
                  const token = localStorage.getItem('token');
                  const res = await fetch(`${API_URL}/api/aircraft/dev/clear-market`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` },
                  });
                  const data = await res.json();
                  alert(data.message || data.error);
                }}
              >
                Clear Market
              </button>
              <button
                style={{
                  background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6,
                  padding: '8px 18px', fontWeight: 600, fontSize: 14, cursor: 'pointer',
                }}
                onClick={async () => {
                  const token = localStorage.getItem('token');
                  const res = await fetch(`${API_URL}/api/airline/dev/add-points`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ amount: 10_000 }),
                  });
                  const data = await res.json();
                  if (data.total_points != null) {
                    setActiveAirline(prev => prev ? { ...prev, total_points: data.total_points, level: data.level } : prev);
                    setAirlines(prev => prev.map(a => a.id === activeAirline?.id ? { ...a, total_points: data.total_points, level: data.level } : a));
                  }
                }}
              >
                + 10,000 XP
              </button>
            </div>

          </>
        ) : (
          <div className="hp-no-airline">
            <h2>Get Started</h2>
            <p>
              {airlines.length === 0
                ? 'Create your first airline to begin your aviation empire.'
                : 'Select an airline to get started.'}
            </p>
            <button className="btn-primary" style={{ padding: '12px 28px' }} onClick={() => setShowChangeModal(true)}>
              {airlines.length === 0 ? 'Create Your First Airline' : 'Select Airline'}
            </button>
          </div>
        )}

      </div>

      {/* ── Change Airline Modal ── */}
      {showChangeModal && (
        <div className="hp-modal-backdrop" onClick={closeChangeModal}>
          <div className="hp-modal" onClick={e => e.stopPropagation()}>
            <div className="hp-modal-header">
              <span className="hp-modal-title">
                {showCreateForm ? 'Create New Airline' : 'Change Airline'}
              </span>
              <button className="hp-modal-close" onClick={closeChangeModal}>&times;</button>
            </div>
            <div className="hp-modal-body">
              {!showCreateForm ? (
                <>
                  {airlines.map(al => (
                    <div
                      key={al.id}
                      className={`hp-al-card${al.is_active ? ' hp-al-active' : ''}`}
                      onClick={() => { if (!al.is_active) { handleSelectAirline(al.id); closeChangeModal(); } }}
                    >
                      <div className="hp-al-card-left">
                        <span className="hp-al-card-code">{al.airline_code}</span>
                        <div className="hp-al-card-info">
                          <div className="hp-al-card-name">{al.name}</div>
                          <div className="hp-al-card-detail">
                            ${al.balance.toLocaleString()} · {al.fleet_count} aircraft · {al.home_airport_code}
                          </div>
                        </div>
                      </div>
                      {al.is_active && <span className="hp-al-card-badge">Active</span>}
                    </div>
                  ))}
                  {airlines.length < 3 && (
                    <div className="hp-create-card" onClick={() => setShowCreateForm(true)}>
                      <span className="hp-create-icon">+</span>
                      <span>Create New Airline</span>
                    </div>
                  )}
                </>
              ) : (
                <CreateAirlineForm
                  onCreated={() => { handleAirlineCreated(); closeChangeModal(); }}
                  onCancel={() => setShowCreateForm(false)}
                />
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
