import { useState, useEffect, useMemo, useCallback } from 'react';
import TopBar from '../components/TopBar.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

const TYPE_META = {
  home_base:      { label: 'Home Base',       dark: true },
  hub:            { label: 'Hub',             dark: true },
  hub_restricted: { label: 'Hub', dark: true },
  base:           { label: 'Base',            dark: true },
  destination:    { label: 'Destination',     dark: false },
};

const OPEN_COST = 10_000;


function fmtCost(n) {
  return '$' + n.toLocaleString('en-US');
}

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

const CONTINENTS = ['Africa', 'Asia', 'Europe', 'North America', 'Oceania', 'South America'];

export default function HubsDestinations({ airline, onBack, backLabel = 'Dashboard', onNavigateToAirport, onBalanceUpdate, onNavigate }) {
  // ── Destinations list ──────────────────────────────────────────────────────
  const [destinations, setDestinations] = useState([]);
  const [destLoading, setDestLoading] = useState(true);
  const [destError, setDestError] = useState('');

  const [sortCol, setSortCol] = useState('destination_type');
  const [sortDir, setSortDir] = useState('asc');
  const [search, setSearch] = useState('');

  // ── Add view ───────────────────────────────────────────────────────────────
  const [view, setView] = useState('list'); // 'list' | 'add'
  const [allAirports, setAllAirports] = useState([]);
  const [airportsLoading, setAirportsLoading] = useState(false);
  const [filterContinent, setFilterContinent] = useState('');
  const [filterCountry, setFilterCountry] = useState('');
  const [addSearch, setAddSearch] = useState('');
  const [opening, setOpening] = useState(null);

  // ── Edit modal ─────────────────────────────────────────────────────────────
  const [editDest, setEditDest] = useState(null);
  const [deleting, setDeleting] = useState(null);

  // ── Expansions ─────────────────────────────────────────────────────────────
  const [expansions, setExpansions] = useState([]);
  const [expansionsLoading, setExpansionsLoading] = useState(true);
  const [showExpModal, setShowExpModal] = useState(false);
  const [expAirport, setExpAirport] = useState('');
  const [expPurchasing, setExpPurchasing] = useState(false);
  const [expError, setExpError] = useState('');

  // ── Manage Hub modal ───────────────────────────────────────────────────────
  const [manageHub, setManageHub] = useState(null); // expansion object
  const [manageAction, setManageAction] = useState(null); // 'buy' | 'sell'
  const [manageLoading, setManageLoading] = useState(false);
  const [manageError, setManageError] = useState('');

  // ── Fetch helpers ──────────────────────────────────────────────────────────
  const fetchDestinations = useCallback(async () => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/destinations`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setDestinations(data.destinations || []);
    } catch {
      setDestError('Failed to load destinations');
    } finally {
      setDestLoading(false);
    }
  }, []);

  const fetchAllAirports = useCallback(async () => {
    setAirportsLoading(true);
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/airports/available`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setAllAirports(data.airports || []);
    } catch {
      setAllAirports([]);
    } finally {
      setAirportsLoading(false);
    }
  }, []);

  const fetchExpansions = useCallback(async () => {
    setExpansionsLoading(true);
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/expansions`, { headers: { 'Authorization': `Bearer ${token}` } });
      const data = await res.json();
      setExpansions(data.expansions || []);
    } catch { /* ignore */ }
    finally { setExpansionsLoading(false); }
  }, []);

  useEffect(() => { fetchDestinations(); fetchExpansions(); }, [fetchDestinations, fetchExpansions]);

  // ── Purchase Expansion (from "New Hub" modal) ──────────────────────────────
  const handlePurchaseExpansion = async (airportCode) => {
    const code = airportCode || expAirport;
    if (!code) return;
    setExpPurchasing(true); setExpError('');
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/expansions/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ airport_code: code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      if (data.new_balance != null) onBalanceUpdate?.(data.new_balance);
      setShowExpModal(false); setExpAirport('');
      await fetchExpansions();
    } catch (err) { setExpError(err.message); }
    finally { setExpPurchasing(false); }
  };

  // ── Manage Hub: buy next level ─────────────────────────────────────────────
  const handleBuyNextLevel = async () => {
    if (!manageHub) return;
    setManageLoading(true); setManageError('');
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/expansions/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ airport_code: manageHub.airport_code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      if (data.new_balance != null) onBalanceUpdate?.(data.new_balance);
      await fetchExpansions();
      setManageHub(prev => prev ? {
        ...prev,
        expansion_level: data.expansion_level,
        capacity: data.capacity,
        next_level_cost: data.next_level_cost,
        next_level: data.expansion_level + 1,
      } : null);
      setManageAction(null);
    } catch (err) { setManageError(err.message); }
    finally { setManageLoading(false); }
  };

  // ── Manage Hub: sell hub ───────────────────────────────────────────────────
  const handleSellHub = async () => {
    if (!manageHub) return;
    setManageLoading(true); setManageError('');
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/expansions/${manageHub.airport_code}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      if (data.new_balance != null) onBalanceUpdate?.(data.new_balance);
      setManageHub(null); setManageAction(null);
      await fetchExpansions();
    } catch (err) { setManageError(err.message); }
    finally { setManageLoading(false); }
  };

  // ── Open destination ───────────────────────────────────────────────────────
  const handleOpenDestination = async (airportCode) => {
    setOpening(airportCode);
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/destinations/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ airport_code: airportCode, destination_type: 'destination' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      if (data.new_balance != null) onBalanceUpdate?.(data.new_balance);
      setAllAirports(prev => prev.map(a => a.iata_code === airportCode ? { ...a, is_opened: true } : a));
      await fetchDestinations();
    } catch (err) {
      alert(err.message);
    } finally {
      setOpening(null);
    }
  };

  // ── Open "Add" view ────────────────────────────────────────────────────────
  const handleOpenAddView = () => {
    setView('add');
    setAddSearch('');
    setFilterContinent('');
    setFilterCountry('');
    if (allAirports.length === 0) fetchAllAirports();
  };

  // ── Delete destination ─────────────────────────────────────────────────────
  const handleDeleteDestination = async (dest) => {
    if (!confirm(`Close ${dest.airport_code} – ${dest.airport_name}? This cannot be undone.`)) return;
    setDeleting(dest.airport_code);
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/destinations/${dest.airport_code}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      await fetchDestinations();
    } catch (err) {
      alert(err.message);
    } finally {
      setDeleting(null);
    }
  };

  // ── Destinations table sort + filter ──────────────────────────────────────
  const sorted = useMemo(() => {
    let list = [...destinations];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(d =>
        d.airport_code.toLowerCase().includes(q) ||
        d.airport_name.toLowerCase().includes(q) ||
        d.country.toLowerCase().includes(q) ||
        (d.continent || '').toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => {
      let av, bv;
      if (sortCol === 'destination_type') {
        const o = { home_base: 0, hub: 1, hub_restricted: 2, base: 3, destination: 4 };
        av = o[a.display_type || a.destination_type] ?? 5; bv = o[b.display_type || b.destination_type] ?? 5;
      } else if (sortCol === 'airport') {
        av = a.airport_name; bv = b.airport_name;
      } else if (sortCol === 'continent') {
        av = a.continent || ''; bv = b.continent || '';
      } else if (sortCol === 'country') {
        av = a.country; bv = b.country;
      } else if (sortCol === 'weekly_flights') {
        av = a.weekly_flights; bv = b.weekly_flights;
      } else {
        av = a[sortCol] ?? ''; bv = b[sortCol] ?? '';
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return list;
  }, [destinations, search, sortCol, sortDir]);

  const handleSort = (col) => {
    setSortCol(c => { if (c === col) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); return c; } setSortDir('asc'); return col; });
  };
  const sortArrow = (col) =>
    sortCol !== col
      ? <span style={{ color: '#ccc', marginLeft: 4 }}>↕</span>
      : <span style={{ color: '#2C2C2C', marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>;

  const hubCount = destinations.filter(d => d.display_type === 'hub' || d.display_type === 'hub_restricted').length;
  const baseCount = destinations.filter(d => d.effective_type === 'base').length;

  // Expansion cost preview for selected airport
  const MULTIPLIERS = [1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0];
  const expSelectedDest = destinations.find(d => d.airport_code === expAirport);
  const expExisting = expansions.find(e => e.airport_code === expAirport);
  const expCurrentLevel = expExisting?.expansion_level || 0;
  const expNextLevel = expCurrentLevel + 1;
  const expCategory = expSelectedDest?.category || 4;
  const expMultiplier = expCurrentLevel >= 9 ? 8.0 : MULTIPLIERS[expCurrentLevel];
  const expCost = expSelectedDest ? Math.round(expCategory * expMultiplier * 1_000_000) : null;

  // ── Add view: country list based on continent ──────────────────────────────
  const countriesInContinent = useMemo(() => {
    const src = filterContinent
      ? allAirports.filter(a => a.continent === filterContinent)
      : allAirports;
    return [...new Set(src.map(a => a.country).filter(Boolean))].sort();
  }, [allAirports, filterContinent]);

  // Reset country when continent changes
  const handleContinentChange = (val) => {
    setFilterContinent(val);
    setFilterCountry('');
  };

  // ── Add view: filtered + grouped airports ─────────────────────────────────
  const filteredAirports = useMemo(() => {
    let list = allAirports;
    if (filterContinent) list = list.filter(a => a.continent === filterContinent);
    if (filterCountry)   list = list.filter(a => a.country === filterCountry);
    if (addSearch.trim()) {
      const q = addSearch.toLowerCase();
      list = list.filter(a =>
        a.iata_code.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        a.country.toLowerCase().includes(q)
      );
    }
    return list;
  }, [allAirports, filterContinent, filterCountry, addSearch]);

  const groupedAirports = useMemo(() => {
    const groups = {};
    for (const ap of filteredAirports) {
      const letter = ap.iata_code[0].toUpperCase();
      if (!groups[letter]) groups[letter] = [];
      groups[letter].push(ap);
    }
    return Object.keys(groups).sort().map(letter => ({ letter, airports: groups[letter] }));
  }, [filteredAirports]);

  return (
    <>
      <style>{`
        .hd-page { background: #F5F5F5; min-height: 100vh; }
        .hd-container { max-width: 1200px; margin: 0 auto; padding: 24px 24px 48px; }

        /* ── Card shell ── */
        .hd-card {
          background: #fff; border-radius: 8px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden;
        }
        .hd-card-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 14px 20px; gap: 12px;
          background: #2C2C2C; border-radius: 8px 8px 0 0;
        }
        .hd-card-title { font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: white; margin: 0; }
        .hd-card-sub { font-size: 12px; color: rgba(255,255,255,0.6); margin: 2px 0 0; }

        /* ── Buttons ── */
        .hd-btn-primary {
          background: #2C2C2C; color: #fff; border: none; border-radius: 6px;
          padding: 8px 16px; font-size: 14px; cursor: pointer; white-space: nowrap;
        }
        .hd-btn-primary:hover { background: #444; }
        .hd-btn-secondary {
          background: #fff; color: #2C2C2C; border: 1px solid #E0E0E0; border-radius: 6px;
          padding: 8px 16px; font-size: 14px; cursor: pointer;
        }
        .hd-btn-secondary:hover { background: #F5F5F5; }
        .hd-btn-sm {
          padding: 5px 12px; font-size: 13px; background: #fff; color: #2C2C2C;
          border: 1px solid #E0E0E0; border-radius: 6px; cursor: pointer;
        }
        .hd-btn-sm:hover { background: #F5F5F5; }
        .hd-btn-sm-danger {
          padding: 5px 12px; font-size: 13px; background: #fff; color: #dc2626;
          border: 1px solid #fca5a5; border-radius: 6px; cursor: pointer;
        }
        .hd-btn-sm-danger:hover { background: #fef2f2; }
        .hd-btn-sm-danger:disabled { opacity: 0.5; cursor: not-allowed; }

        /* ── Destinations table ── */
        .hd-search-row {
          display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
          padding: 14px 24px; border-bottom: 1px solid #F0F0F0;
        }
        .hd-search-row input {
          flex: 1; min-width: 180px; max-width: 320px;
          padding: 8px 12px; font-size: 14px;
          border: 1px solid #E0E0E0; border-radius: 6px; outline: none;
        }
        .hd-search-row input:focus { border-color: #2C2C2C; }
        .hd-stats { font-size: 13px; color: #666; margin-left: auto; white-space: nowrap; }
        .hd-table-wrap { overflow-x: auto; }
        .hd-table { width: 100%; border-collapse: collapse; font-size: 14px; }
        .hd-table th {
          text-align: left; padding: 10px 16px; font-size: 12px; font-weight: 600;
          color: #666; text-transform: uppercase; letter-spacing: 0.05em;
          background: #FAFAFA; border-bottom: 1px solid #E0E0E0;
          cursor: pointer; user-select: none; white-space: nowrap;
        }
        .hd-table th:hover { color: #2C2C2C; }
        .hd-table td {
          padding: 12px 16px; color: #2C2C2C;
          border-bottom: 1px solid #F5F5F5; vertical-align: middle;
        }
        .hd-table tr:last-child td { border-bottom: none; }
        .hd-table tr:hover td { background: #FAFAFA; }
        .hd-type-badge {
          display: inline-block;
          padding: 3px 10px; border-radius: 4px;
          background: #2C2C2C; color: #fff;
          font-size: 12px; font-weight: 600; white-space: nowrap;
        }
        .hd-iata-link {
          font-family: monospace; font-weight: 700; font-size: 15px;
          color: #2C2C2C; text-decoration: underline; cursor: pointer;
          text-underline-offset: 2px; text-decoration-color: rgba(0,0,0,0.35);
          background: none; border: none; padding: 0; font: inherit;
        }
        .hd-iata-link:hover { color: #555; }
        .hd-empty { text-align: center; padding: 48px 24px; color: #666; }

        /* ── Add view: filter bar ── */
        .add-filter-bar {
          display: flex; gap: 12px; flex-wrap: wrap; align-items: center;
          padding: 16px 24px; border-bottom: 1px solid #E0E0E0; background: #FAFAFA;
        }
        .add-filter-bar input,
        .add-filter-bar select {
          padding: 8px 12px; font-size: 14px;
          border: 1px solid #E0E0E0; border-radius: 6px; outline: none;
          background: #fff;
        }
        .add-filter-bar input { flex: 1; min-width: 200px; max-width: 340px; }
        .add-filter-bar input:focus,
        .add-filter-bar select:focus { border-color: #2C2C2C; }
        .add-filter-count {
          margin-left: auto; font-size: 13px; color: #666; white-space: nowrap;
        }

        /* ── Add view: groups + grid ── */
        .add-scroll { padding: 0 24px 32px; overflow-y: auto; max-height: calc(100vh - 280px); }
        .add-letter-divider {
          display: flex; align-items: center; gap: 12px;
          margin: 28px 0 16px;
        }
        .add-letter-divider:first-child { margin-top: 24px; }
        .add-letter-label {
          font-size: 18px; font-weight: 700; color: #2C2C2C;
          min-width: 28px; text-align: center;
        }
        .add-letter-line {
          flex: 1; height: 1px; background: #E0E0E0;
        }
        .add-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 12px;
        }
        @media (max-width: 1100px) { .add-grid { grid-template-columns: repeat(3, 1fr); } }
        @media (max-width: 720px)  { .add-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 420px)  { .add-grid { grid-template-columns: 1fr; } }

        /* ── Airport card ── */
        .ap-card {
          border: 1px solid #E0E0E0; border-radius: 8px;
          background: #fff; padding: 14px 16px;
          display: flex; flex-direction: column; gap: 4px;
          position: relative; transition: box-shadow 0.15s;
        }
        .ap-card:hover { box-shadow: 0 3px 10px rgba(0,0,0,0.1); }
        .ap-card.is-opened { background: #FAFAFA; border-color: #D0D0D0; }
        .ap-card-iata {
          font-family: monospace; font-size: 24px; font-weight: 800;
          color: #2C2C2C; letter-spacing: 0.02em; line-height: 1;
        }
        .ap-card.is-opened .ap-card-iata { color: #888; }
        .ap-card-name {
          font-size: 12px; color: #444; line-height: 1.3;
          margin-top: 2px; font-weight: 500;
        }
        .ap-card-cat { font-size: 11px; color: #888; margin-top: 1px; }
        .ap-card-btn {
          margin-top: 10px; width: 100%;
          padding: 7px 0; font-size: 13px; font-weight: 500;
          background: #2C2C2C; color: #fff;
          border: none; border-radius: 6px; cursor: pointer;
        }
        .ap-card-btn:hover { background: #444; }
        .ap-card-btn:disabled { background: #999; cursor: not-allowed; }
        .ap-opened-badge {
          display: inline-flex; align-items: center; gap: 4px;
          margin-top: 10px; padding: 6px 10px;
          background: #dcfce7; color: #166534;
          border-radius: 6px; font-size: 12px; font-weight: 600;
          width: 100%; justify-content: center;
        }

        /* ── Edit modal ── */
        .hd-modal-backdrop {
          position: fixed; inset: 0; background: rgba(0,0,0,0.4);
          display: flex; align-items: center; justify-content: center; z-index: 1000;
        }
        .hd-modal {
          background: #fff; border-radius: 8px;
          padding: 28px 32px; width: 420px; max-width: 95vw;
          box-shadow: 0 8px 32px rgba(0,0,0,0.18);
        }
        .hd-modal h3 { margin: 0 0 20px; font-size: 17px; color: #2C2C2C; }
        .hd-modal-row {
          display: flex; justify-content: space-between; padding: 8px 0;
          border-bottom: 1px solid #F5F5F5; font-size: 14px;
        }
        .hd-modal-row:last-of-type { border-bottom: none; }
        .hd-modal-label { color: #666; }
        .hd-modal-value { color: #2C2C2C; font-weight: 500; text-align: right; }
        .hd-modal-actions { display: flex; gap: 10px; margin-top: 20px; justify-content: space-between; align-items: center; }
        .hd-cat-badge {
          display: inline-block; padding: 3px 10px; border-radius: 4px;
          background: #2C2C2C; color: #fff; font-size: 12px; font-weight: 600;
        }
        .hd-btn-upgrade {
          background: #2C2C2C; color: #fff; border: none; border-radius: 6px;
          padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer;
        }
        .hd-btn-upgrade:hover { background: #444; }

        @media (max-width: 640px) {
          .hd-card-header { flex-direction: column; align-items: flex-start; }
          .add-filter-count { margin-left: 0; }
        }

        /* ── Hub tiles ── */
        .hub-tiles-grid {
          display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; padding: 14px;
        }
        @media (max-width: 1100px) { .hub-tiles-grid { grid-template-columns: repeat(4, 1fr); } }
        @media (max-width: 720px)  { .hub-tiles-grid { grid-template-columns: repeat(3, 1fr); } }
        @media (max-width: 420px)  { .hub-tiles-grid { grid-template-columns: repeat(2, 1fr); } }

        .hub-tile {
          border: 1px solid #E0E0E0; border-radius: 6px;
          background: #fff; padding: 10px 12px;
          display: flex; flex-direction: column; gap: 5px;
        }
        .hub-tile-iata {
          font-family: monospace; font-size: 20px; font-weight: 800;
          color: #2C2C2C; letter-spacing: 0.02em; line-height: 1;
        }
        .hub-tile-name { font-size: 11px; color: #666; line-height: 1.3; min-height: 26px; }
        .hub-tile-level-badge {
          display: inline-flex; align-items: center;
          background: #2C2C2C; color: #fff;
          padding: 2px 7px; border-radius: 3px;
          font-size: 11px; font-weight: 700; align-self: flex-start;
        }
        .hub-tile-bar-bg {
          height: 5px; background: #E0E0E0; border-radius: 3px; overflow: hidden;
        }
        .hub-tile-bar-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
        .hub-tile-capacity { font-size: 11px; font-weight: 600; }
        .hub-tile-manage-btn {
          width: 100%; padding: 5px 0; font-size: 12px; font-weight: 500;
          background: #fff; color: #2C2C2C;
          border: 1px solid #2C2C2C; border-radius: 5px; cursor: pointer;
          margin-top: auto;
        }
        .hub-tile-manage-btn:hover { background: #F5F5F5; }

        .hd-empty-sm { padding: 16px 20px; color: #999; font-size: 13px; }

        /* Purchase modals */
        .hd-purchase-row { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
        .hd-purchase-row label { font-size: 13px; color: #666; }
        .hd-purchase-row select {
          padding: 8px 12px; font-size: 14px; border: 1px solid #E0E0E0;
          border-radius: 6px; outline: none; background: #fff;
        }
        .hd-purchase-row select:focus { border-color: #2C2C2C; }
        .hd-cost-preview {
          padding: 12px 16px; background: #F5F5F5; border-radius: 6px;
          font-size: 14px; margin-bottom: 16px;
        }
        .hd-cost-big { font-size: 20px; font-weight: 700; color: #2C2C2C; }
      `}</style>

      <div
        className="page-hero"
        style={{ backgroundImage: "linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.6)), url('/header-images/Headerimage_Flightplan.png')" }}
      >
        <div className="page-hero-overlay">
          <h1>Network</h1>
          <p>{airline?.name}</p>
        </div>
      </div>

      <div className="hd-page">
        <div className="hd-container">
          <TopBar onBack={onBack} balance={airline?.balance} backLabel={backLabel} airline={airline} />

          {view === 'list' ? (
            <>
              {/* ── Hubs (Expansions) ───────────────────────────────── */}
              <div className="hd-card" style={{ marginBottom: 20 }}>
                <div className="hd-card-header">
                  <div>
                    <p className="hd-card-title">Hubs ({expansions.length})</p>
                    <p className="hd-card-sub">100 departures/week per level · progressive pricing</p>
                  </div>
                  <button
                    style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.3)', color: 'rgba(255,255,255,0.7)', padding: '0.22rem 0.65rem', borderRadius: '4px', fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer', letterSpacing: '0.03em' }}
                    onClick={() => { setShowExpModal(true); setExpError(''); setExpAirport(''); }}
                  >
                    + New Hub
                  </button>
                </div>
                {expansionsLoading ? (
                  <div className="hd-empty-sm">Loading…</div>
                ) : expansions.length === 0 ? (
                  <div className="hd-empty-sm">No hubs purchased yet. Use "+ New Hub" to add expansion levels at a destination.</div>
                ) : (
                  <div className="hub-tiles-grid">
                    {expansions.map(e => {
                      const pct = e.capacity > 0 ? Math.min(100, Math.round((e.week_usage / e.capacity) * 100)) : 0;
                      const barColor = pct >= 90 ? '#dc2626' : pct >= 70 ? '#d97706' : '#16a34a';
                      const textColor = pct >= 90 ? '#991b1b' : pct >= 70 ? '#92400e' : '#166534';
                      return (
                        <div key={e.id} className="hub-tile">
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <span className="hub-tile-iata">{e.airport_code}</span>
                            <span className="hub-tile-level-badge">Level {e.expansion_level}</span>
                          </div>
                          <div className="hub-tile-name">{e.airport_name || '—'}</div>
                          <div className="hub-tile-bar-bg">
                            <div className="hub-tile-bar-fill" style={{ width: `${pct}%`, background: barColor }} />
                          </div>
                          <div className="hub-tile-capacity" style={{ color: textColor }}>
                            Capacity: {e.week_usage.toLocaleString()}/{e.capacity.toLocaleString()} ({pct}%){pct >= 90 ? ' ⚠' : ''}
                          </div>
                          <button
                            className="hub-tile-manage-btn"
                            onClick={() => { setManageHub(e); setManageAction(null); setManageError(''); }}
                          >
                            Manage
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <DestinationsList
                destinations={sorted}
                loading={destLoading}
                error={destError}
                search={search}
                onSearchChange={setSearch}
                sortArrow={sortArrow}
                onSort={handleSort}
                totalCount={destinations.length}
                hubCount={hubCount}
                baseCount={baseCount}
                onAddDestination={() => onNavigate?.('airport-overview')}
                onEditDestination={setEditDest}
                onDeleteDestination={handleDeleteDestination}
                deleting={deleting}
                onNavigateToAirport={onNavigateToAirport}
              />
            </>
          ) : (
            <AddDestinationsView
              groups={groupedAirports}
              loading={airportsLoading}
              totalShown={filteredAirports.length}
              search={addSearch}
              onSearchChange={setAddSearch}
              filterContinent={filterContinent}
              onContinentChange={handleContinentChange}
              filterCountry={filterCountry}
              onCountryChange={setFilterCountry}
              countries={countriesInContinent}
              opening={opening}
              onOpen={handleOpenDestination}
              onBack={() => setView('list')}
            />
          )}
        </div>
      </div>

      {editDest && (
        <EditDestinationModal destination={editDest} onClose={() => setEditDest(null)} onUpgrade={null} />
      )}

      {/* ── New Hub Modal ───────────────────────────────────────── */}
      {showExpModal && (
        <div className="hd-modal-backdrop" onClick={() => setShowExpModal(false)}>
          <div className="hd-modal" onClick={e => e.stopPropagation()}>
            <h3>New Hub</h3>
            <p style={{ fontSize: 13, color: '#666', marginTop: -12, marginBottom: 16 }}>
              Purchase Level 1 at a destination to enable departures · +100 dep/week
            </p>
            <div className="hd-purchase-row">
              <label>Select Airport</label>
              <select value={expAirport} onChange={e => setExpAirport(e.target.value)}>
                <option value="">— choose destination —</option>
                {destinations.filter(d => d.destination_type !== 'home_base' && !expansions.find(ex => ex.airport_code === d.airport_code)).map(d => (
                  <option key={d.airport_code} value={d.airport_code}>
                    {d.airport_code} — {d.airport_name} (Cat {d.category})
                  </option>
                ))}
              </select>
            </div>
            {expAirport && expCost != null && (
              <div className="hd-cost-preview">
                <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>
                  Level 1 · Cat {expCategory} × ${expMultiplier}M · +100 dep/week
                </div>
                <div className="hd-cost-big">${expCost.toLocaleString()}</div>
              </div>
            )}
            {expError && <p style={{ color: '#dc2626', fontSize: 13, marginBottom: 12 }}>{expError}</p>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="hd-btn-secondary" onClick={() => setShowExpModal(false)}>Cancel</button>
              <button
                className="hd-btn-primary"
                disabled={!expAirport || expPurchasing || expCost == null}
                onClick={() => handlePurchaseExpansion()}
              >
                {expPurchasing ? 'Purchasing…' : expCost != null ? `Buy Level 1 for $${expCost.toLocaleString()}` : 'Select airport'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Manage Hub Modal ────────────────────────────────────── */}
      {manageHub && (
        <ManageHubModal
          hub={manageHub}
          action={manageAction}
          loading={manageLoading}
          error={manageError}
          onSetAction={setManageAction}
          onBuyNextLevel={handleBuyNextLevel}
          onSellHub={handleSellHub}
          onClose={() => { setManageHub(null); setManageAction(null); setManageError(''); }}
        />
      )}
    </>
  );
}

// ── Destinations List ──────────────────────────────────────────────────────────

function DestinationsList({
  destinations, loading, error, search, onSearchChange,
  sortArrow, onSort, totalCount, hubCount, baseCount,
  onAddDestination, onEditDestination, onDeleteDestination, deleting,
  onNavigateToAirport
}) {
  return (
    <div className="hd-card">
      <div className="hd-card-header">
        <div>
          <p className="hd-card-title">Your Destinations</p>
          <p className="hd-card-sub">All airports your airline currently operates</p>
        </div>
        <button className="hdr-btn" onClick={onAddDestination}>+ Add Destination</button>
      </div>

      <div className="hd-search-row">
        <input
          type="text"
          placeholder="Search destinations..."
          value={search}
          onChange={e => onSearchChange(e.target.value)}
        />
        <span className="hd-stats">
          {totalCount} destination{totalCount !== 1 ? 's' : ''}
          {hubCount > 0 && ` · ${hubCount} hub${hubCount !== 1 ? 's' : ''}`}
          {baseCount > 0 && ` · ${baseCount} base${baseCount !== 1 ? 's' : ''}`}
        </span>
      </div>

      <div className="hd-table-wrap">
        {loading ? (
          <div className="hd-empty">Loading destinations...</div>
        ) : error ? (
          <div className="hd-empty" style={{ color: '#dc2626' }}>{error}</div>
        ) : destinations.length === 0 ? (
          <div className="hd-empty">
            No destinations found.{' '}
            <span style={{ color: '#2C2C2C', textDecoration: 'underline', cursor: 'pointer' }} onClick={onAddDestination}>
              Add your first destination via Airport Overview.
            </span>
          </div>
        ) : (
          <table className="hd-table">
            <thead>
              <tr>
                <th onClick={() => onSort('destination_type')}>Status {sortArrow('destination_type')}</th>
                <th onClick={() => onSort('airport')}>Airport {sortArrow('airport')}</th>
                <th onClick={() => onSort('continent')}>Continent {sortArrow('continent')}</th>
                <th onClick={() => onSort('country')}>Country {sortArrow('country')}</th>
                <th onClick={() => onSort('weekly_flights')} style={{ textAlign: 'right' }}>
                  Weekly Flights {sortArrow('weekly_flights')}
                </th>
                <th style={{ textAlign: 'right' }}>Personnel</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {destinations.map(d => {
                const meta = TYPE_META[d.display_type || d.effective_type || d.destination_type] || TYPE_META.destination;
                return (
                  <tr key={d.id}>
                    <td>
                      <span className="hd-type-badge" style={meta.dark ? undefined : { background: '#999' }}>{meta.label}</span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <button
                          className="hd-iata-link"
                          onClick={() => onNavigateToAirport?.(d.airport_code)}
                        >
                          {d.airport_code}
                        </button>
                        <span style={{ fontSize: 13, color: '#666' }}>{d.airport_name}</span>
                      </div>
                    </td>
                    <td>{d.continent || '—'}</td>
                    <td>{d.country}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {d.weekly_flights}
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {d.ground_staff ?? '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="hd-btn-sm" onClick={() => onEditDestination(d)}>Edit</button>
                        {d.destination_type !== 'home_base' && (
                          <button
                            className="hd-btn-sm-danger"
                            disabled={deleting === d.airport_code}
                            onClick={() => onDeleteDestination(d)}
                          >
                            {deleting === d.airport_code ? '...' : 'Delete'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Add Destinations View ──────────────────────────────────────────────────────

function AddDestinationsView({
  groups, loading, totalShown,
  search, onSearchChange,
  filterContinent, onContinentChange,
  filterCountry, onCountryChange, countries,
  opening, onOpen, onBack
}) {
  return (
    <div className="hd-card">
      <div className="hd-card-header">
        <div>
          <p className="hd-card-title">Add Destination</p>
          <p className="hd-card-sub">Open new airports for your airline to operate from</p>
        </div>
        <button className="hdr-btn" onClick={onBack}>← Back to Destinations</button>
      </div>

      <div className="add-filter-bar">
        <input
          type="text"
          placeholder="Search airports..."
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          autoFocus
        />
        <select value={filterContinent} onChange={e => onContinentChange(e.target.value)}>
          <option value="">All Continents</option>
          {CONTINENTS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          value={filterCountry}
          onChange={e => onCountryChange(e.target.value)}
          disabled={countries.length === 0}
        >
          <option value="">All Countries</option>
          {countries.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="add-filter-count">
          Showing {totalShown} airport{totalShown !== 1 ? 's' : ''}
        </span>
      </div>

      {loading ? (
        <div className="hd-empty">Loading airports...</div>
      ) : groups.length === 0 ? (
        <div className="hd-empty">No airports match your filters.</div>
      ) : (
        <div className="add-scroll">
          {groups.map(({ letter, airports }) => (
            <div key={letter}>
              <div className="add-letter-divider">
                <span className="add-letter-label">{letter}</span>
                <div className="add-letter-line" />
              </div>
              <div className="add-grid">
                {airports.map(ap => (
                  <AirportCard
                    key={ap.iata_code}
                    airport={ap}
                    opening={opening === ap.iata_code}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Airport Card ───────────────────────────────────────────────────────────────

function AirportCard({ airport, opening, onOpen }) {
  const catLabel = CATEGORY_LABELS[airport.category] || `Category ${airport.category}`;
  const catNum = airport.category ? `Cat. ${airport.category}` : '';

  return (
    <div className={`ap-card${airport.is_opened ? ' is-opened' : ''}`}>
      <span className="ap-card-iata">{airport.iata_code}</span>
      <div className="ap-card-name">{airport.name}</div>
      <div className="ap-card-cat">{catNum && `${catNum} · `}{catLabel}</div>
      {airport.is_opened ? (
        <div className="ap-opened-badge">✓ Opened</div>
      ) : (
        <>
          <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>{fmtCost(OPEN_COST)} to open</div>
          <button className="ap-card-btn" disabled={opening} onClick={() => onOpen(airport.iata_code)}>
            {opening ? 'Opening...' : 'Open Destination'}
          </button>
        </>
      )}
    </div>
  );
}

// ── Manage Hub Modal ───────────────────────────────────────────────────────────

function ManageHubModal({ hub, action, loading, error, onSetAction, onBuyNextLevel, onSellHub, onClose }) {
  const pct = hub.capacity > 0 ? Math.min(100, Math.round((hub.week_usage / hub.capacity) * 100)) : 0;
  const barColor = pct >= 90 ? '#dc2626' : pct >= 70 ? '#d97706' : '#16a34a';
  const textColor = pct >= 90 ? '#991b1b' : pct >= 70 ? '#92400e' : '#166534';

  return (
    <div className="hd-modal-backdrop" onClick={onClose}>
      <div className="hd-modal" style={{ width: 480 }} onClick={e => e.stopPropagation()}>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontFamily: 'monospace', fontSize: 36, fontWeight: 800, color: '#2C2C2C', lineHeight: 1 }}>{hub.airport_code}</div>
          <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>{hub.airport_name || hub.airport_code}</div>
        </div>

        {/* Info rows */}
        <div className="hd-modal-row">
          <span className="hd-modal-label">Current Level</span>
          <span className="hd-modal-value">
            <span className="hub-tile-level-badge" style={{ fontSize: 11 }}>Level {hub.expansion_level}</span>
          </span>
        </div>
        <div className="hd-modal-row">
          <span className="hd-modal-label">Weekly Capacity</span>
          <span className="hd-modal-value">{hub.capacity.toLocaleString()} departures/week</span>
        </div>
        <div className="hd-modal-row" style={{ flexDirection: 'column', gap: 6, alignItems: 'stretch' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
            <span className="hd-modal-label">Capacity used</span>
            <span className="hd-modal-value" style={{ color: textColor }}>
              {hub.week_usage.toLocaleString()}/{hub.capacity.toLocaleString()} ({pct}%){pct >= 90 ? ' ⚠' : ''}
            </span>
          </div>
          <div style={{ height: 6, background: '#E0E0E0', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: 3, transition: 'width 0.3s' }} />
          </div>
        </div>
        <div className="hd-modal-row">
          <span className="hd-modal-label">Total invested</span>
          <span className="hd-modal-value">${(hub.total_cost_paid || 0).toLocaleString()}</span>
        </div>

        {error && <p style={{ color: '#dc2626', fontSize: 13, margin: '12px 0 0' }}>{error}</p>}

        {/* Action confirmation area */}
        {action === 'buy' && (
          <div style={{ marginTop: 16, background: '#F5F5F5', borderRadius: 6, padding: '14px 16px' }}>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 6 }}>
              Level {hub.next_level} · Cat {hub.category} · +100 dep/week
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#2C2C2C', marginBottom: 14 }}>
              ${(hub.next_level_cost || 0).toLocaleString()}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="hd-btn-secondary" style={{ flex: 1 }} onClick={() => onSetAction(null)} disabled={loading}>Cancel</button>
              <button className="hd-btn-primary" style={{ flex: 1 }} onClick={onBuyNextLevel} disabled={loading}>
                {loading ? 'Purchasing…' : `Confirm: Buy Level ${hub.next_level}`}
              </button>
            </div>
          </div>
        )}

        {action === 'sell' && (
          <div style={{ marginTop: 16, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '14px 16px' }}>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 6 }}>
              Refund at 50% of total invested:
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#dc2626', marginBottom: 6 }}>
              +${(hub.refund_value || 0).toLocaleString()}
            </div>
            <p style={{ fontSize: 12, color: '#999', marginBottom: 12 }}>
              All expansion levels at {hub.airport_code} will be removed. Scheduled flights from this hub must be cancelled first.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="hd-btn-secondary" style={{ flex: 1 }} onClick={() => onSetAction(null)} disabled={loading}>Cancel</button>
              <button
                style={{ flex: 1, padding: '8px 16px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, cursor: 'pointer', fontWeight: 500 }}
                onClick={onSellHub}
                disabled={loading}
              >
                {loading ? 'Selling…' : 'Confirm: Sell Hub'}
              </button>
            </div>
          </div>
        )}

        {/* Main action buttons (shown when no action selected) */}
        {!action && (
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button className="hd-btn-secondary" onClick={onClose} style={{ flex: 1 }}>Close</button>
            <button
              className="hd-btn-secondary"
              style={{ flex: 1, color: '#dc2626', borderColor: '#fca5a5' }}
              onClick={() => { onSetAction('sell'); }}
            >
              Sell Hub
            </button>
            <button className="hd-btn-primary" style={{ flex: 2 }} onClick={() => onSetAction('buy')}>
              + Buy Level {hub.next_level}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Edit Destination Modal ─────────────────────────────────────────────────────

function EditDestinationModal({ destination: d, onClose }) {
  const meta = TYPE_META[d.display_type || d.effective_type || d.destination_type] || TYPE_META.destination;
  const openedDate = d.opened_at
    ? new Date(d.opened_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';
  const catLabel = CATEGORY_LABELS[d.category] || `Category ${d.category}`;

  return (
    <div className="hd-modal-backdrop" onClick={onClose}>
      <div className="hd-modal" onClick={e => e.stopPropagation()}>
        <h3>{d.airport_code} — {d.airport_name}</h3>
        <div className="hd-modal-row">
          <span className="hd-modal-label">Type</span>
          <span className="hd-modal-value">
            <span className="hd-type-badge" style={meta.dark ? undefined : { background: '#999' }}>{meta.label}</span>
          </span>
        </div>
        <div className="hd-modal-row">
          <span className="hd-modal-label">Country</span>
          <span className="hd-modal-value">{d.country}</span>
        </div>
        <div className="hd-modal-row">
          <span className="hd-modal-label">Continent</span>
          <span className="hd-modal-value">{d.continent || '—'}</span>
        </div>
        <div className="hd-modal-row">
          <span className="hd-modal-label">Category</span>
          <span className="hd-modal-value">
            <span className="hd-cat-badge">{d.category} – {catLabel}</span>
          </span>
        </div>
        <div className="hd-modal-row">
          <span className="hd-modal-label">Weekly Flights</span>
          <span className="hd-modal-value">{d.weekly_flights}</span>
        </div>
        <div className="hd-modal-row">
          <span className="hd-modal-label">Opened</span>
          <span className="hd-modal-value">{openedDate}</span>
        </div>
        {d.destination_type === 'home_base' && (
          <p style={{ fontSize: 13, color: '#888', marginTop: 12, marginBottom: 0 }}>
            Home Base has unlimited departures by default.
          </p>
        )}
        <div className="hd-modal-actions">
          <div />
          <button className="hd-btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
