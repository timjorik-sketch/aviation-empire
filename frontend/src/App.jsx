import { useState, useEffect, useRef, Component } from 'react';

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
import Landing from './pages/Landing';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import VerifyEmail from './pages/VerifyEmail';
import VerifyEmailBanner from './components/VerifyEmailBanner.jsx';
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
import Leaderboards from './pages/Leaderboards';
import AdminPanel from './pages/AdminPanel';
import AdminPlayers from './pages/AdminPlayers';
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


// ── Passenger satisfaction helpers ──────────────────────────────────────────

function App() {
  const [user, setUser] = useState(null);
  const [airlines, setAirlines] = useState([]);
  const [activeAirline, setActiveAirline] = useState(null);
  const [showForgot, setShowForgot] = useState(false);
  const [resetToken, setResetToken] = useState(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    return params.get('reset_token');
  });
  const [verifyToken, setVerifyToken] = useState(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    return params.get('verify_token');
  });
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showChangeModal, setShowChangeModal] = useState(false);
  const [currentPage, setCurrentPage] = useState('dashboard');
  const [previousPage, setPreviousPage] = useState('dashboard');
  const [selectedAircraftId, setSelectedAircraftId] = useState(null);
  const [selectedAirportCode, setSelectedAirportCode] = useState(null);
  const [airportReturnPage, setAirportReturnPage] = useState('routes');
  const airportOverviewState = useRef(null);
  const [hubsBackPage, setHubsBackPage] = useState('dashboard');
  const [loading, setLoading] = useState(true);
  const [airlineStats, setAirlineStats] = useState({ destinations_count: 0, hubs: [], home_airport: null, weekly_revenue: 0, avg_satisfaction: null, daily_passengers: 0, total_passengers: 0 });
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
        setAirlineStats({ destinations_count: 0, hubs: [], home_airport: null, weekly_revenue: 0, avg_satisfaction: null, daily_passengers: 0, total_passengers: 0 });
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
    if (!activeAirline) { setDepartures([]); setArrivals([]); setFleetSummary([]); setAirlineStats({ destinations_count: 0, hubs: [], home_airport: null, weekly_revenue: 0, avg_satisfaction: null, daily_passengers: 0, total_passengers: 0 }); setActiveRoutes([]); return; }
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
      setAirlineStats({ destinations_count: stats.destinations_count || 0, hubs: stats.hubs || [], home_airport: stats.home_airport || null, weekly_revenue: stats.weekly_revenue || 0, avg_satisfaction: stats.avg_satisfaction ?? null, daily_passengers: stats.daily_passengers || 0, total_passengers: stats.total_passengers || 0 });
      setActiveRoutes(routesData.routes || []);
    }).catch(() => {});
  }, [activeAirline?.id]);

  // Email verification link — works whether the user is logged in or not.
  if (verifyToken) {
    return (
      <VerifyEmail
        token={verifyToken}
        onDone={() => {
          setVerifyToken(null);
          if (typeof window !== 'undefined') {
            const url = new URL(window.location.href);
            url.searchParams.delete('verify_token');
            window.history.replaceState({}, '', url.pathname + (url.search ? url.search : ''));
          }
          // If logged in, refresh cached user from storage so banner disappears
          try {
            const raw = localStorage.getItem('user');
            if (raw) setUser(JSON.parse(raw));
          } catch {}
        }}
      />
    );
  }

  // Loading state
  if (loading) {
    return (
      <div className="app">
        <div className="container">
          <div className="header">
            <img src="/logo/logo_black.png" alt="Apron Empire" className="brand-logo" />
            <p className="subtitle">Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  // Auth screens
  if (!user) {
    if (resetToken) {
      return (
        <ResetPassword
          token={resetToken}
          onDone={() => {
            setResetToken(null);
            // clear ?reset_token= from URL
            if (typeof window !== 'undefined') {
              const url = new URL(window.location.href);
              url.searchParams.delete('reset_token');
              window.history.replaceState({}, '', url.pathname + (url.search ? url.search : ''));
            }
            setShowForgot(false);
          }}
        />
      );
    }
    if (showForgot) {
      return <ForgotPassword onBack={() => setShowForgot(false)} />;
    }
    return (
      <Landing
        onLogin={handleLogin}
        onRegister={handleRegister}
        onForgotPassword={() => setShowForgot(true)}
      />
    );
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
    personnel: 'Staff & Crew',
    marketplace: 'Marketplace',
    'airport-overview': 'Airport Overview',
    leaderboards: 'Leaderboards',
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
    return <Finances airline={activeAirline} onBack={() => setCurrentPage('dashboard')} onNavigateToAirport={(code) => navigateToAirport(code, 'finances')} onNavigateToAircraft={(id) => { setPreviousPage('finances'); setSelectedAircraftId(id); setCurrentPage('aircraft-detail'); }} />;
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
    return <AirportOverview airline={activeAirline} onBack={() => setCurrentPage(previousPage)} backLabel={PAGE_LABELS[previousPage] || 'Flight Operations'} onNavigateToAirport={(code) => navigateToAirport(code, 'airport-overview')} onBalanceUpdate={handleBalanceUpdate} savedState={airportOverviewState} />;
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
  if (currentPage === 'leaderboards') {
    return <Leaderboards airline={activeAirline} onBack={() => setCurrentPage('dashboard')} />;
  }
  if (currentPage === 'admin') {
    return <AdminPanel airline={activeAirline} onBack={() => setCurrentPage('dashboard')} onNavigate={setCurrentPage} />;
  }
  if (currentPage === 'admin-players') {
    return <AdminPlayers airline={activeAirline} onBack={() => setCurrentPage('admin')} />;
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
    if (diffToArr > 5)      return { label: 'In Flight', cls: 'ontime' };
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
                          style={{ width: '100%', aspectRatio: '1000/333', objectFit: 'cover', display: 'block', background: '#E8E8E8' }}
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
      <div
        className="page-hero"
        style={{ backgroundImage: "linear-gradient(rgba(0,0,0,0.35),rgba(0,0,0,0.55)),url('/header-images/Headerimage_Home.png')" }}
      >
        <div className="page-hero-overlay page-hero-overlay--centered">
          <img src="/logo/logo_white.png" alt="Apron Empire" className="page-hero-logo page-hero-logo--large" />
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
            {user?.is_admin && (
              <button className="hp-btn-logout-strip" onClick={() => setCurrentPage('admin')}>Admin</button>
            )}
            <button className="hp-btn-logout-strip" onClick={handleLogout}>Logout</button>
          </div>
        </div>

        <VerifyEmailBanner user={user} />

        {/* ── Active airline content ── */}
        {activeAirline ? (
          <>
            {/* ── Two-column layout: 30% sidebar / 70% main ── */}
            <div className="hp-layout-grid">

              {/* Left column 30%: Airline Information + Fleet + Manage */}
              <div className="hp-left-col">

                {/* Airline Information */}
                <div className="hp-sidebar-card">
                  <div className="hp-sidebar-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>Airline Information</span>
                    <button
                      onClick={() => setCurrentPage('flight-schedule')}
                      style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.3)', color: 'rgba(255,255,255,0.7)', padding: '0.22rem 0.65rem', borderRadius: '4px', fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer', letterSpacing: '0.03em' }}
                    >
                      Flightplan
                    </button>
                  </div>

                  {/* Identity: Code + Name + full-width Logo */}
                  <div style={{ background: '#fff', borderBottom: '1px solid #F0F0F0' }}>
                    <div className="hp-it-section-label">Airline</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 1.1rem' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '1.5rem', fontWeight: 700, color: '#2C2C2C', letterSpacing: '0.05em', flexShrink: 0 }}>{activeAirline.airline_code}</span>
                      <span style={{ fontSize: '1rem', fontWeight: 600, color: '#2C2C2C', lineHeight: 1.2 }}>{activeAirline.name}</span>
                    </div>
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

                {/* Fleet card */}
                <div className="hp-sidebar-card">
                  <div className="hp-sidebar-title">
                    <span>Fleet ({activeAirline.fleet_count})</span>
                  </div>
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

                {/* Manage navigation */}
                <div className="hp-sidebar-card">
                  <div className="hp-sidebar-title">Manage {activeAirline.name}</div>
                  <div className="fo-nav-list">
                    {[
                      { label: 'Fleet Management', page: 'fleet'      },
                      { label: 'Flight Operations', page: 'flights'   },
                      { label: 'Finances',          page: 'finances'  },
                      { label: 'Staff & Crew',      page: 'personnel' },
                      { label: 'Leaderboards',      page: 'leaderboards' },
                    ].map(({ label, page }) => (
                      <button key={page} className="fo-nav-btn" onClick={() => setCurrentPage(page)}>
                        {label}
                        <span className="fo-nav-arrow">›</span>
                      </button>
                    ))}
                  </div>
                </div>

              </div>

              {/* Right column 70%: Routes + Departures + Arrivals */}
              <div className="hp-right-col">

                {/* Routes */}
                <div className="hp-sidebar-card">
                  <div className="hp-sidebar-title">Routes</div>
                  <RoutePreviewMap routes={activeRoutes} hubs={airlineStats.hubs} homeAirport={airlineStats.home_airport} />
                </div>

            {/* Departures + Arrivals boards — within right column */}
            <div className="hp-boards-grid">
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

              </div>
            </div>

          </>
        ) : (
          <div className="hp-no-airline">
            <h2>Get Started</h2>
            <p>
              {airlines.length === 0
                ? 'Create your first airline to begin your Apron Empire.'
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
