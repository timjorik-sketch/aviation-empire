import { useState, useEffect, useMemo, useCallback } from 'react';
import AirportLink from '../components/AirportLink.jsx';
import Toast from '../components/Toast.jsx';
import { calculateCurrentValue, formatAircraftValue } from '../utils/aircraftValue.js';

const API_URL = import.meta.env.VITE_API_URL || '';

function FleetPage({ airline, onBack, onSelectAircraft, onOpenMarketplace, onNavigateToAirport, onNavigate }) {
  const [fleetGrouped, setFleetGrouped] = useState([]);
  const [totalAircraft, setTotalAircraft] = useState(0);
  const [airports, setAirports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Fleet overview state
  const [fleetOverview, setFleetOverview] = useState([]);
  const [sortCol, setSortCol] = useState('registration');
  const [sortDir, setSortDir] = useState('asc');
  const [editMode, setEditMode] = useState(false);
  const [profilesByType, setProfilesByType] = useState({}); // typeId → profiles[]
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [openedAirports, setOpenedAirports] = useState([]);

  // Cabin profile assignment modal
  const [cpModal, setCpModal] = useState(null); // { aircraftId, typeId, currentProfileId }
  const [cpProfiles, setCpProfiles] = useState([]);
  const [cpSelected, setCpSelected] = useState('');
  const [cpSaving, setCpSaving] = useState(false);

  const [decommModal, setDecommModal] = useState(null); // aircraft object
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg]     = useState('');
  const [collapsedBases, setCollapsedBases] = useState(new Set());

  // Orders state
  const [orders, setOrders] = useState([]);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [now, setNow] = useState(Date.now());

  const toggleBase = (key) => {
    setCollapsedBases(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleAllBases = () => {
    const allKeys = groupedOverview.map(g => g.code ?? '__none__');
    const allCollapsed = allKeys.length > 0 && allKeys.every(k => collapsedBases.has(k));
    if (allCollapsed) {
      setCollapsedBases(new Set());
    } else {
      setCollapsedBases(new Set(allKeys));
    }
  };

  useEffect(() => {
    fetchData();
    fetchOrders();
  }, []);

  useEffect(() => {
    if (!ordersOpen) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ordersOpen]);

  const fetchOrders = async () => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/aircraft/orders`, { headers: { 'Authorization': `Bearer ${token}` } });
      const data = await res.json();
      setOrders(data.orders || []);
    } catch(e) { console.error('fetchOrders error:', e); }
  };

  const fetchData = async () => {
    const token = localStorage.getItem('token');
    try {
      const [fleetRes, airportsRes] = await Promise.all([
        fetch(`${API_URL}/api/aircraft/fleet/grouped`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        fetch(`${API_URL}/api/airline/airports`)
      ]);

      const fleetData = await fleetRes.json();
      const airportsData = await airportsRes.json();

      setFleetGrouped(fleetData.fleet || []);
      setTotalAircraft(fleetData.total_count || 0);
      setAirports(airportsData.airports || []);
    } catch (err) {
      console.error('Failed to fetch data:', err);
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
    // Overview loaded separately so it never blocks the main page
    fetchOverview();
  };

  const fetchOverview = async () => {
    const token = localStorage.getItem('token');
    try {
      // Use existing proven endpoints — merge in JS
      const [fleetRes, flightsRes] = await Promise.all([
        fetch(`${API_URL}/api/aircraft/fleet`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        fetch(`${API_URL}/api/flights`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
      ]);

      const fleetData = await fleetRes.json();
      const flightsData = await flightsRes.json();

      const fleet = fleetData.fleet || [];
      const flights = flightsData.flights || [];

      // Build lookup: aircraft_registration → active flight
      const activeByReg = {};
      for (const f of flights) {
        if (f.status === 'boarding' || f.status === 'in-flight') {
          activeByReg[f.aircraft_registration] = f;
        }
      }

      const overview = fleet.map(ac => {
        const af = activeByReg[ac.registration] || null;
        return {
          id: ac.id,
          registration: ac.registration,
          name: ac.name,
          home_airport: ac.home_airport,
          home_airport_name: null,
          current_location: ac.current_location ?? null,
          condition: ac.condition,
          is_active: ac.is_active ?? 0,
          aircraft_type: ac.full_name,
          type_id: ac.type_id,
          cabin_profile_id: ac.airline_cabin_profile_id ?? null,
          cabin_profile_name: ac.airline_cabin_profile_name ?? null,
          active_fn: af ? af.flight_number : null,
          active_dep: af ? af.departure_airport : null,
          active_arr: af ? af.arrival_airport : null,
          active_flight_status: af ? af.status : null,
          active_dep_time: af ? af.departure_time : null,
          active_arr_time: af ? af.arrival_time : null,
          new_price_usd: ac.new_price_usd,
          depreciation_age: ac.depreciation_age,
          depreciation_fh: ac.depreciation_fh,
          total_flight_hours: ac.total_flight_hours ?? 0,
          purchased_at: ac.purchased_at,
          is_listed_for_sale: ac.is_listed_for_sale ?? 0,
          listed_price: ac.listed_price ?? null,
          delivery_at: ac.delivery_at ?? null,
        };
      });

      setFleetOverview(overview);
    } catch (err) {
      console.error('Fleet overview fetch failed:', err);
    }
  };

  // ── Fleet Overview helpers ──────────────────────────────────────────────────

  const handleToggleEdit = async () => {
    if (editMode) { setEditMode(false); return; }
    // Load cabin profiles per unique type + opened airports when entering edit mode
    const typeIds = [...new Set(fleetOverview.map(ac => ac.type_id).filter(Boolean))];
    const token = localStorage.getItem('token');
    setProfilesLoading(true);
    try {
      const [profileResults, openedRes] = await Promise.all([
        Promise.all(
          typeIds.map(tid =>
            fetch(`${API_URL}/api/cabin-profiles/for-type/${tid}`, {
              headers: { 'Authorization': `Bearer ${token}` }
            }).then(r => r.json()).then(d => ({ tid, profiles: d.profiles || [] }))
          )
        ),
        fetch(`${API_URL}/api/destinations/opened`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }).then(r => r.json())
      ]);
      const map = {};
      for (const { tid, profiles } of profileResults) map[tid] = profiles;
      setProfilesByType(map);
      setOpenedAirports(openedRes.airports || []);
    } catch (e) {
      console.error('Load edit-mode data error:', e);
    } finally {
      setProfilesLoading(false);
    }
    setEditMode(true);
  };

  const handleCabinProfileInlineChange = async (ac, profileId) => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/aircraft/${ac.id}/cabin-profile-fleet`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ profile_id: profileId ? parseInt(profileId) : null })
      });
      const data = await res.json();
      if (!res.ok) { setErrorMsg(data.error || 'Failed to update cabin profile'); return; }
      const profiles = profilesByType[ac.type_id] || [];
      const p = profiles.find(p => p.id === parseInt(profileId));
      setFleetOverview(prev => prev.map(a => a.id !== ac.id ? a : {
        ...a, cabin_profile_id: profileId ? parseInt(profileId) : null,
        cabin_profile_name: p ? p.name : null
      }));
      setSuccessMsg(`${ac.registration}: cabin profile updated`);
    } catch (e) { setErrorMsg('Failed to update cabin profile'); }
  };

  const handleHomeBaseChange = async (ac, newCode) => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/aircraft/${ac.id}/home-airport`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ home_airport: newCode || null })
      });
      const data = await res.json();
      if (!res.ok) { setErrorMsg(data.error || 'Failed to update home base'); return; }
      setFleetOverview(prev => prev.map(a => a.id !== ac.id ? a : { ...a, home_airport: newCode || null }));
      setSuccessMsg(`${ac.registration}: home base updated`);
    } catch (e) { setErrorMsg('Failed to update home base'); }
  };

  const handleDecommission = (ac) => {
    setDecommModal(ac);
  };

  const handleScrap = async () => {
    const ac = decommModal;
    if (!ac) return;
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/aircraft/${ac.id}/scrap`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
      const d = await res.json();
      setDecommModal(null);
      setFleetOverview(prev => prev.filter(a => a.id !== ac.id));
      fetchData();
    } catch (e) { console.error('Scrap error:', e); alert(e.message); }
  };

  const handleSellToMarket = async () => {
    const ac = decommModal;
    if (!ac) return;
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/aircraft/${ac.id}/sell-to-market`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed');
      setDecommModal(null);
      setFleetOverview(prev => prev.map(a => a.id !== ac.id ? a : {
        ...a, is_listed_for_sale: 1, listed_price: d.market_value ?? a.listed_price
      }));
      setSuccessMsg(`${ac.registration} wurde auf dem Gebrauchtmarkt gelistet.`);
    } catch (e) { console.error('Sell to market error:', e); setErrorMsg(e.message); }
  };

  const handleCancelListing = async (ac) => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/aircraft/${ac.id}/cancel-listing`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed');
      setFleetOverview(prev => prev.map(a => a.id !== ac.id ? a : {
        ...a, is_listed_for_sale: 0, listed_price: null
      }));
      setSuccessMsg(`${ac.registration}: Verkauf beendet.`);
    } catch (e) { setErrorMsg(e.message || 'Fehler beim Beenden des Verkaufs'); }
  };

  const handleSort = (col) => {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  const getAircraftStatus = (ac) => {
    if (!ac.is_active) return 'inactive';
    if (ac.active_fn) return ac.active_flight_status || 'in-flight';
    return 'ground';
  };

  const airportName = (code) => {
    if (!code) return null;
    const ap = airports.find(a => a.iata_code === code);
    return ap ? ap.name : null;
  };

  const getLocationText = (ac) => {
    if (ac.active_fn && ac.active_flight_status === 'in-flight') return `${ac.active_fn}: ${ac.active_dep} → ${ac.active_arr}`;
    const locCode = ac.current_location || ac.home_airport;
    if (locCode) {
      const name = airportName(locCode);
      return name ? `${name} (${locCode})` : locCode;
    }
    return 'Unknown';
  };

  const sortAircraft = (list) => {
    return [...list].sort((a, b) => {
      let aVal, bVal;
      const STATUS_ORDER = { 'in-flight': 0, 'boarding': 1, 'ground': 2, 'inactive': 3 };
      if (sortCol === 'status') {
        aVal = STATUS_ORDER[getAircraftStatus(a)] ?? 9;
        bVal = STATUS_ORDER[getAircraftStatus(b)] ?? 9;
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
      }
      if (sortCol === 'registration') { aVal = a.registration; bVal = b.registration; }
      else if (sortCol === 'name') { aVal = a.name || ''; bVal = b.name || ''; }
      else if (sortCol === 'aircraft_type') { aVal = a.aircraft_type; bVal = b.aircraft_type; }
      else if (sortCol === 'location') { aVal = getLocationText(a); bVal = getLocationText(b); }
      else if (sortCol === 'condition') { return sortDir === 'asc' ? (a.condition ?? 100) - (b.condition ?? 100) : (b.condition ?? 100) - (a.condition ?? 100); }
      else { aVal = a.registration; bVal = b.registration; }
      const cmp = String(aVal).localeCompare(String(bVal));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  };

  const sortedOverview = useMemo(() => sortAircraft(fleetOverview), [fleetOverview, sortCol, sortDir, airports]);

  // Group sorted aircraft by home_airport; listed-for-sale aircraft go into a special group
  const groupedOverview = useMemo(() => {
    const listed = [];
    const production = [];
    const normal = [];
    const now = new Date();
    for (const ac of sortedOverview) {
      if (ac.is_listed_for_sale) listed.push(ac);
      else if (ac.delivery_at && new Date(ac.delivery_at) > now) production.push(ac);
      else normal.push(ac);
    }

    const groupMap = new Map();
    for (const ac of normal) {
      const code = ac.home_airport || null;
      const key = code ?? '__none__';
      if (!groupMap.has(key)) groupMap.set(key, { code, forSale: false, inProduction: false, aircraft: [] });
      groupMap.get(key).aircraft.push(ac);
    }
    const groups = Array.from(groupMap.values());
    groups.sort((a, b) => {
      if (!a.code && !b.code) return 0;
      if (!a.code) return 1;
      if (!b.code) return -1;
      return a.code.localeCompare(b.code);
    });
    if (listed.length > 0) groups.push({ code: '__for_sale__', forSale: true, inProduction: false, aircraft: listed });
    if (production.length > 0) groups.push({ code: '__in_production__', forSale: false, inProduction: true, aircraft: production });
    return groups;
  }, [sortedOverview]);

  const SortIcon = ({ col }) => {
    if (sortCol !== col) return <span style={{ opacity: 0.3, marginLeft: '4px' }}>↕</span>;
    return <span style={{ marginLeft: '4px' }}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  // ── Cabin Profile Modal ──────────────────────────────────────────────────────

  const openCpModal = useCallback(async (ac) => {
    const token = localStorage.getItem('token');
    setCpSelected(ac.cabin_profile_id ? String(ac.cabin_profile_id) : '');
    setCpModal({ aircraftId: ac.id, typeId: ac.type_id, currentProfileId: ac.cabin_profile_id });
    try {
      const res = await fetch(`${API_URL}/api/cabin-profiles/for-type/${ac.type_id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setCpProfiles(data.profiles || []);
    } catch (err) {
      setCpProfiles([]);
    }
  }, []);

  const closeCpModal = () => { setCpModal(null); setCpProfiles([]); setCpSelected(''); };

  const saveCpAssignment = async () => {
    if (!cpModal) return;
    setCpSaving(true);
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/aircraft/${cpModal.aircraftId}/airline-cabin-profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ profile_id: cpSelected ? parseInt(cpSelected) : null })
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed to save'); }
      // Update overview in place
      setFleetOverview(prev => prev.map(ac => {
        if (ac.id !== cpModal.aircraftId) return ac;
        const p = cpProfiles.find(p => p.id === parseInt(cpSelected));
        return { ...ac, cabin_profile_id: cpSelected ? parseInt(cpSelected) : null, cabin_profile_name: p ? p.name : null };
      }));
      closeCpModal();
    } catch (err) {
      console.error('Save cabin profile error:', err);
    } finally {
      setCpSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="fleet-page">
        <div className="loading-container">
          <div className="loading-spinner"></div>
          <p>Loading fleet data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fleet-page">
      {/* Hero Section */}
      <div className="fleet-hero">
        <div className="fleet-hero-overlay">
          <h1>Fleet Management</h1>
          <p>{airline.name} - Build Your Aviation Empire</p>
        </div>
      </div>

      <div className="fleet-container">
        <Toast success={successMsg} onClearSuccess={() => setSuccessMsg('')} error={errorMsg || error} onClearError={() => { setErrorMsg(''); setError(''); }} />
        {/* Back Button and Balance */}
        <div className="fleet-top-bar">
          <button onClick={onBack} className="btn-back">
            <span className="back-arrow">&#8592;</span> Dashboard
          </button>
          <div className="balance-display">
            <span className="balance-label">Balance:</span>
            <span className="balance-amount">${airline.balance.toLocaleString()}</span>
          </div>
        </div>

        {/* Messages handled by Toast above */}

        {/* Fleet + Manage Fleet sidebar */}
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', marginBottom: '2rem' }}>

        {/* Fleet Section */}
        <section className="fleet-section" style={{ flex: 7, minWidth: 0, marginBottom: 0 }}>
          <div className="fleet-section-bar">
            <span className="fleet-section-bar-title">Fleet ({totalAircraft})</span>
          </div>

          {fleetGrouped.length > 0 ? (
            <div className="fleet-type-grid">
              {fleetGrouped.map(item => (
                <div key={item.type_id} className="fleet-type-card">
                  <div className="fleet-type-hd">
                    <div>
                      <p className="fleet-type-manufacturer">{item.manufacturer}</p>
                      <h3 className="fleet-type-model">{item.model}</h3>
                    </div>
                    <span className="fleet-type-count">{item.count}</span>
                  </div>
                  <div className="fleet-type-img-wrap">
                    {item.image_filename ? (
                      <img
                        src={`/aircraft-images/${item.image_filename}`}
                        alt={item.full_name}
                        className="fleet-type-img"
                      />
                    ) : (
                      <div className="fleet-type-img-placeholder">
                        <svg viewBox="0 0 24 24" fill="currentColor" className="fleet-type-placeholder-icon">
                          <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
                        </svg>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-fleet">
              <svg viewBox="0 0 24 24" fill="currentColor" className="empty-icon">
                <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
              </svg>
              <p>Keine Flugzeuge in deiner Flotte</p>
              <button className="btn-buy-aircraft" style={{ marginTop: '1rem' }} onClick={onOpenMarketplace}>
                + Buy your first aircraft
              </button>
            </div>
          )}
        </section>

        {/* Right column: Manage Fleet + Aircraft on Order */}
        <div style={{ flex: 3, display: 'flex', flexDirection: 'column', gap: '1rem' }}>

          {/* Manage Fleet */}
          <div style={{ background: 'white', borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
            <div style={{ background: '#2C2C2C', padding: '14px 20px' }}>
              <span className="fleet-section-bar-title">Manage Fleet</span>
            </div>
            <div className="fo-nav-list">
              {[
                { label: 'Airplane Market', action: () => onOpenMarketplace?.()          },
                { label: 'Cabin Profiles',  action: () => onNavigate?.('cabin-profiles') },
              ].map(({ label, action }) => (
                <button key={label} className="fo-nav-btn" onClick={action}>
                  {label}
                  <span className="fo-nav-arrow">›</span>
                </button>
              ))}
            </div>
          </div>

          {/* Aircraft on Order */}
          {orders.length > 0 && (
            <div style={{ background: 'white', borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
              <div style={{ background: '#2C2C2C', padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="fleet-section-bar-title">Aircraft on Order</span>
                <span style={{ background: '#F59E0B', color: '#fff', borderRadius: 12, padding: '2px 10px', fontSize: '0.78rem', fontWeight: 700 }}>{orders.length}</span>
              </div>
              <div style={{ padding: '14px 16px' }}>
                <p style={{ margin: '0 0 10px', fontSize: '0.82rem', color: '#666' }}>
                  {orders.length} aircraft currently in production
                </p>
                <button className="fo-nav-btn" onClick={() => setOrdersOpen(true)}>
                  View Orders <span className="fo-nav-arrow">›</span>
                </button>
              </div>
            </div>
          )}

        </div>{/* end right column */}

        </div>{/* end flex row */}

        {/* Orders popup */}
        {ordersOpen && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 560, maxHeight: '80vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
              <div style={{ background: '#2C2C2C', padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#fff', fontWeight: 700, fontSize: '1rem' }}>Aircraft on Order ({orders.length})</span>
                <button onClick={() => setOrdersOpen(false)} style={{ background: 'none', border: 'none', color: '#fff', fontSize: '1.4rem', cursor: 'pointer', lineHeight: 1 }}>×</button>
              </div>
              <div style={{ overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                {orders.map(o => {
                  const orderedMs = new Date(o.purchased_at).getTime();
                  const deliveryMs = new Date(o.delivery_at).getTime();
                  const totalMs = deliveryMs - orderedMs;
                  const elapsedMs = now - orderedMs;
                  const pct = Math.min(100, Math.max(0, Math.round(elapsedMs / totalMs * 100)));
                  const msLeft = Math.max(0, deliveryMs - now);
                  const secsLeft = Math.ceil(msLeft / 1000);
                  const timeLabel = secsLeft >= 3600
                    ? `${Math.ceil(secsLeft / 3600)}h left`
                    : secsLeft >= 60
                    ? `${Math.floor(secsLeft / 60)}m ${secsLeft % 60}s left`
                    : `${secsLeft}s left`;
                  return (
                    <div key={o.id} style={{ background: '#F9F9F9', borderRadius: 8, padding: '12px 14px', border: '1px solid #E8E8E8' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                        <div>
                          <span style={{ fontWeight: 700, fontSize: '0.88rem', color: '#2C2C2C' }}>{o.full_name}</span>
                          <span style={{ marginLeft: 8, fontFamily: 'monospace', fontSize: '0.82rem', color: '#666' }}>{o.registration}</span>
                        </div>
                        <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, background: '#E5E7EB', color: '#6B7280', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          In Production
                        </span>
                      </div>
                      <div style={{ fontSize: '0.78rem', color: '#888', marginBottom: 8 }}>
                        Delivery to {o.home_airport} · Wake {o.wake_turbulence_category}
                      </div>
                      <div style={{ height: 6, borderRadius: 3, background: '#F0F0F0', overflow: 'hidden', marginBottom: 4 }}>
                        <div style={{ height: '100%', borderRadius: 3, background: '#F59E0B', width: `${pct}%`, transition: 'width 1s linear' }} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#92400E' }}>
                        <span>{pct}%</span>
                        <span>{msLeft > 0 ? timeLabel : 'Delivering…'}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Airplane List Section */}
        <section className="overview-section">
          <div className="fleet-section-bar">
            <span className="fleet-section-bar-title">Airplane List</span>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                className="ov-btn-toggle-all"
                onClick={toggleAllBases}
                title={groupedOverview.length > 0 && groupedOverview.every(g => collapsedBases.has(g.code ?? '__none__')) ? 'Expand All' : 'Collapse All'}
              >
                {groupedOverview.length > 0 && groupedOverview.every(g => collapsedBases.has(g.code ?? '__none__')) ? '▶ All' : '▼ All'}
              </button>
              <button
                className={`ov-btn-edit-mode${editMode ? ' ov-btn-edit-mode--active' : ''}`}
                onClick={handleToggleEdit}
                disabled={profilesLoading}
              >
                {profilesLoading ? 'Loading…' : editMode ? 'Done Editing' : 'Edit Airplanes'}
              </button>
            </div>
          </div>

          {fleetOverview.length === 0 ? (
            <p style={{ color: '#999', padding: '1rem 0' }}>No aircraft in fleet yet.</p>
          ) : (
            <div className="base-groups-wrap">
              {groupedOverview.map(group => {
                const key = group.code ?? '__none__';
                const collapsed = collapsedBases.has(key);
                const name = group.code ? airportName(group.code) : null;
                return (
                  <div key={key} className="base-group">

                    {/* ── Group header ── */}
                    <div
                      className="base-group-hd"
                      onClick={() => toggleBase(key)}
                    >
                      <span className="base-group-chevron">{collapsed ? '▶' : '▼'}</span>
                      {group.inProduction ? (
                        <span className="base-group-iata">IN PRODUCTION</span>
                      ) : group.forSale ? (
                        <span className="base-group-iata">Zu verkaufen</span>
                      ) : group.code ? (
                        <>
                          <span className="base-group-iata">{group.code}</span>
                          {name && <span className="base-group-name">{name}</span>}
                        </>
                      ) : (
                        <span className="base-group-none">No Home Base</span>
                      )}
                      <span className="base-group-badge">{group.aircraft.length}</span>
                    </div>

                    {/* ── Aircraft table ── */}
                    {!collapsed && (
                      <div className="base-group-body">
                        <table className="overview-table">
                          <thead>
                            <tr>
                              <th className="sortable-th" onClick={() => handleSort('status')} style={{ width: '36px', textAlign: 'center' }}>
                                <SortIcon col="status" />
                              </th>
                              <th className="sortable-th" onClick={() => handleSort('registration')}>
                                Registration <SortIcon col="registration" />
                              </th>
                              <th className="sortable-th" onClick={() => handleSort('name')}>
                                Name <SortIcon col="name" />
                              </th>
                              <th className="sortable-th" onClick={() => handleSort('aircraft_type')}>
                                Type <SortIcon col="aircraft_type" />
                              </th>
                              {editMode && (
                                <th className="sortable-th" onClick={() => handleSort('condition')}>
                                  Condition <SortIcon col="condition" />
                                </th>
                              )}
                              {editMode && !group.forSale && !group.inProduction ? (
                                <>
                                  <th>Cabin Profile</th>
                                  <th>Home Base</th>
                                  <th>Decommission</th>
                                </>
                              ) : group.forSale ? (
                                <>
                                  <th>Verkaufspreis</th>
                                  <th>Aktion</th>
                                </>
                              ) : (
                                <>
                                  <th className="sortable-th" onClick={() => handleSort('location')}>
                                    Current Location <SortIcon col="location" />
                                  </th>
                                  <th>Actions</th>
                                </>
                              )}
                            </tr>
                          </thead>
                          <tbody>
                            {group.aircraft.map(ac => {
                              const status = getAircraftStatus(ac);
                              const inProduction = ac.delivery_at && new Date(ac.delivery_at) > new Date();
                              return (
                                <tr key={ac.id} className={`ov-row ov-row--${inProduction ? 'inactive' : status}`}>
                                  <td style={{ textAlign: 'center' }}>
                                    {inProduction ? (
                                      <span style={{
                                        display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
                                        background: '#9ca3af', boxShadow: '0 0 0 3px rgba(156,163,175,0.28)',
                                        flexShrink: 0, verticalAlign: 'middle', position: 'relative', top: -1
                                      }} />
                                    ) : (
                                      <span className={`status-dot status-dot--${status}`}
                                        title={status === 'inactive' ? 'Inactive' : status === 'in-flight' ? 'In Flight' : status === 'boarding' ? 'Boarding' : 'Active'} />
                                    )}
                                  </td>
                                  <td>
                                    <span className="ov-registration">{ac.registration}</span>
                                  </td>
                                  <td className="ov-name">{ac.name || <span className="ov-empty">—</span>}</td>
                                  <td className="ov-type">{ac.aircraft_type}</td>
                                  {editMode && (
                                    <td className="ov-condition">
                                      {(() => {
                                        const c = ac.condition ?? 100;
                                        const color =
                                          c >= 80 ? '#16a34a' :
                                          c >= 60 ? '#4ade80' :
                                          c >= 40 ? '#ca8a04' :
                                          c >= 20 ? '#ea580c' : '#dc2626';
                                        return (
                                          <span style={{ fontWeight: 600, color }}>{Math.round(c)}%</span>
                                        );
                                      })()}
                                    </td>
                                  )}
                                  {editMode && !group.forSale && !group.inProduction ? (
                                    <>
                                      <td>
                                        <select
                                          className="ov-inline-select"
                                          value={ac.cabin_profile_id ?? ''}
                                          onChange={e => handleCabinProfileInlineChange(ac, e.target.value)}
                                        >
                                          <option value="">— None —</option>
                                          {(profilesByType[ac.type_id] || []).map(p => (
                                            <option key={p.id} value={p.id}>{p.name}</option>
                                          ))}
                                        </select>
                                      </td>
                                      <td>
                                        <select
                                          className="ov-inline-select"
                                          value={ac.home_airport ?? ''}
                                          onChange={e => handleHomeBaseChange(ac, e.target.value)}
                                        >
                                          <option value="">— None —</option>
                                          {openedAirports.map(ap => (
                                            <option key={ap.iata_code} value={ap.iata_code}>
                                              {ap.iata_code} – {ap.name}
                                            </option>
                                          ))}
                                        </select>
                                      </td>
                                      <td>
                                        <button
                                          className="ov-btn-decomm"
                                          onClick={() => handleDecommission(ac)}
                                        >
                                          Decommission
                                        </button>
                                      </td>
                                    </>
                                  ) : group.forSale ? (
                                    <>
                                      <td className="ov-listed-price">
                                        {ac.listed_price ? `$${Math.round(ac.listed_price).toLocaleString()}` : '—'}
                                      </td>
                                      <td>
                                        <button
                                          className="ov-btn-schedule"
                                          onClick={() => handleCancelListing(ac)}
                                        >
                                          Verkauf beenden
                                        </button>
                                      </td>
                                    </>
                                  ) : inProduction ? (
                                    <>
                                      <td className="ov-location">
                                        <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 10, background: '#E5E7EB', color: '#6B7280', fontSize: '0.7rem', fontWeight: 700 }}>
                                          In Production
                                        </span>
                                      </td>
                                      <td>
                                        <button
                                          className="ov-btn-schedule"
                                          onClick={() => onSelectAircraft && onSelectAircraft(ac.id)}
                                        >
                                          View Details
                                        </button>
                                      </td>
                                    </>
                                  ) : (
                                    <>
                                      <td className="ov-location">
                                        {status === 'in-flight' ? (
                                          <span className="ov-inflight">
                                            ✈ {ac.active_fn && <>{ac.active_fn}: </>}
                                            {ac.active_dep} → {ac.active_arr}
                                            {ac.active_dep_time && ac.active_arr_time && (() => {
                                              const now = Date.now();
                                              const dep = new Date(ac.active_dep_time).getTime();
                                              const arr = new Date(ac.active_arr_time).getTime();
                                              const pct = Math.min(100, Math.max(0, Math.round((now - dep) / (arr - dep) * 100)));
                                              return <> ({pct}%)</>;
                                            })()}
                                          </span>
                                        ) : (
                                          <span className="ov-ground">
                                            {(ac.current_location || ac.home_airport) ? (
                                              <AirportLink code={ac.current_location || ac.home_airport} onNavigate={onNavigateToAirport} />
                                            ) : 'Unknown'}
                                          </span>
                                        )}
                                      </td>
                                      <td>
                                        <button
                                          className="ov-btn-schedule"
                                          onClick={() => onSelectAircraft && onSelectAircraft(ac.id)}
                                        >
                                          View Schedule
                                        </button>
                                      </td>
                                    </>
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* ── Cabin Profile Assignment Modal ── */}
      {cpModal && (
        <div className="cp-modal-overlay" onClick={closeCpModal}>
          <div className="cp-modal" onClick={e => e.stopPropagation()}>
            <div className="cp-modal-head">
              <h3>Assign Cabin Profile</h3>
              <button className="cp-modal-close" onClick={closeCpModal}>&times;</button>
            </div>
            <div className="cp-modal-body">
              {cpProfiles.length === 0 ? (
                <p className="cp-modal-empty">
                  No cabin profiles available for this aircraft type.
                  Create one in <strong>Cabin Profiles</strong> first.
                </p>
              ) : (
                <div className="cp-modal-profiles">
                  <label className="cp-modal-label">
                    <input
                      type="radio"
                      name="cp"
                      value=""
                      checked={cpSelected === ''}
                      onChange={() => setCpSelected('')}
                    />
                    <span>None</span>
                  </label>
                  {cpProfiles.map(p => (
                    <label key={p.id} className="cp-modal-label">
                      <input
                        type="radio"
                        name="cp"
                        value={p.id}
                        checked={cpSelected === String(p.id)}
                        onChange={() => setCpSelected(String(p.id))}
                      />
                      <span>
                        <strong>{p.name}</strong>
                        <span className="cp-modal-cap"> — {p.total_capacity} seats</span>
                        {p.classes.map(c => (
                          <span key={c.class_type} className="cp-modal-cls">
                            {c.class_type.charAt(0).toUpperCase()}: {c.actual_capacity}
                          </span>
                        ))}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="cp-modal-foot">
              <button className="cp-modal-btn-cancel" onClick={closeCpModal}>Cancel</button>
              <button
                className="cp-modal-btn-save"
                onClick={saveCpAssignment}
                disabled={cpSaving}
              >
                {cpSaving ? 'Saving...' : 'Assign'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Decommission Modal ── */}
      {decommModal && (() => {
        const ac = decommModal;
        const scrapVal = Math.round((ac.new_price_usd || 0) * 0.05);
        const marketVal = Math.round(calculateCurrentValue(ac));
        return (
          <div className="decomm-modal-overlay" onClick={() => setDecommModal(null)}>
            <div className="decomm-modal" onClick={e => e.stopPropagation()}>
              <div className="decomm-modal-head">
                <h3>Decommission {ac.registration}</h3>
                <button className="decomm-modal-close" onClick={() => setDecommModal(null)}>&times;</button>
              </div>
              <div className="decomm-modal-body">
                <p className="decomm-modal-sub">{ac.aircraft_type}</p>
                <p style={{fontSize:'0.85rem',color:'#666',margin:'0 0 1.25rem'}}>
                  Choose how to remove this aircraft from your fleet:
                </p>
                <div className="decomm-options">
                  <div className="decomm-option">
                    <div className="decomm-option-title">Scrap</div>
                    <div className="decomm-option-desc">Receive 5% of the original purchase price as scrap metal value.</div>
                    <div className="decomm-option-value">{formatAircraftValue(scrapVal)}</div>
                    <button className="decomm-btn-scrap" onClick={handleScrap}>Scrap Aircraft</button>
                  </div>
                  <div className="decomm-option decomm-option--market">
                    <div className="decomm-option-title">Sell on Used Market</div>
                    <div className="decomm-option-desc">List on the used aircraft market at current market value. Buyers can purchase it.</div>
                    <div className="decomm-option-value">{formatAircraftValue(marketVal)}</div>
                    <button className="decomm-btn-market" onClick={handleSellToMarket}>Sell to Market</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      <style>{`
        .fleet-page {
          min-height: 100vh;
          background: #F5F5F5;
        }

        .loading-container {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          color: #2C2C2C;
        }

        .loading-spinner {
          width: 50px;
          height: 50px;
          border: 4px solid #E0E0E0;
          border-top-color: #2C2C2C;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        /* Hero Section */
        .fleet-hero {
          width: 100%;
          height: 350px;
          background: linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.6)),
                      url('/header-images/Headerimage_Fleet.png') center/cover;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .fleet-hero-overlay {
          text-align: center;
          color: white;
        }

        .fleet-hero h1 {
          font-size: 3rem;
          margin: 0;
          text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }

        .fleet-hero p {
          font-size: 1.25rem;
          margin-top: 0.5rem;
          opacity: 0.9;
        }

        /* Container */
        .fleet-container {
          max-width: 1100px;
          margin: 0 auto;
          padding: 24px;
        }

        /* Top Bar */
        .fleet-top-bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1.5rem;
          flex-wrap: wrap;
          gap: 1rem;
        }

        .btn-back {
          background: #2C2C2C;
          color: white;
          border: none;
          padding: 0.75rem 1.5rem;
          border-radius: 6px;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 0.5rem;
          transition: opacity 0.2s;
        }

        .btn-back:hover {
          opacity: 0.85;
        }

        .back-arrow {
          font-size: 1.25rem;
        }

        .balance-display {
          background: white;
          padding: 0.75rem 1.5rem;
          border-radius: 6px;
          color: #2C2C2C;
          border: 1px solid #E0E0E0;
        }

        .balance-label {
          margin-right: 0.5rem;
          color: #666666;
        }

        .balance-amount {
          font-weight: 700;
          font-size: 1.1rem;
        }

        /* Messages */
        .message {
          padding: 1rem;
          border-radius: 6px;
          margin-bottom: 1rem;
          text-align: center;
        }

        .error-message {
          background: #fee2e2;
          color: #dc2626;
          border: 1px solid #fca5a5;
        }

        /* Section Styling */
        .fleet-section {
          background: white;
          border-radius: 8px;
          padding: 2rem;
          margin-bottom: 2rem;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          overflow: hidden;
        }

        .fleet-section-bar {
          background: #2C2C2C;
          color: white;
          padding: 14px 20px;
          margin: -2rem -2rem 1.5rem;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          border-radius: 8px 8px 0 0;
        }

        .fleet-section-bar-title {
          font-size: 0.78rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: white;
        }


        .section-subtitle {
          margin: 0;
          color: #666666;
        }

        /* Buy Aircraft button */
        .btn-buy-aircraft {
          background: #2C2C2C;
          color: white;
          border: none;
          padding: 0.65rem 1.25rem;
          border-radius: 6px;
          font-size: 0.95rem;
          font-weight: 600;
          cursor: pointer;
          transition: opacity 0.2s;
          white-space: nowrap;
          flex-shrink: 0;
        }

        .btn-buy-aircraft:hover {
          opacity: 0.85;
        }

        /* Fleet Type Grid */
        .fleet-type-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1.25rem;
        }

        .fleet-type-card {
          background: white;
          border-radius: 8px;
          border: 1px solid #EEEEEE;
          overflow: hidden;
        }

        .fleet-type-hd {
          background: #F5F5F5;
          padding: 0.6rem 1rem 0.65rem;
          border-bottom: 1px solid #EEEEEE;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
        }

        .fleet-type-manufacturer {
          margin: 0 0 0.1rem;
          font-size: 0.72rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #999;
        }

        .fleet-type-model {
          margin: 0;
          font-size: 1.05rem;
          font-weight: 700;
          color: #2C2C2C;
          line-height: 1.2;
        }

        .fleet-type-img-wrap {
          margin: 0.6rem 0;
          width: 100%;
          aspect-ratio: 10 / 3;
          overflow: hidden;
          background: #1a1a1a;
        }

        .fleet-type-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          object-position: center;
          display: block;
        }

        .fleet-type-img-placeholder {
          width: 100%;
          height: 100%;
          background: #2C2C2C;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .fleet-type-placeholder-icon {
          width: 48px;
          height: 48px;
          color: rgba(255,255,255,0.3);
        }

        .fleet-type-count {
          font-size: 1.05rem;
          font-weight: 700;
          color: #2C2C2C;
        }

        .empty-fleet {
          text-align: center;
          padding: 3rem;
          color: #999;
        }

        .empty-icon {
          width: 60px;
          height: 60px;
          opacity: 0.3;
          margin-bottom: 1rem;
        }

        /* Responsive */
        @media (max-width: 900px) {
          .fleet-type-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }

        @media (max-width: 768px) {
          .fleet-hero {
            height: 220px;
          }

          .fleet-hero h1 {
            font-size: 2rem;
          }

          .fleet-section {
            padding: 1.5rem;
          }

          .fleet-top-bar {
            flex-direction: column;
            align-items: stretch;
          }

          .section-header {
            flex-direction: column;
            align-items: stretch;
          }
        }

        @media (max-width: 560px) {
          .fleet-type-grid {
            grid-template-columns: 1fr;
          }
        }

        /* ── Fleet Overview ──────────────────────────────────────────────── */
        .overview-section {
          background: white;
          border-radius: 8px;
          padding: 2rem;
          margin-bottom: 2rem;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          overflow: hidden;
        }

        .base-accordion {
          border: 1px solid #E0E0E0;
          border-radius: 6px;
          margin-bottom: 0.75rem;
          overflow: hidden;
        }

        .base-accordion:last-child {
          margin-bottom: 0;
        }

        .base-accordion-header {
          width: 100%;
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0.85rem 1.1rem;
          background: #F8F8F8;
          border: none;
          cursor: pointer;
          text-align: left;
          transition: background 0.15s;
          gap: 1rem;
        }

        .base-accordion-header:hover {
          background: #F0F0F0;
        }

        .base-accordion-label {
          font-weight: 600;
          font-size: 0.95rem;
          color: #2C2C2C;
        }

        .base-accordion-right {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          flex-shrink: 0;
        }

        .base-count {
          font-size: 0.8rem;
          color: #666;
          background: #E8E8E8;
          padding: 0.2rem 0.6rem;
          border-radius: 12px;
          font-weight: 600;
        }

        .accordion-chevron {
          font-size: 0.7rem;
          color: #999;
        }

        .base-group-body { overflow-x: auto; }

        .overview-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.875rem;
        }

        .overview-table thead tr {
          background: #FAFAFA;
          border-bottom: 2px solid #E8E8E8;
        }

        .overview-table th {
          padding: 0.6rem 1rem;
          text-align: left;
          font-weight: 600;
          color: #555;
          font-size: 0.8rem;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          white-space: nowrap;
        }

        .sortable-th {
          cursor: pointer;
          user-select: none;
        }

        .sortable-th:hover {
          color: #2C2C2C;
          background: #F0F0F0;
        }

        .overview-table td {
          padding: 0.65rem 1rem;
          border-bottom: 1px solid #F2F2F2;
          vertical-align: middle;
          color: #2C2C2C;
        }

        .overview-table tbody tr:last-child td {
          border-bottom: none;
        }

        .overview-table tbody tr:hover td {
          background: #FAFAFA;
        }

        /* ── Collapsible home base groups ── */
        .base-groups-wrap { display: flex; flex-direction: column; gap: 10px; }

        .base-group { border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }

        .base-group-hd {
          display: flex; align-items: center; gap: 10px;
          background: #EBEBEB; color: #2C2C2C;
          padding: 10px 16px;
          cursor: pointer;
          user-select: none;
          transition: background 0.15s;
          border: 1px solid #DCDCDC;
        }
        .base-group-hd:hover { background: #E0E0E0; }
        .base-group-hd--for-sale { background: #FEF3C7; border-color: #FCD34D; }
        .base-group-hd--for-sale:hover { background: #FDE68A; }
        .base-group-hd--for-sale .base-group-badge { background: #D97706; }
        .base-group-for-sale-label { font-weight: 700; font-size: 0.9rem; color: #92400E; }

        .base-group-chevron { font-size: 0.7rem; opacity: 0.5; flex-shrink: 0; }
        .base-group-iata {
          font-family: monospace; font-weight: 800; font-size: 0.95rem;
          letter-spacing: 0.06em; flex-shrink: 0; color: #2C2C2C;
        }
        .base-group-name { font-size: 0.85rem; color: #555; }
        .base-group-none { font-size: 0.85rem; color: #999; font-style: italic; }
        .base-group-badge {
          margin-left: auto; background: #2C2C2C;
          color: white; font-size: 0.7rem; font-weight: 700;
          padding: 2px 8px; border-radius: 10px;
        }

        .base-group-body { background: white; border: 1px solid #DCDCDC; border-top: none; overflow-x: auto; }

        /* Status dot */
        .status-dot {
          display: inline-block;
          width: 10px; height: 10px;
          border-radius: 50%;
          margin-right: 0.5rem;
          flex-shrink: 0;
          vertical-align: middle;
          position: relative;
          top: -1px;
        }

        .status-dot--ground      { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,0.22); }
        .status-dot--boarding    { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,0.22); }
        .status-dot--in-flight   { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,0.22);
                                   animation: fleet-dot-pulse 1.6s ease-in-out infinite; }
        .status-dot--maintenance { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,0.22); }
        .status-dot--inactive    { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,0.22); }
        @keyframes fleet-dot-pulse {
          0%   { box-shadow: 0 0 0 3px rgba(34,197,94,0.4); }
          50%  { box-shadow: 0 0 0 6px rgba(34,197,94,0.06); }
          100% { box-shadow: 0 0 0 3px rgba(34,197,94,0.4); }
        }

        .ov-registration {
          font-family: monospace;
          font-weight: 700;
          font-size: 0.9rem;
          letter-spacing: 0.03em;
        }

        .ov-name { color: #444; }

        .ov-type { color: #555; }
        .ov-condition { white-space: nowrap; font-size: 0.85rem; }

        .ov-empty { color: #CCC; }

        .ov-inflight {
          display: inline-block;
          background: #2C2C2C;
          color: #fff;
          font-size: 0.78rem;
          font-weight: 600;
          letter-spacing: 0.03em;
          border-radius: 4px;
          padding: 2px 8px;
          white-space: nowrap;
        }

        .ov-maint {
          color: #9ca3af;
          font-style: italic;
        }

        .ov-ground {
          color: #444;
          font-size: 0.875rem;
        }

        .ov-btn-schedule {
          padding: 0.3rem 0.75rem;
          background: white;
          border: 1px solid #2C2C2C;
          border-radius: 4px;
          font-size: 0.8rem;
          font-weight: 600;
          cursor: pointer;
          color: #2C2C2C;
          white-space: nowrap;
          transition: background 0.15s, color 0.15s;
        }

        .ov-btn-schedule:hover {
          background: #2C2C2C;
          color: white;
        }

        .ov-btn-cancel-listing {
          padding: 0.3rem 0.75rem;
          background: white;
          border: 1px solid #D97706;
          border-radius: 4px;
          font-size: 0.8rem;
          font-weight: 600;
          cursor: pointer;
          color: #92400E;
          white-space: nowrap;
          transition: background 0.15s, color 0.15s;
        }
        .ov-btn-cancel-listing:hover { background: #D97706; color: white; }

        .ov-listed-price { font-size: 0.85rem; color: #2C2C2C; font-weight: 600; }

        .ov-btn-edit-mode {
          padding: 0.3rem 0.9rem;
          background: transparent;
          border: 1px solid rgba(255,255,255,0.5);
          color: white;
          border-radius: 6px;
          font-size: 0.78rem;
          font-weight: 600;
          cursor: pointer;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          transition: background 0.15s, border-color 0.15s;
        }
        .ov-btn-edit-mode:hover { background: rgba(255,255,255,0.15); border-color: white; }
        .ov-btn-edit-mode--active { background: white; color: #2C2C2C; border-color: white; }
        .ov-btn-edit-mode--active:hover { background: #E0E0E0; }

        .ov-btn-toggle-all {
          padding: 0.3rem 0.7rem;
          background: transparent;
          border: 1px solid rgba(255,255,255,0.5);
          color: white;
          border-radius: 6px;
          font-size: 0.72rem;
          font-weight: 600;
          cursor: pointer;
          letter-spacing: 0.03em;
          transition: background 0.15s, border-color 0.15s;
        }
        .ov-btn-toggle-all:hover { background: rgba(255,255,255,0.15); border-color: white; }

        .ov-inline-select {
          padding: 0.25rem 0.4rem;
          border: 1px solid #E0E0E0;
          border-radius: 4px;
          font-size: 0.82rem;
          background: white;
          color: #2C2C2C;
          max-width: 180px;
          cursor: pointer;
        }
        .ov-inline-select:focus { outline: none; border-color: #2C2C2C; }

        .ov-btn-decomm {
          padding: 0.3rem 0.75rem;
          background: white;
          border: 1px solid #dc2626;
          color: #dc2626;
          border-radius: 6px;
          font-size: 0.8rem;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s, color 0.15s;
        }
        .ov-btn-decomm:hover { background: #dc2626; color: white; }

        /* Decommission choice modal */
        .decomm-modal-overlay { position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000;padding:1rem; }
        .decomm-modal { background:white;border-radius:12px;width:100%;max-width:520px;overflow:hidden; }
        .decomm-modal-head { background:#2C2C2C;color:white;padding:1.25rem 1.5rem;display:flex;justify-content:space-between;align-items:center; }
        .decomm-modal-head h3 { margin:0;font-size:1.05rem;font-weight:700; }
        .decomm-modal-close { background:none;border:none;color:white;font-size:1.5rem;cursor:pointer;opacity:0.7;line-height:1; }
        .decomm-modal-close:hover { opacity:1; }
        .decomm-modal-body { padding:1.5rem; }
        .decomm-modal-sub { font-weight:600;color:#444;margin:0 0 0.5rem;font-size:0.9rem; }
        .decomm-options { display:grid;grid-template-columns:1fr 1fr;gap:1rem; }
        .decomm-option { border:1px solid #E0E0E0;border-radius:8px;padding:1.1rem;display:flex;flex-direction:column;gap:0.5rem; }
        .decomm-option--market { border-color:#2C2C2C; }
        .decomm-option-title { font-weight:700;font-size:0.85rem;color:#2C2C2C;text-transform:uppercase;letter-spacing:0.05em; }
        .decomm-option-desc { font-size:0.78rem;color:#666;line-height:1.4;flex:1; }
        .decomm-option-value { font-size:1.2rem;font-weight:700;color:#2C2C2C; }
        .decomm-btn-scrap,.decomm-btn-market { padding:0.5rem;border-radius:6px;font-size:0.82rem;font-weight:600;cursor:pointer;border:none;width:100%; }
        .decomm-btn-scrap { background:#F5F5F5;color:#DC2626;border:1px solid #DC2626; }
        .decomm-btn-scrap:hover { background:#DC2626;color:white; }
        .decomm-btn-market { background:#2C2C2C;color:white; }
        .decomm-btn-market:hover { background:#1a1a1a; }

        /* Cabin profile column */
        .ov-cabin-profile {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .ov-cp-name {
          font-size: 0.82rem;
          color: #2C2C2C;
          font-weight: 500;
        }
        .ov-cp-unassigned {
          font-size: 0.78rem;
          color: #d97706;
          background: #fef3c7;
          border: 1px solid #fcd34d;
          padding: 0.1rem 0.4rem;
          border-radius: 4px;
        }
        .ov-btn-assign-cp {
          padding: 2px 8px;
          background: transparent;
          border: 1px solid #C0C0C0;
          border-radius: 4px;
          color: #555;
          font-size: 0.75rem;
          cursor: pointer;
          white-space: nowrap;
        }
        .ov-btn-assign-cp:hover { border-color: #2C2C2C; color: #2C2C2C; }

        /* Cabin Profile modal */
        .cp-modal-overlay {
          position: fixed; inset: 0;
          background: rgba(0,0,0,0.45);
          display: flex; align-items: center; justify-content: center;
          z-index: 9999; padding: 16px;
        }
        .cp-modal {
          background: white; border-radius: 12px;
          width: 100%; max-width: 420px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.2);
          overflow: hidden;
        }
        .cp-modal-head {
          display: flex; justify-content: space-between; align-items: center;
          padding: 18px 20px; border-bottom: 1px solid #E0E0E0;
        }
        .cp-modal-head h3 { margin: 0; font-size: 1rem; color: #2C2C2C; }
        .cp-modal-close {
          background: none; border: none; font-size: 1.4rem;
          color: #888; cursor: pointer; line-height: 1;
        }
        .cp-modal-close:hover { color: #2C2C2C; }
        .cp-modal-body { padding: 20px; }
        .cp-modal-empty { color: #666; font-size: 14px; }
        .cp-modal-profiles { display: flex; flex-direction: column; gap: 10px; }
        .cp-modal-label {
          display: flex; align-items: flex-start; gap: 10px;
          padding: 10px 12px; border: 1px solid #E0E0E0; border-radius: 7px;
          cursor: pointer; font-size: 14px; color: #2C2C2C;
        }
        .cp-modal-label:hover { background: #F9F9F9; }
        .cp-modal-label input { margin-top: 2px; flex-shrink: 0; }
        .cp-modal-cap { color: #888; font-weight: 400; }
        .cp-modal-cls {
          display: inline-block; background: #F0F0F0; border-radius: 3px;
          padding: 1px 5px; font-size: 0.72rem; color: #555; margin-left: 4px;
        }
        .cp-modal-foot {
          display: flex; gap: 10px; padding: 14px 20px; border-top: 1px solid #E0E0E0; justify-content: flex-end;
        }
        .cp-modal-btn-cancel {
          background: white; border: 1px solid #E0E0E0; color: #2C2C2C;
          padding: 9px 18px; border-radius: 6px; cursor: pointer; font-size: 14px;
        }
        .cp-modal-btn-cancel:hover { background: #F5F5F5; }
        .cp-modal-btn-save {
          background: #2C2C2C; color: white; border: none;
          padding: 9px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600;
        }
        .cp-modal-btn-save:hover { background: #444; }
        .cp-modal-btn-save:disabled { opacity: 0.6; cursor: not-allowed; }

        @media (max-width: 768px) {
          .overview-section {
            padding: 1.25rem;
          }
          .overview-table th,
          .overview-table td {
            padding: 0.5rem 0.65rem;
          }
        }
      `}</style>
    </div>
  );
}

export default FleetPage;
