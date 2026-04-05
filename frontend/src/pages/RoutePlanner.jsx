import { useState, useEffect } from 'react';
import AirportLink from '../components/AirportLink.jsx';
import TopBar from '../components/TopBar.jsx';
import Toast from '../components/Toast.jsx';
import RoutePreviewMap from '../components/RoutePreviewMap.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatFlightTime(km) {
  const h = Math.floor(km / 900);
  const m = Math.round(((km / 900) - h) * 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function getAnalysisCost(distKm) {
  if (!distKm) return null;
  if (distKm < 3000) return 20000;
  if (distKm <= 7000) return 80000;
  return 180000;
}

function getNextMonday(weekStartStr) {
  if (!weekStartStr) return '';
  const d = new Date(weekStartStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function RatingDot({ rating }) {
  const colors = {
    UNDERPRICED: '#dc2626',
    SLIGHTLY_LOW: '#ea580c',
    COMPETITIVE: '#16a34a',
    SLIGHTLY_HIGH: '#ea580c',
    OVERPRICED: '#dc2626',
    STRONGLY_OVERPRICED: '#7f1d1d',
  };
  const labels = {
    UNDERPRICED: 'Underpriced',
    SLIGHTLY_LOW: 'Slightly Low',
    COMPETITIVE: 'Competitive',
    SLIGHTLY_HIGH: 'Slightly High',
    OVERPRICED: 'Overpriced',
    STRONGLY_OVERPRICED: 'Strongly Overpriced',
  };
  const color = colors[rating] || '#999';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
      <span style={{ color, fontWeight: 600, fontSize: '0.78rem' }}>{labels[rating] || rating}</span>
    </span>
  );
}

function RoutePlanner({ airline, onBack, backLabel = 'Dashboard', onNavigateToAirport, onNavigateToAircraft }) {
  const [routes, setRoutes] = useState([]);
  const [airports, setAirports] = useState([]);
  const [airlineCode, setAirlineCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Create form state
  const [departureAirport, setDepartureAirport] = useState('');
  const [arrivalAirport, setArrivalAirport] = useState('');
  const [flightNumberSuffix, setFlightNumberSuffix] = useState('');
  const [createReturn, setCreateReturn] = useState(false);
  const [returnFlightNumberSuffix, setReturnFlightNumberSuffix] = useState('');
  const [economyPrice, setEconomyPrice] = useState('');
  const [businessPrice, setBusinessPrice] = useState('');
  const [firstPrice, setFirstPrice] = useState('');

  // Market Analysis state
  const [analyses, setAnalyses] = useState([]);
  const [weekUsed, setWeekUsed] = useState(0);
  const [weekLimit, setWeekLimit] = useState(4);
  const [weekStart, setWeekStart] = useState('');
  const [selectedRouteForAnalysis, setSelectedRouteForAnalysis] = useState('');
  const [requestingAnalysis, setRequestingAnalysis] = useState(false);
  const [analysesExpanded, setAnalysesExpanded] = useState(true);

  // Sort state
  const [sortCol, setSortCol] = useState('flight_number');
  const [sortDir, setSortDir] = useState('asc');

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const sortedRoutes = [...routes].sort((a, b) => {
    let av = a[sortCol], bv = b[sortCol];
    if (av == null) av = sortCol === 'distance_km' || sortCol === 'weekly_flights' ? -1 : '';
    if (bv == null) bv = sortCol === 'distance_km' || sortCol === 'weekly_flights' ? -1 : '';
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  // Expand state
  const [expandedId, setExpandedId] = useState(null);
  const [routeAircraft, setRouteAircraft] = useState({}); // { [routeId]: aircraft[] }
  const [loadingAircraft, setLoadingAircraft] = useState({});

  const toggleExpand = async (routeId) => {
    if (expandedId === routeId) { setExpandedId(null); return; }
    setExpandedId(routeId);
    if (routeAircraft[routeId]) return; // already loaded
    setLoadingAircraft(p => ({ ...p, [routeId]: true }));
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/routes/${routeId}/aircraft`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      setRouteAircraft(p => ({ ...p, [routeId]: data.aircraft || [] }));
    } catch { setRouteAircraft(p => ({ ...p, [routeId]: [] })); }
    finally { setLoadingAircraft(p => ({ ...p, [routeId]: false })); }
  };

  // Check Route mode
  const [checkMode, setCheckMode] = useState(false);
  const [checkFleet, setCheckFleet] = useState([]);
  const [checkFleetLoaded, setCheckFleetLoaded] = useState(false);
  const [allAirports, setAllAirports] = useState([]);
  const [allAirportsLoaded, setAllAirportsLoaded] = useState(false);
  const [checkAircraftId, setCheckAircraftId] = useState('');
  const [checkDep, setCheckDep] = useState('');
  const [checkArr, setCheckArr] = useState('');
  const [checkDepData, setCheckDepData] = useState(null);
  const [checkArrData, setCheckArrData] = useState(null);

  const enterCheckMode = async () => {
    setCheckMode(true);
    if (!checkFleetLoaded) {
      const token = localStorage.getItem('token');
      const [fleetRes, airRes] = await Promise.all([
        fetch(`${API_URL}/api/aircraft/fleet`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_URL}/api/airports`),
      ]);
      const fleetData = await fleetRes.json();
      const airData = await airRes.json();
      setCheckFleet(fleetData.fleet || []);
      setAllAirports(airData.airports || []);
      setCheckFleetLoaded(true);
      setAllAirportsLoaded(true);
    }
  };

  useEffect(() => {
    if (!checkDep) { setCheckDepData(null); return; }
    fetch(`${API_URL}/api/airports/${checkDep}`).then(r => r.json())
      .then(d => setCheckDepData(d.airport || null)).catch(() => setCheckDepData(null));
  }, [checkDep]);

  useEffect(() => {
    if (!checkArr) { setCheckArrData(null); return; }
    fetch(`${API_URL}/api/airports/${checkArr}`).then(r => r.json())
      .then(d => setCheckArrData(d.airport || null)).catch(() => setCheckArrData(null));
  }, [checkArr]);

  const checkAircraft = checkFleet.find(a => String(a.id) === checkAircraftId) || null;
  const checkResult = (() => {
    if (!checkAircraft || !checkDepData || !checkArrData) return null;
    const dist = Math.round(haversineKm(checkDepData.latitude, checkDepData.longitude, checkArrData.latitude, checkArrData.longitude));
    const rangeOk = checkAircraft.range_km >= dist;
    const depRunwayOk = (checkDepData.runway_length_m || 0) >= (checkAircraft.min_runway_takeoff_m || 0);
    const arrRunwayOk = (checkArrData.runway_length_m || 0) >= (checkAircraft.min_runway_landing_m || 0);
    return { dist, rangeOk, depRunwayOk, arrRunwayOk };
  })();

  const allAirportsByCountry = allAirports.reduce((acc, a) => {
    (acc[a.country] = acc[a.country] || []).push(a); return acc;
  }, {});

  // Edit state
  const [editingId, setEditingId] = useState(null);
  const [editEconomy, setEditEconomy] = useState('');
  const [editBusiness, setEditBusiness] = useState('');
  const [editFirst, setEditFirst] = useState('');
  const [saving, setSaving] = useState(false);

  // Fetched coordinates for the map preview
  const [depCoords, setDepCoords] = useState(null); // { iata, name, lat, lng }
  const [arrCoords, setArrCoords] = useState(null);

  useEffect(() => { fetchData(); }, []);

  // Tick every second — only when analyses box is expanded AND has pending entries
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const hasPending = analyses.some(a => a.status === 'pending');
    if (!analysesExpanded || !hasPending) return;
    const iv = setInterval(() => {
      const nowMs = Date.now();
      setNow(nowMs);
      // Auto-refresh if any pending analysis just passed its completed_at
      const justCompleted = analyses.some(a => a.status === 'pending' && new Date(a.completed_at).getTime() <= nowMs);
      if (justCompleted) { fetchAnalyses().then(() => refreshRoutes()); }
    }, 1000);
    return () => clearInterval(iv);
  }, [analyses, analysesExpanded]);

  // Fetch departure airport coordinates when selection changes
  useEffect(() => {
    if (!departureAirport) { setDepCoords(null); return; }
    fetch(`${API_URL}/api/airports/${departureAirport}`)
      .then(r => r.json())
      .then(d => {
        const a = d.airport;
        if (a?.latitude != null) setDepCoords({ iata: a.iata_code, name: a.name, lat: a.latitude, lng: a.longitude });
        else setDepCoords(null);
      })
      .catch(() => setDepCoords(null));
  }, [departureAirport]);

  // Fetch arrival airport coordinates when selection changes
  useEffect(() => {
    if (!arrivalAirport) { setArrCoords(null); return; }
    fetch(`${API_URL}/api/airports/${arrivalAirport}`)
      .then(r => r.json())
      .then(d => {
        const a = d.airport;
        if (a?.latitude != null) setArrCoords({ iata: a.iata_code, name: a.name, lat: a.latitude, lng: a.longitude });
        else setArrCoords(null);
      })
      .catch(() => setArrCoords(null));
  }, [arrivalAirport]);

  const routeInfo = (depCoords && arrCoords) ? (() => {
    const distKm = haversineKm(depCoords.lat, depCoords.lng, arrCoords.lat, arrCoords.lng);
    return { distKm: Math.round(distKm), flightTime: formatFlightTime(distKm) };
  })() : null;

  const fetchData = async () => {
    const token = localStorage.getItem('token');
    try {
      const [routesRes, destsRes, analysesRes] = await Promise.all([
        fetch(`${API_URL}/api/routes`, { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`${API_URL}/api/destinations`, { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`${API_URL}/api/market-analyses`, { headers: { 'Authorization': `Bearer ${token}` } }),
      ]);
      const routesData = await routesRes.json();
      const destsData  = await destsRes.json();
      const analysesData = await analysesRes.json();
      setRoutes(routesData.routes || []);
      setAirlineCode(routesData.airline_code || '');
      const dests = destsData.destinations || [];
      setAirports(dests.map(d => ({
        iata_code: d.airport_code, name: d.airport_name, country: d.country,
        effective_type: d.effective_type || d.destination_type,
      })));
      setAnalyses(analysesData.analyses || []);
      setWeekUsed(analysesData.week_used || 0);
      setWeekLimit(analysesData.week_limit || 4);
      setWeekStart(analysesData.week_start || '');
    } catch (err) {
      console.error('Failed to fetch data:', err);
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const fetchAnalyses = async () => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/market-analyses`, { headers: { 'Authorization': `Bearer ${token}` } });
      const data = await res.json();
      setAnalyses(data.analyses || []);
      setWeekUsed(data.week_used || 0);
      setWeekLimit(data.week_limit || 4);
      setWeekStart(data.week_start || '');
    } catch (err) {
      console.error('Failed to fetch analyses:', err);
    }
  };

  const handleRequestAnalysis = async () => {
    if (!selectedRouteForAnalysis) return;
    setRequestingAnalysis(true);
    setError('');
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/market-analyses/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ route_id: parseInt(selectedRouteForAnalysis) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to request analysis');
      setSuccess(`Analysis requested! Cost: $${data.cost.toLocaleString()}. Results available in ~12 hours.`);
      setSelectedRouteForAnalysis('');
      await fetchAnalyses();
    } catch (err) {
      setError(err.message);
    } finally {
      setRequestingAnalysis(false);
    }
  };

  const refreshRoutes = async () => {
    const token = localStorage.getItem('token');
    const res  = await fetch(`${API_URL}/api/routes`, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    setRoutes(data.routes || []);
  };

  const handleCreateRoute = async (e) => {
    e.preventDefault();
    setError(''); setSuccess(''); setCreating(true);
    const token = localStorage.getItem('token');
    try {
      const body = {
        departure_airport: departureAirport, arrival_airport: arrivalAirport,
        flight_number_suffix: flightNumberSuffix,
        economy_price: parseFloat(economyPrice),
        business_price: businessPrice ? parseFloat(businessPrice) : null,
        first_price: firstPrice ? parseFloat(firstPrice) : null,
      };
      if (createReturn && returnFlightNumberSuffix.length === 4)
        body.return_flight_number_suffix = returnFlightNumberSuffix;

      const res  = await fetch(`${API_URL}/api/routes/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || (data.errors && data.errors[0]?.msg) || 'Failed to create route');

      setSuccess(data.message);
      setDepartureAirport(''); setArrivalAirport(''); setFlightNumberSuffix('');
      setReturnFlightNumberSuffix(''); setCreateReturn(false);
      setEconomyPrice(''); setBusinessPrice(''); setFirstPrice('');
      await refreshRoutes();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleStartEdit = (route) => {
    setEditingId(route.id);
    setEditEconomy(route.economy_price != null ? String(route.economy_price) : '');
    setEditBusiness(route.business_price != null ? String(route.business_price) : '');
    setEditFirst(route.first_price != null ? String(route.first_price) : '');
  };

  const handleCancelEdit = () => setEditingId(null);

  const handleSaveEdit = async (routeId) => {
    setSaving(true); setError('');
    const token = localStorage.getItem('token');
    try {
      const body = { economy_price: parseFloat(editEconomy) };
      if (editBusiness) body.business_price = parseFloat(editBusiness);
      if (editFirst)    body.first_price    = parseFloat(editFirst);
      const res  = await fetch(`${API_URL}/api/routes/${routeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update route');
      setEditingId(null);
      await refreshRoutes();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRoute = async (routeId, flightNumber) => {
    if (!confirm(`Delete route ${flightNumber}?`)) return;
    const token = localStorage.getItem('token');
    setError('');
    try {
      const res  = await fetch(`${API_URL}/api/routes/${routeId}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete route');
      setSuccess('Route deleted successfully');
      await refreshRoutes();
    } catch (err) {
      setError(err.message);
    }
  };

  const TIER_LABEL = { home_base: ' (Home-Base)', base: ' 🔥' };
  const airportsByCountry = airports.reduce((acc, a) => {
    if (!acc[a.country]) acc[a.country] = [];
    acc[a.country].push(a);
    return acc;
  }, {});
  const formatPrice = (p) => p == null ? '—' : `$${Number(p).toLocaleString()}`;

  if (loading) {
    return (
      <div className="app"><div className="container"><div className="header">
        <h1>Aviation Empire</h1><p className="subtitle">Loading routes...</p>
      </div></div></div>
    );
  }

  return (
    <div className="app">
      <style>{`
        .rp-table { width:100%; border-collapse:collapse; margin-top:1rem; font-size:0.9rem; }
        .rp-table th { text-align:left; padding:0.6rem 0.75rem; background:#F5F5F5; border-bottom:2px solid #E0E0E0; font-weight:600; color:#2C2C2C; white-space:nowrap; }
        .rp-table td { padding:0.6rem 0.75rem; border-bottom:1px solid #F0F0F0; vertical-align:middle; color:#2C2C2C; }
        .rp-table tr:last-child td { border-bottom:none; }
        .rp-table tr:hover td { background:#FAFAFA; }
        .rp-table tr.editing td { background:#F8F8F8; }
        .rp-fn { font-weight:700; font-family:monospace; font-size:1rem; letter-spacing:0.03em; }
        .rp-route-text { color:#444; line-height:1.4; }
        .rp-price { font-variant-numeric:tabular-nums; }
        .rp-price-nil { color:#BBBBBB; font-style:italic; }
        .rp-edit-input { width:80px; padding:0.3rem 0.4rem; border:1px solid #E0E0E0; border-radius:4px; font-size:0.9rem; }
        .rp-edit-input:focus { outline:none; border-color:#2C2C2C; }
        .rp-btn-edit { padding:0.3rem 0.6rem; background:white; border:1px solid #2C2C2C; border-radius:4px; cursor:pointer; font-size:0.8rem; color:#2C2C2C; }
        .rp-btn-edit:hover { background:#2C2C2C; color:white; }
        .rp-btn-delete { padding:0.3rem 0.6rem; background:white; border:1px solid #dc2626; border-radius:4px; cursor:pointer; font-size:0.8rem; color:#dc2626; margin-left:0.4rem; }
        .rp-btn-delete:hover { background:#dc2626; color:white; }
        .rp-btn-save { padding:0.3rem 0.6rem; background:#2C2C2C; border:1px solid #2C2C2C; border-radius:4px; cursor:pointer; font-size:0.8rem; color:white; }
        .rp-btn-save:disabled { opacity:0.5; cursor:not-allowed; }
        .rp-btn-cancel { padding:0.3rem 0.6rem; background:white; border:1px solid #999; border-radius:4px; cursor:pointer; font-size:0.8rem; color:#666; margin-left:0.4rem; }
        .fn-prefix { display:inline-block; padding:0.5rem 0.75rem; background:#F5F5F5; border:1px solid #E0E0E0; border-right:none; border-radius:6px 0 0 6px; font-weight:700; color:#2C2C2C; font-family:monospace; }
        .fn-input { padding:0.5rem 0.75rem; border:1px solid #E0E0E0; border-radius:0 6px 6px 0; font-family:monospace; font-size:1rem; width:90px; }
        .fn-input:focus { outline:none; border-color:#2C2C2C; }
        .rp-airport-link { background:none; border:none; padding:0; color:#2563eb; cursor:pointer; font-weight:700; font-size:inherit; font-family:inherit; text-decoration:underline; text-decoration-style:dotted; text-underline-offset:2px; }
        .rp-airport-link:hover { color:#1d4ed8; }
        .price-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:1rem; }
        .rp-create-grid { display:flex; flex-direction:column; gap:1.5rem; margin-bottom:1.5rem; }
        .rp-map-card { background:white; border-radius:8px; box-shadow:0 2px 8px rgba(0,0,0,0.08); overflow:hidden; }
        .rp-map-card-hd { background:#2C2C2C; color:white; padding:14px 20px; font-size:0.78rem; font-weight:700; text-transform:uppercase; letter-spacing:0.1em; }
        .rp-map-info { display:grid; grid-template-columns:repeat(3,1fr); border-top:1px solid #F0F0F0; }
        .rp-map-info-cell { padding:0.9rem 1rem; text-align:center; border-right:1px solid #F0F0F0; }
        .rp-map-info-cell:last-child { border-right:none; }
        .rp-map-info-val { font-size:1.1rem; font-weight:700; color:#1a6dc4; font-family:monospace; font-variant-numeric:tabular-nums; }
        .rp-map-info-lbl { font-size:0.7rem; color:#999; text-transform:uppercase; letter-spacing:0.07em; margin-top:0.15rem; }
        .rp-top-grid { display:grid; grid-template-columns:1fr 1fr; gap:1.5rem; margin-bottom:1.5rem; align-items:start; }
        .ma-select { width:100%; padding:0.5rem 0.6rem; border:1px solid #E0E0E0; border-radius:6px; font-size:0.88rem; background:white; color:#2C2C2C; }
        .ma-select:focus { outline:none; border-color:#2C2C2C; }
        .ma-btn { padding:0.5rem 1rem; background:#2C2C2C; color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.85rem; font-weight:600; width:100%; margin-top:0.6rem; }
        .ma-btn:disabled { opacity:0.5; cursor:not-allowed; }
        .ma-analysis-item { padding:12px 16px; border-bottom:1px solid #F0F0F0; }
        .ma-analysis-item:last-child { border-bottom:none; }
        .ma-route-label { font-weight:700; font-family:monospace; font-size:0.9rem; color:#2C2C2C; }
        .ma-meta { font-size:0.75rem; color:#999; margin-top:2px; }
        .ma-pending-badge { display:inline-block; padding:2px 8px; border-radius:10px; background:#FEF3C7; color:#92400E; font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; }
        .ma-progress-wrap { margin-top:8px; }
        .ma-progress-bar-bg { height:6px; border-radius:3px; background:#F0F0F0; overflow:hidden; }
        .ma-progress-bar-fill { height:100%; border-radius:3px; background:#F59E0B; transition:width 1s linear; }
        .ma-progress-label { display:flex; justify-content:space-between; font-size:0.72rem; color:#92400E; margin-top:4px; }
        .ma-class-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; margin-top:8px; }
        .ma-class-cell { background:#F9F9F9; border-radius:5px; padding:6px 8px; }
        .ma-class-label { font-size:0.65rem; color:#999; text-transform:uppercase; letter-spacing:0.06em; }
        .ma-class-price { font-size:0.82rem; font-weight:700; color:#2C2C2C; font-variant-numeric:tabular-nums; margin-top:1px; }
        @media (max-width:1100px) {
          .rp-top-grid { grid-template-columns:1fr; }
        }
        @media (max-width:900px) {
          .rp-create-grid { grid-template-columns:1fr; }
          .price-grid { grid-template-columns:1fr; }
          .rp-table { font-size:0.8rem; }
          .rp-table th, .rp-table td { padding:0.5rem; }
        }
      `}</style>

      <div className="page-hero" style={{ backgroundImage: "linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.6)), url('/header-images/Headerimage_Routes.png')" }}>
        <div className="page-hero-overlay">
          <h1>Route Planning</h1>
          <p>{airline.name}</p>
        </div>
      </div>

      <div className="container" style={{ paddingTop: '24px' }}>
        <TopBar onBack={onBack} balance={airline.balance} backLabel={backLabel} airline={airline} />
        <Toast error={error} onClearError={() => setError('')} success={success} onClearSuccess={() => setSuccess('')} />

        {/* Top row: Create+Map left | Market Analysis right */}
        <div className="rp-top-grid">

        {/* Left: Create Route + Map stacked */}
        <div className="rp-create-grid">

          {/* Form */}
          <div className="info-card">
            <div className="card-header-bar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="card-header-bar-title">{checkMode ? 'Check Route' : 'Create New Route'}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {!checkMode && routeInfo && (
                  <span style={{ fontWeight: 400, opacity: 0.85, fontSize: '0.78rem', letterSpacing: '0.04em' }}>
                    {routeInfo.distKm.toLocaleString()} km · {routeInfo.flightTime}
                  </span>
                )}
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ padding: '5px 12px', fontSize: '0.78rem' }}
                  onClick={() => { setCheckMode(m => !m); if (!checkMode) enterCheckMode(); }}
                >
                  {checkMode ? '← Create Route' : 'Check Route'}
                </button>
              </div>
            </div>

            {/* Route preview map — negative margins flush with card edges */}
            <div style={{ margin: '-20px -28px 28px', borderBottom: '1px solid #F0F0F0' }}>
              <RoutePreviewMap dep={depCoords} arr={arrCoords} />
            </div>

            {checkMode ? (
              <div>
                {/* Aircraft */}
                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', marginBottom: '0.4rem', fontWeight: 600, fontSize: '0.9rem', color: '#2C2C2C' }}>Aircraft</label>
                  <select value={checkAircraftId} onChange={e => setCheckAircraftId(e.target.value)}
                    style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid #E0E0E0', fontSize: '0.9rem' }}>
                    <option value="">Select aircraft…</option>
                    {checkFleet.filter(a => !a.is_listed_for_sale).map(a => (
                      <option key={a.id} value={a.id}>{a.registration} — {a.full_name} ({a.range_km?.toLocaleString()} km)</option>
                    ))}
                  </select>
                </div>

                {/* Airports */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: '0.4rem', fontWeight: 600, fontSize: '0.9rem', color: '#2C2C2C' }}>Departure</label>
                    <select value={checkDep} onChange={e => setCheckDep(e.target.value)}
                      style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid #E0E0E0', fontSize: '0.9rem' }}>
                      <option value="">Select…</option>
                      {Object.entries(allAirportsByCountry).sort(([a],[b]) => a.localeCompare(b)).map(([country, list]) => (
                        <optgroup key={country} label={country}>
                          {list.map(a => <option key={a.iata_code} value={a.iata_code}>{a.iata_code} – {a.name}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '0.4rem', fontWeight: 600, fontSize: '0.9rem', color: '#2C2C2C' }}>Arrival</label>
                    <select value={checkArr} onChange={e => setCheckArr(e.target.value)}
                      style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid #E0E0E0', fontSize: '0.9rem' }}>
                      <option value="">Select…</option>
                      {Object.entries(allAirportsByCountry).sort(([a],[b]) => a.localeCompare(b)).map(([country, list]) => (
                        <optgroup key={country} label={country}>
                          {list.map(a => <option key={a.iata_code} value={a.iata_code} disabled={a.iata_code === checkDep}>{a.iata_code} – {a.name}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Result */}
                {checkResult && (
                  <div style={{ background: '#F9F9F9', border: '1px solid #E8E8E8', borderRadius: 8, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ fontWeight: 700, fontSize: '0.88rem', color: '#2C2C2C', marginBottom: 4 }}>
                      {checkDep} → {checkArr} · {checkResult.dist.toLocaleString()} km
                    </div>
                    {[
                      {
                        ok: checkResult.rangeOk,
                        label: 'Range',
                        detail: `${checkResult.dist.toLocaleString()} km required — ${checkAircraft.range_km?.toLocaleString()} km available`,
                      },
                      {
                        ok: checkResult.depRunwayOk,
                        label: `Departure runway (${checkDep})`,
                        detail: `${checkAircraft.min_runway_takeoff_m?.toLocaleString()} m required — ${checkDepData?.runway_length_m?.toLocaleString()} m available`,
                      },
                      {
                        ok: checkResult.arrRunwayOk,
                        label: `Arrival runway (${checkArr})`,
                        detail: `${checkAircraft.min_runway_landing_m?.toLocaleString()} m required — ${checkArrData?.runway_length_m?.toLocaleString()} m available`,
                      },
                    ].map(({ ok, label, detail }) => (
                      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: '1.1rem', lineHeight: 1 }}>{ok ? '✅' : '❌'}</span>
                        <div>
                          <span style={{ fontWeight: 600, fontSize: '0.82rem', color: ok ? '#166534' : '#991B1B' }}>{label}</span>
                          <span style={{ fontSize: '0.78rem', color: '#666', marginLeft: 6 }}>{detail}</span>
                        </div>
                      </div>
                    ))}
                    <div style={{ marginTop: 4, padding: '8px 12px', borderRadius: 6, background: checkResult.rangeOk && checkResult.depRunwayOk && checkResult.arrRunwayOk ? '#DCFCE7' : '#FEE2E2', textAlign: 'center', fontWeight: 700, fontSize: '0.85rem', color: checkResult.rangeOk && checkResult.depRunwayOk && checkResult.arrRunwayOk ? '#166534' : '#991B1B' }}>
                      {checkResult.rangeOk && checkResult.depRunwayOk && checkResult.arrRunwayOk ? '✈ Route is feasible' : '✗ Route not feasible'}
                    </div>
                  </div>
                )}
              </div>
            ) : (
            <form onSubmit={handleCreateRoute}>

              {/* Airports */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.4rem', fontWeight: '600', fontSize: '0.9rem', color: '#2C2C2C' }}>Departure</label>
                  <select value={departureAirport} onChange={e => setDepartureAirport(e.target.value)} required
                    style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #E0E0E0', fontSize: '0.9rem' }}>
                    <option value="">Select...</option>
                    {Object.entries(airportsByCountry).map(([country, list]) => (
                      <optgroup key={country} label={country}>
                        {list.map(a => (
                          <option key={a.iata_code} value={a.iata_code}>
                            {a.iata_code} – {a.name}{TIER_LABEL[a.effective_type] || ''}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.4rem', fontWeight: '600', fontSize: '0.9rem', color: '#2C2C2C' }}>Arrival</label>
                  <select value={arrivalAirport} onChange={e => setArrivalAirport(e.target.value)} required
                    style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #E0E0E0', fontSize: '0.9rem' }}>
                    <option value="">Select...</option>
                    {Object.entries(airportsByCountry).map(([country, list]) => (
                      <optgroup key={country} label={country}>
                        {list.map(a => (
                          <option key={a.iata_code} value={a.iata_code} disabled={a.iata_code === departureAirport}>
                            {a.iata_code} – {a.name}{TIER_LABEL[a.effective_type] || ''}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
              </div>

              {/* Flight numbers */}
              <div style={{ marginBottom: '1rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: createReturn ? '1fr 1fr' : '1fr', gap: '1rem' }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: '0.4rem', fontWeight: '600', fontSize: '0.9rem', color: '#2C2C2C' }}>
                      Flight Number{createReturn && <span style={{ fontWeight: 400, color: '#666' }}> ({departureAirport || '?'} → {arrivalAirport || '?'})</span>}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <span className="fn-prefix">{airlineCode || '??'}</span>
                      <input type="text" className="fn-input" value={flightNumberSuffix}
                        onChange={e => setFlightNumberSuffix(e.target.value.replace(/\D/g, '').slice(0, 4))}
                        placeholder="0815" required maxLength={4} pattern="\d{4}" title="Exactly 4 digits" />
                    </div>
                    <small style={{ color: '#999', fontSize: '0.8rem' }}>4 digits, e.g. 0815 → {airlineCode || '??'}0815</small>
                  </div>
                  {createReturn && (
                    <div>
                      <label style={{ display: 'block', marginBottom: '0.4rem', fontWeight: '600', fontSize: '0.9rem', color: '#2C2C2C' }}>
                        Return Flight Number <span style={{ fontWeight: 400, color: '#666' }}>({arrivalAirport || '?'} → {departureAirport || '?'})</span>
                      </label>
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <span className="fn-prefix">{airlineCode || '??'}</span>
                        <input type="text" className="fn-input" value={returnFlightNumberSuffix}
                          onChange={e => setReturnFlightNumberSuffix(e.target.value.replace(/\D/g, '').slice(0, 4))}
                          placeholder="0816" required={createReturn} maxLength={4} pattern="\d{4}" title="Exactly 4 digits" />
                      </div>
                      <small style={{ color: '#999', fontSize: '0.8rem' }}>4 digits, e.g. 0816 → {airlineCode || '??'}0816</small>
                    </div>
                  )}
                </div>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.6rem', cursor: 'pointer', fontSize: '0.875rem', color: '#444' }}>
                  <input type="checkbox" checked={createReturn}
                    onChange={e => { setCreateReturn(e.target.checked); if (!e.target.checked) setReturnFlightNumberSuffix(''); }}
                    style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                  Also create return route
                </label>
              </div>

              {/* Prices */}
              <div className="price-grid" style={{ marginBottom: '1rem' }}>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.4rem', fontWeight: '600', fontSize: '0.9rem', color: '#2C2C2C' }}>Economy ($)</label>
                  <input type="number" min="1" step="1" value={economyPrice} onChange={e => setEconomyPrice(e.target.value)}
                    required placeholder="e.g. 199"
                    style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #E0E0E0', fontSize: '0.9rem', boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.4rem', fontWeight: '600', fontSize: '0.9rem', color: '#2C2C2C' }}>Business ($) <span style={{ fontWeight: 400, color: '#999' }}>(opt.)</span></label>
                  <input type="number" min="1" step="1" value={businessPrice} onChange={e => setBusinessPrice(e.target.value)}
                    placeholder="e.g. 599"
                    style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #E0E0E0', fontSize: '0.9rem', boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.4rem', fontWeight: '600', fontSize: '0.9rem', color: '#2C2C2C' }}>First ($) <span style={{ fontWeight: 400, color: '#999' }}>(opt.)</span></label>
                  <input type="number" min="1" step="1" value={firstPrice} onChange={e => setFirstPrice(e.target.value)}
                    placeholder="e.g. 1299"
                    style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #E0E0E0', fontSize: '0.9rem', boxSizing: 'border-box' }} />
                </div>
              </div>

              <button type="submit" className="btn-primary" style={{ padding: '0.75rem 1.5rem' }}
                disabled={creating || !departureAirport || !arrivalAirport || flightNumberSuffix.length !== 4 || !economyPrice ||
                  (createReturn && returnFlightNumberSuffix.length !== 4) || (createReturn && returnFlightNumberSuffix === flightNumberSuffix)}>
                {creating ? 'Creating...' : createReturn ? 'Create Both Routes' : 'Create Route'}
              </button>
            </form>
            )}
          </div>

        </div>{/* end rp-create-grid */}

          {/* Right: Market Analysis */}
          <div style={{ background: 'white', borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
            <div style={{ background: '#2C2C2C', color: 'white', padding: '14px 20px', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Market Analysis</span>
              <span style={{ fontWeight: 400, opacity: 0.7, fontSize: '0.72rem', textTransform: 'none', letterSpacing: 0 }}>{weekUsed}/{weekLimit} this week</span>
            </div>
            <div style={{ padding: '16px' }}>
              <div style={{ fontSize: '0.72rem', color: '#888', marginBottom: 8 }}>
                Analyze a route's pricing vs. market rates. Results ready in ~12 hours.
                {weekStart && <span> Resets {getNextMonday(weekStart)}.</span>}
              </div>
              <select
                className="ma-select"
                value={selectedRouteForAnalysis}
                onChange={e => setSelectedRouteForAnalysis(e.target.value)}
                disabled={weekUsed >= weekLimit}
              >
                <option value="">Select a route...</option>
                {routes.map(r => {
                  const cost = getAnalysisCost(r.distance_km);
                  return (
                    <option key={r.id} value={r.id}>
                      {r.flight_number}: {r.departure_airport} → {r.arrival_airport}{cost ? ` ($${cost.toLocaleString()})` : ''}
                    </option>
                  );
                })}
              </select>
              {selectedRouteForAnalysis && (() => {
                const r = routes.find(x => String(x.id) === String(selectedRouteForAnalysis));
                const cost = r ? getAnalysisCost(r.distance_km) : null;
                return cost ? (
                  <div style={{ fontSize: '0.75rem', color: '#666', marginTop: 5 }}>
                    Cost: <strong style={{ color: '#2C2C2C' }}>${cost.toLocaleString()}</strong>
                    {r.distance_km ? <span style={{ marginLeft: 6, color: '#999' }}>({r.distance_km.toLocaleString()} km)</span> : null}
                  </div>
                ) : null;
              })()}
              <button
                className="ma-btn"
                onClick={handleRequestAnalysis}
                disabled={!selectedRouteForAnalysis || requestingAnalysis || weekUsed >= weekLimit}
              >
                {requestingAnalysis ? 'Requesting…' : weekUsed >= weekLimit ? 'Weekly limit reached' : 'Request Analysis'}
              </button>
            </div>
            {analyses.length > 0 && (
              <div style={{ borderTop: '2px solid #F0F0F0' }}>
                <div
                  onClick={() => setAnalysesExpanded(v => !v)}
                  style={{ padding: '10px 16px 6px', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#999', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', userSelect: 'none' }}
                >
                  <span>Recent Analyses</span>
                  <span style={{ fontSize: '0.8rem' }}>{analysesExpanded ? '▲' : '▼'}</span>
                </div>
                {analysesExpanded && analyses.map(a => {
                  const isPending = a.status === 'pending';
                  const completedMs = new Date(a.completed_at).getTime();
                  const requestedMs = new Date(a.requested_at).getTime();
                  const totalMs = completedMs - requestedMs;
                  const elapsedMs = now - requestedMs;
                  const pct = isPending ? Math.min(100, Math.max(0, Math.round(elapsedMs / totalMs * 100))) : 100;
                  const msLeft = isPending ? Math.max(0, completedMs - now) : 0;
                  const secsLeft = Math.ceil(msLeft / 1000);
                  const timeLabel = secsLeft >= 3600
                    ? `${Math.ceil(secsLeft / 3600)}h left`
                    : secsLeft >= 60
                    ? `${Math.floor(secsLeft / 60)}m ${secsLeft % 60}s left`
                    : `${secsLeft}s left`;
                  const dateStr = new Date(a.requested_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                  return (
                    <div key={a.id} className="ma-analysis-item">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <span className="ma-route-label">{a.flight_number}</span>
                          <span style={{ color: '#666', fontSize: '0.82rem', marginLeft: 6 }}>{a.departure_airport} → {a.arrival_airport}</span>
                        </div>
                        {isPending
                          ? <span className="ma-pending-badge">Analyzing…</span>
                          : <span style={{ fontSize: '0.72rem', color: '#999' }}>{dateStr}</span>}
                      </div>
                      <div className="ma-meta">
                        Cost: ${a.cost.toLocaleString()}
                        {a.distance_km ? <span style={{ marginLeft: 6 }}>{a.distance_km.toLocaleString()} km</span> : null}
                      </div>
                      {isPending && (
                        <div className="ma-progress-wrap">
                          <div className="ma-progress-bar-bg">
                            <div className="ma-progress-bar-fill" style={{ width: `${pct}%` }} />
                          </div>
                          <div className="ma-progress-label">
                            <span>{pct}%</span>
                            <span>{msLeft > 0 ? timeLabel : 'Completing…'}</span>
                          </div>
                        </div>
                      )}
                      {isPending ? null : (
                        <div className="ma-class-grid">
                          {a.economy_price != null && (
                            <div className="ma-class-cell">
                              <div className="ma-class-label">Economy</div>
                              <div className="ma-class-price">${Number(a.economy_price).toLocaleString()}</div>
                              {a.economy_rating && <div style={{ marginTop: 3 }}><RatingDot rating={a.economy_rating} /></div>}
                            </div>
                          )}
                          {a.business_price != null && (
                            <div className="ma-class-cell">
                              <div className="ma-class-label">Business</div>
                              <div className="ma-class-price">${Number(a.business_price).toLocaleString()}</div>
                              {a.business_rating && <div style={{ marginTop: 3 }}><RatingDot rating={a.business_rating} /></div>}
                            </div>
                          )}
                          {a.first_price != null && (
                            <div className="ma-class-cell">
                              <div className="ma-class-label">First</div>
                              <div className="ma-class-price">${Number(a.first_price).toLocaleString()}</div>
                              {a.first_rating && <div style={{ marginTop: 3 }}><RatingDot rating={a.first_rating} /></div>}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

        </div>{/* end top 50/50 grid */}

        {/* Routes Table - full width */}
        <div className="info-card">
            <div className="card-header-bar">
              <span className="card-header-bar-title">Your Routes ({routes.length})</span>
            </div>
            {routes.length === 0 ? (
              <p style={{ color: '#666666', marginTop: '1rem' }}>No routes yet. Create your first route above!</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="rp-table">
                  <thead>
                    <tr>
                      <th style={{ width: '28px' }}></th>
                      {[
                        { col: 'flight_number', label: 'Flight' },
                        { col: 'departure_airport', label: 'Route' },
                        { col: 'distance_km', label: 'Distance' },
                        { col: 'weekly_flights', label: 'Flights/week' },
                      ].map(({ col, label }) => (
                        <th key={col} onClick={() => handleSort(col)} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
                          {label}{sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                        </th>
                      ))}
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRoutes.map(route => {
                      const isExpanded = expandedId === route.id;
                      const isEditing = editingId === route.id;
                      const aircraft = routeAircraft[route.id];
                      return (
                        <>
                        <tr key={route.id}>
                          <td style={{ padding: '0.4rem 0.5rem', textAlign: 'center' }}>
                            <button
                              onClick={() => toggleExpand(route.id)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '0.75rem', padding: '2px 4px', borderRadius: '3px', lineHeight: 1 }}
                              title="Details anzeigen"
                            >
                              {isExpanded ? '▼' : '▶'}
                            </button>
                          </td>
                          <td><span className="rp-fn">{route.flight_number}</span></td>
                          <td>
                            <span className="rp-route-text">
                              <AirportLink code={route.departure_airport} name={route.departure_name} onNavigate={onNavigateToAirport} />
                              {' → '}
                              <AirportLink code={route.arrival_airport} name={route.arrival_name} onNavigate={onNavigateToAirport} />
                            </span>
                          </td>
                          <td>
                            {route.distance_km
                              ? <span style={{ fontVariantNumeric: 'tabular-nums', color: '#444' }}>{route.distance_km.toLocaleString()} km</span>
                              : <span className="rp-price-nil">—</span>}
                          </td>
                          <td>
                            {route.weekly_flights > 0
                              ? <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: '#2C2C2C' }}>{route.weekly_flights}×</span>
                              : <span className="rp-price-nil">—</span>}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <button className="rp-btn-delete" onClick={() => handleDeleteRoute(route.id, route.flight_number)}>Delete</button>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={`${route.id}-expand`}>
                            <td colSpan={6} style={{ padding: 0, background: '#F9F9F9', borderBottom: '2px solid #E8E8E8' }}>
                              <div style={{ padding: '14px 16px 14px 44px' }}>

                                {/* Ticket Prices */}
                                <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#999', marginBottom: '8px' }}>
                                  Ticket Prices
                                </div>
                                {isEditing ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '12px' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', color: '#444' }}>
                                      Economy
                                      <input type="number" className="rp-edit-input" value={editEconomy} onChange={e => setEditEconomy(e.target.value)} min="1" step="1" placeholder="$" />
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', color: '#444' }}>
                                      Business
                                      <input type="number" className="rp-edit-input" value={editBusiness} onChange={e => setEditBusiness(e.target.value)} min="1" step="1" placeholder="$" />
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', color: '#444' }}>
                                      First
                                      <input type="number" className="rp-edit-input" value={editFirst} onChange={e => setEditFirst(e.target.value)} min="1" step="1" placeholder="$" />
                                    </label>
                                    <button className="rp-btn-save" onClick={() => handleSaveEdit(route.id)} disabled={saving || !editEconomy}>{saving ? 'Saving…' : 'Save'}</button>
                                    <button className="rp-btn-cancel" onClick={handleCancelEdit}>Cancel</button>
                                  </div>
                                ) : (
                                  <>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '12px' }}>
                                      <div>
                                        <div style={{ fontSize: '0.7rem', color: '#999', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Economy</div>
                                        <div style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatPrice(route.economy_price)}</div>
                                      </div>
                                      <div>
                                        <div style={{ fontSize: '0.7rem', color: '#999', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Business</div>
                                        <div style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatPrice(route.business_price)}</div>
                                      </div>
                                      <div>
                                        <div style={{ fontSize: '0.7rem', color: '#999', textTransform: 'uppercase', letterSpacing: '0.06em' }}>First</div>
                                        <div style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatPrice(route.first_price)}</div>
                                      </div>
                                      <button className="rp-btn-edit" style={{ marginLeft: '0.5rem' }} onClick={() => handleStartEdit(route)}>Edit Prices</button>
                                    </div>
                                  </>
                                )}

                                {/* Assigned Aircraft */}
                                <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#999', marginBottom: '8px', marginTop: '4px' }}>
                                  Assigned Aircraft
                                </div>
                                {loadingAircraft[route.id] ? (
                                  <span style={{ fontSize: '0.82rem', color: '#AAA' }}>Loading…</span>
                                ) : !aircraft || aircraft.length === 0 ? (
                                  <span style={{ fontSize: '0.82rem', color: '#BBB', fontStyle: 'italic' }}>Not scheduled on any aircraft</span>
                                ) : (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                    {aircraft.map(ac => (
                                      <button key={ac.id} onClick={() => onNavigateToAircraft && onNavigateToAircraft(ac.id)} style={{
                                        display: 'flex', alignItems: 'center', gap: '8px',
                                        background: 'white', border: '1px solid #E8E8E8', borderRadius: '6px',
                                        padding: '6px 12px', fontSize: '0.82rem',
                                        cursor: onNavigateToAircraft ? 'pointer' : 'default',
                                        textAlign: 'left', fontFamily: 'inherit',
                                      }} title={`Open ${ac.registration}`}>
                                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: ac.is_active ? '#22c55e' : '#ef4444', flexShrink: 0 }} />
                                        <span style={{ fontWeight: 700, fontFamily: 'monospace' }}>{ac.registration}</span>
                                        <span style={{ color: '#666' }}>{ac.type}</span>
                                        <span style={{ color: '#AAA', fontSize: '0.75rem' }}>{ac.slot_count}×/week</span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
  );
}

export default RoutePlanner;
