import { useState, useEffect, useMemo, useCallback } from 'react';
import TopBar from '../components/TopBar.jsx';
import Loader from '../components/Loader.jsx';
import {
  minutesToHHMM, parseHM, inWindow, windowLabel, legLocalTimes,
} from '../utils/bankWindows.js';

const API_URL = import.meta.env.VITE_API_URL || '';
const DAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

// A flight in the after-midnight part of a night window belongs to the bank
// that opened the previous evening.
function bankDay(day, min, start, end) {
  return (start > end && min <= end) ? (day + 6) % 7 : day;
}

function daysLabel(days) {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length === 7) return 'Daily';
  const runs = [];
  let s = d[0], e = d[0];
  const push = () => runs.push(s === e ? DAY_LABELS[s] : e - s === 1 ? `${DAY_LABELS[s]} ${DAY_LABELS[e]}` : `${DAY_LABELS[s]}–${DAY_LABELS[e]}`);
  for (let i = 1; i < d.length; i++) {
    if (d[i] === e + 1) e = d[i]; else { push(); s = e = d[i]; }
  }
  push();
  return runs.join(', ');
}

// Every leg arriving at / departing from the bank's hub inside its windows.
function matchBank(bank, entries) {
  const arrivals = [], departures = [];
  for (const e of entries) {
    if (!e.departure_time || !e.arrival_time) continue;
    const t = legLocalTimes(e);
    if (e.arrival_airport === bank.hub_airport_code && inWindow(t.arr.min, bank.earliest_arrival, bank.latest_arrival)) {
      arrivals.push({ ...e, localMin: t.arr.min, bankDay: bankDay(t.arr.day, t.arr.min, bank.earliest_arrival, bank.latest_arrival), other: e.departure_airport, otherName: e.departure_name });
    }
    if (e.departure_airport === bank.hub_airport_code && inWindow(t.dep.min, bank.earliest_departure, bank.latest_departure)) {
      departures.push({ ...e, localMin: t.dep.min, bankDay: bankDay(t.dep.day, t.dep.min, bank.earliest_departure, bank.latest_departure), other: e.arrival_airport, otherName: e.arrival_name });
    }
  }
  return { arrivals, departures };
}

// Collapse legs of one destination into "flight · time · days" lines.
function collapseLegs(legs) {
  const map = new Map();
  for (const l of legs) {
    const key = `${l.flight_number}|${l.localMin}`;
    if (!map.has(key)) map.set(key, { flight_number: l.flight_number, localMin: l.localMin, days: [], regs: new Set() });
    const g = map.get(key);
    g.days.push(l.bankDay);
    g.regs.add(l.registration);
  }
  return [...map.values()].sort((a, b) => a.localMin - b.localMin || a.flight_number.localeCompare(b.flight_number));
}

// 24h strip: arrival window hatched, departure window solid, optional flight ticks.
function DayStrip({ bank, arrTicks = [], depTicks = [], tall = false }) {
  const segs = (s, e) => s <= e ? [[s, e]] : [[s, 1440], [0, e]];
  const pct = (m) => `${(m / 1440) * 100}%`;
  return (
    <div className={`bk-strip${tall ? ' bk-strip--tall' : ''}`}>
      {[0, 360, 720, 1080].map(m => <span key={m} className="bk-strip-grid" style={{ left: pct(m) }} />)}
      {segs(bank.earliest_arrival, bank.latest_arrival).map(([s, e], i) => (
        <span key={`a${i}`} className="bk-strip-win bk-strip-win--arr" style={{ left: pct(s), width: pct(Math.max(e - s, 4)) }} />
      ))}
      {segs(bank.earliest_departure, bank.latest_departure).map(([s, e], i) => (
        <span key={`d${i}`} className="bk-strip-win bk-strip-win--dep" style={{ left: pct(s), width: pct(Math.max(e - s, 4)) }} />
      ))}
      {arrTicks.map((m, i) => <span key={`at${i}`} className="bk-strip-tick bk-strip-tick--arr" style={{ left: pct(m) }} />)}
      {depTicks.map((m, i) => <span key={`dt${i}`} className="bk-strip-tick bk-strip-tick--dep" style={{ left: pct(m) }} />)}
    </div>
  );
}

function StripAxis() {
  return (
    <div className="bk-axis">
      {['00', '06', '12', '18', '24'].map(h => <span key={h}>{h}</span>)}
    </div>
  );
}

export default function Banks({ airline, onBack, backLabel, onNavigateToAirport }) {
  const token = localStorage.getItem('token');
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const jsonHeaders = useMemo(() => ({ ...headers, 'Content-Type': 'application/json' }), [headers]);

  const [banks, setBanks] = useState([]);
  const [entries, setEntries] = useState([]);
  const [airports, setAirports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedBankId, setSelectedBankId] = useState(null);
  const [dayFilter, setDayFilter] = useState('all');

  // Create / edit modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [fName, setFName] = useState('');
  const [fHub, setFHub] = useState('');
  const [fEarlyArr, setFEarlyArr] = useState('04:00');
  const [fLateArr, setFLateArr] = useState('06:00');
  const [fEarlyDep, setFEarlyDep] = useState('07:00');
  const [fLateDep, setFLateDep] = useState('09:00');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const fetchBanks = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/banks`, { headers });
      const data = await res.json();
      if (res.ok) setBanks(data.banks || []);
    } catch {}
  }, [headers]);

  useEffect(() => {
    Promise.all([
      fetchBanks(),
      fetch(`${API_URL}/api/flights/weekly-schedule`, { headers }).then(r => r.json()).then(d => setEntries(d.entries || [])).catch(() => {}),
      fetch(`${API_URL}/api/destinations/opened`, { headers }).then(r => r.json()).then(d => setAirports(d.airports || [])).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, [fetchBanks, headers]);

  const airportName = useCallback((code) => {
    const ap = airports.find(a => a.iata_code === code);
    if (ap) return ap.name;
    const e = entries.find(x => x.departure_airport === code || x.arrival_airport === code);
    return e ? (e.departure_airport === code ? e.departure_name : e.arrival_name) : '';
  }, [airports, entries]);

  const matches = useMemo(() => {
    const m = {};
    for (const b of banks) m[b.id] = matchBank(b, entries);
    return m;
  }, [banks, entries]);

  const hubs = useMemo(() => {
    const byHub = new Map();
    for (const b of banks) {
      if (!byHub.has(b.hub_airport_code)) byHub.set(b.hub_airport_code, []);
      byHub.get(b.hub_airport_code).push(b);
    }
    return [...byHub.entries()]
      .map(([code, list]) => ({
        code,
        banks: list.sort((a, b) => a.earliest_arrival - b.earliest_arrival),
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [banks]);

  const selectedBank = banks.find(b => b.id === selectedBankId) || null;

  const openModal = (bank = null, hub = '') => {
    setError('');
    if (bank) {
      setEditingId(bank.id);
      setFName(bank.name);
      setFHub(bank.hub_airport_code);
      setFEarlyArr(minutesToHHMM(bank.earliest_arrival));
      setFLateArr(minutesToHHMM(bank.latest_arrival));
      setFEarlyDep(minutesToHHMM(bank.earliest_departure));
      setFLateDep(minutesToHHMM(bank.latest_departure));
    } else {
      setEditingId(null);
      setFName('');
      setFHub(hub || airline?.home_airport_code || '');
      setFEarlyArr('04:00'); setFLateArr('06:00');
      setFEarlyDep('07:00'); setFLateDep('09:00');
    }
    setModalOpen(true);
  };

  const saveBank = async () => {
    if (!fName.trim()) { setError('Bank name is required'); return; }
    if (!fHub) { setError('Select a hub airport'); return; }
    setSaving(true); setError('');
    try {
      const body = {
        name: fName.trim(), hub_airport_code: fHub,
        earliest_arrival: parseHM(fEarlyArr), latest_arrival: parseHM(fLateArr),
        earliest_departure: parseHM(fEarlyDep), latest_departure: parseHM(fLateDep),
      };
      const url = editingId ? `${API_URL}/api/banks/${editingId}` : `${API_URL}/api/banks`;
      const res = await fetch(url, { method: editingId ? 'PUT' : 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Could not save bank');
      else { setModalOpen(false); fetchBanks(); }
    } catch { setError('Network error'); }
    finally { setSaving(false); }
  };

  const deleteBank = async (bank) => {
    if (!window.confirm(`Delete bank "${bank.name}"?`)) return;
    try {
      const res = await fetch(`${API_URL}/api/banks/${bank.id}`, { method: 'DELETE', headers });
      if (res.ok) {
        if (selectedBankId === bank.id) setSelectedBankId(null);
        fetchBanks();
      }
    } catch {}
  };

  // ── Detail: one row per destination, inbound and outbound side by side ──
  const detail = useMemo(() => {
    if (!selectedBank) return null;
    const { arrivals, departures } = matches[selectedBank.id] || { arrivals: [], departures: [] };
    const keep = (l) => dayFilter === 'all' || l.bankDay === dayFilter;
    const arr = arrivals.filter(keep);
    const dep = departures.filter(keep);
    const rows = new Map();
    const row = (code, name) => {
      if (!rows.has(code)) rows.set(code, { code, name, arr: [], dep: [] });
      return rows.get(code);
    };
    for (const l of arr) row(l.other, l.otherName).arr.push(l);
    for (const l of dep) row(l.other, l.otherName).dep.push(l);
    const list = [...rows.values()]
      .map(r => ({ ...r, arrG: collapseLegs(r.arr), depG: collapseLegs(r.dep) }))
      .sort((a, b) => {
        const both = (x) => (x.arr.length && x.dep.length) ? 0 : 1;
        return both(a) - both(b) || a.code.localeCompare(b.code);
      });
    return {
      rows: list,
      arrCount: arr.length,
      depCount: dep.length,
      inbound: list.filter(r => r.arr.length).length,
      outbound: list.filter(r => r.dep.length).length,
      bothWays: list.filter(r => r.arr.length && r.dep.length).length,
      arrTicks: [...new Set(arr.map(l => l.localMin))],
      depTicks: [...new Set(dep.map(l => l.localMin))],
    };
  }, [selectedBank, matches, dayFilter]);

  const hubOptions = useMemo(() => {
    const list = [...airports];
    if (fHub && !list.some(a => a.iata_code === fHub)) list.unshift({ iata_code: fHub, name: airportName(fHub) });
    return list;
  }, [airports, fHub, airportName]);

  return (
    <div className="app">
      <style>{`
        .bk-page { background: #F5F5F5; min-height: 100vh; }
        .bk-container { max-width: 1100px; margin: 0 auto; padding: 24px 24px 48px; }
        .bk-card { background: #fff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden; margin-bottom: 20px; }
        .bk-card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 20px; background: #2C2C2C; }
        .bk-card-title { font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: white; margin: 0; }
        .bk-card-sub { font-size: 12px; color: rgba(255,255,255,0.6); margin: 2px 0 0; }
        .bk-hdr-btn { background: transparent; border: 1px solid rgba(255,255,255,0.3); color: rgba(255,255,255,0.8); padding: 0.22rem 0.65rem; border-radius: 4px; font-size: 0.7rem; font-weight: 600; cursor: pointer; letter-spacing: 0.03em; white-space: nowrap; }
        .bk-hdr-btn:hover { color: white; border-color: rgba(255,255,255,0.6); }
        .bk-intro { padding: 14px 20px; font-size: 13px; color: #666; line-height: 1.55; }
        .bk-legend { display: inline-flex; align-items: center; gap: 6px; margin-right: 14px; font-size: 12px; color: #666; }
        .bk-legend-sw { width: 18px; height: 10px; border-radius: 2px; display: inline-block; }
        .bk-empty { padding: 28px 20px; color: #999; font-size: 13px; }

        .bk-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
        @media (max-width: 900px) { .bk-grid { grid-template-columns: 1fr; } }
        .bk-tile .bk-card-header { cursor: default; }
        .bk-iata { font-family: monospace; font-size: 1.05rem; font-weight: 800; color: white; letter-spacing: 0.04em; background: none; border: none; padding: 0; cursor: pointer; text-decoration: underline dashed rgba(255,255,255,0.4); text-underline-offset: 3px; }
        .bk-tile-name { font-size: 12px; color: rgba(255,255,255,0.6); margin-left: 8px; }

        .bk-bank-row { display: block; width: 100%; text-align: left; background: white; border: none; border-bottom: 1px solid #F0F0F0; padding: 12px 20px; cursor: pointer; font: inherit; color: inherit; }
        .bk-bank-row:last-child { border-bottom: none; }
        .bk-bank-row:hover { background: #F9F9F9; }
        .bk-bank-top { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
        .bk-bank-name { font-weight: 700; font-size: 0.9rem; color: #2C2C2C; }
        .bk-bank-stats { margin-left: auto; font-size: 11px; color: #999; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .bk-bank-times { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: #666; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
        .bk-bank-times b { font-weight: 600; color: #999; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; margin-right: 4px; }

        .bk-strip { position: relative; height: 12px; background: #F2F2F2; border-radius: 3px; overflow: hidden; }
        .bk-strip--tall { height: 34px; }
        .bk-strip-grid { position: absolute; top: 0; bottom: 0; width: 1px; background: #E2E2E2; }
        .bk-strip-win { position: absolute; top: 0; bottom: 0; }
        .bk-strip-win--arr { background: repeating-linear-gradient(135deg, rgba(44,44,44,0.35) 0 2px, transparent 2px 6px); border-left: 1px solid rgba(44,44,44,0.4); border-right: 1px solid rgba(44,44,44,0.4); }
        .bk-strip-win--dep { background: rgba(44,44,44,0.22); border-left: 1px solid rgba(44,44,44,0.5); border-right: 1px solid rgba(44,44,44,0.5); }
        .bk-strip-tick { position: absolute; width: 2px; margin-left: -1px; background: #2C2C2C; }
        .bk-strip-tick--arr { top: 0; height: 45%; }
        .bk-strip-tick--dep { bottom: 0; height: 45%; }
        .bk-axis { display: flex; justify-content: space-between; font-size: 10px; color: #AAA; margin-top: 3px; font-variant-numeric: tabular-nums; }

        .bk-mini-btns { display: flex; gap: 4px; }
        .bk-mini-btns button { background: none; border: 1px solid #E0E0E0; border-radius: 4px; height: 22px; padding: 0 7px; cursor: pointer; color: #666; font-size: 11px; }
        .bk-mini-btns button:hover { background: #F5F5F5; border-color: #CCC; color: #2C2C2C; }
        .bk-card-header .bk-mini-btns button { border-color: rgba(255,255,255,0.3); color: rgba(255,255,255,0.8); }
        .bk-card-header .bk-mini-btns button:hover { background: rgba(255,255,255,0.1); color: white; }

        /* Detail */
        .bk-back { background: none; border: none; color: #666; font-size: 13px; cursor: pointer; padding: 0; margin-bottom: 12px; }
        .bk-back:hover { color: #2C2C2C; }
        .bk-detail-top { padding: 16px 20px 18px; }
        .bk-kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
        @media (max-width: 720px) { .bk-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        .bk-kpi { background: #F5F5F5; border-radius: 6px; padding: 10px 12px; }
        .bk-kpi-val { font-size: 1.3rem; font-weight: 700; color: #2C2C2C; font-variant-numeric: tabular-nums; }
        .bk-kpi-lbl { font-size: 10px; font-weight: 700; color: #999; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 2px; }
        .bk-days { display: inline-flex; gap: 2px; background: #EFEFEF; border: 1px solid #DDD; border-radius: 6px; padding: 2px; flex-wrap: wrap; }
        .bk-day-btn { padding: 5px 10px; background: transparent; border: none; border-radius: 4px; font-size: 0.72rem; font-weight: 600; color: #777; cursor: pointer; text-transform: uppercase; letter-spacing: 0.04em; }
        .bk-day-btn--active { background: white; color: #2C2C2C; box-shadow: 0 1px 2px rgba(0,0,0,0.12); }
        .bk-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 20px; background: #FAFAFA; border-bottom: 1px solid #E8E8E8; }

        .bk-table { width: 100%; border-collapse: collapse; }
        .bk-table th { text-align: left; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #999; padding: 9px 20px; background: #F7F7F7; border-bottom: 1px solid #E8E8E8; }
        .bk-table td { padding: 9px 20px; border-bottom: 1px solid #F0F0F0; vertical-align: top; font-size: 13px; }
        .bk-table tr:last-child td { border-bottom: none; }
        .bk-dest { font-family: monospace; font-weight: 800; font-size: 0.88rem; color: #2C2C2C; background: none; border: none; padding: 0; cursor: pointer; text-decoration: underline dashed rgba(0,0,0,0.4); text-underline-offset: 3px; }
        .bk-dest-name { display: block; font-size: 11px; color: #999; margin-top: 2px; }
        .bk-both { display: inline-block; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #2C2C2C; background: #EDEDED; border-radius: 3px; padding: 1px 5px; margin-left: 6px; vertical-align: middle; }
        .bk-legs { display: flex; flex-direction: column; gap: 3px; }
        .bk-leg { display: flex; gap: 8px; align-items: baseline; font-variant-numeric: tabular-nums; flex-wrap: wrap; }
        .bk-leg-time { font-family: monospace; font-weight: 700; color: #2C2C2C; }
        .bk-leg-fn { font-family: monospace; font-size: 12px; color: #555; }
        .bk-leg-days { font-size: 11px; color: #AAA; }
        .bk-none { color: #CCC; }
        @media (max-width: 600px) {
          .bk-container { padding: 16px 16px 40px; }
          .bk-table th, .bk-table td { padding: 8px 10px; }
          .bk-bank-top { flex-wrap: wrap; }
          .bk-bank-stats { margin-left: 0; width: 100%; }
        }

        /* Modal (same language as the planner's bank modal) */
        .bk-modal-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; padding: 1rem; }
        .bk-modal { background: white; border-radius: 8px; width: 100%; max-width: 460px; box-shadow: 0 8px 32px rgba(0,0,0,0.2); overflow: hidden; }
        .bk-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 1rem 1.25rem; background: #2C2C2C; }
        .bk-modal-header h2 { margin: 0; font-size: 1rem; color: white; }
        .bk-modal-close { background: none; border: none; font-size: 1.4rem; cursor: pointer; color: rgba(255,255,255,0.6); line-height: 1; padding: 0; }
        .bk-modal-body { padding: 1.25rem; }
        .bk-modal-footer { display: flex; justify-content: flex-end; gap: 0.6rem; padding: 0.9rem 1.25rem; border-top: 1px solid #E0E0E0; background: #FAFAFA; }
        .bk-label { display: block; font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #666; margin-bottom: 6px; }
        .bk-inp { width: 100%; padding: 0.5rem 0.6rem; border: 1px solid #E0E0E0; border-radius: 6px; font-size: 0.88rem; color: #2C2C2C; background: white; box-sizing: border-box; }
        .bk-inp:focus { outline: none; border-color: #2C2C2C; }
        .bk-field { margin-bottom: 0.9rem; }
        .bk-window { background: #F5F5F5; border: 1px solid #E0E0E0; border-radius: 6px; padding: 10px 12px; margin-bottom: 0.75rem; }
        .bk-window-hd { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #888; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
        .bk-nextday { font-size: 0.62rem; font-weight: 700; color: #a16207; background: rgba(234,179,8,0.15); border: 1px solid rgba(234,179,8,0.35); padding: 1px 6px; border-radius: 3px; text-transform: none; letter-spacing: 0.02em; }
        .bk-times { display: flex; align-items: center; gap: 10px; }
        .bk-times .bk-inp { flex: 1; }
        .bk-btn-cancel { background: none; border: 1px solid #E0E0E0; color: #555; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.88rem; }
        .bk-btn-submit { background: #2C2C2C; color: white; border: none; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.88rem; font-weight: 600; }
        .bk-btn-submit:disabled { opacity: 0.5; cursor: not-allowed; }
        .bk-error { background: #fee2e2; border: 1px solid #fca5a5; color: #991b1b; border-radius: 6px; padding: 8px 12px; font-size: 13px; margin-bottom: 12px; }
      `}</style>

      <div className="page-hero" style={{ backgroundImage: "url('/header-images/Headerimage_Flightplan.png')" }}>
        <div className="page-hero-overlay">
          <h1>Banks</h1>
          <p>{airline?.name}</p>
        </div>
      </div>

      <div className="bk-page">
        <div className="bk-container">
          <TopBar onBack={onBack} balance={airline?.balance} backLabel={backLabel} airline={airline} />

          {loading ? (
            <Loader />
          ) : selectedBank && detail ? (
            <>
              <button className="bk-back" onClick={() => { setSelectedBankId(null); setDayFilter('all'); }}>← All banks</button>
              <div className="bk-card">
                <div className="bk-card-header">
                  <div>
                    <p className="bk-card-title">{selectedBank.name} · {selectedBank.hub_airport_code}</p>
                    <p className="bk-card-sub">
                      Arrivals {windowLabel(selectedBank.earliest_arrival, selectedBank.latest_arrival)} · Departures {windowLabel(selectedBank.earliest_departure, selectedBank.latest_departure)} · {selectedBank.hub_airport_code} local
                    </p>
                  </div>
                  <div className="bk-mini-btns">
                    <button onClick={() => openModal(selectedBank)}>Edit</button>
                    <button onClick={() => deleteBank(selectedBank)}>Delete</button>
                  </div>
                </div>
                <div className="bk-detail-top">
                  <div className="bk-kpis">
                    <div className="bk-kpi"><div className="bk-kpi-val">{detail.arrCount}</div><div className="bk-kpi-lbl">Arrivals{dayFilter === 'all' ? ' / week' : ''}</div></div>
                    <div className="bk-kpi"><div className="bk-kpi-val">{detail.depCount}</div><div className="bk-kpi-lbl">Departures{dayFilter === 'all' ? ' / week' : ''}</div></div>
                    <div className="bk-kpi"><div className="bk-kpi-val">{detail.inbound}</div><div className="bk-kpi-lbl">Feeder origins</div></div>
                    <div className="bk-kpi"><div className="bk-kpi-val">{detail.outbound}</div><div className="bk-kpi-lbl">Onward destinations</div></div>
                    <div className="bk-kpi"><div className="bk-kpi-val">{detail.bothWays}</div><div className="bk-kpi-lbl">Served both ways</div></div>
                  </div>
                  <DayStrip bank={selectedBank} arrTicks={detail.arrTicks} depTicks={detail.depTicks} tall />
                  <StripAxis />
                  <div style={{ marginTop: 10 }}>
                    <span className="bk-legend"><span className="bk-legend-sw bk-strip-win--arr" style={{ position: 'static' }} />Arrival window (ticks above = arrivals)</span>
                    <span className="bk-legend"><span className="bk-legend-sw bk-strip-win--dep" style={{ position: 'static' }} />Departure window (ticks below = departures)</span>
                  </div>
                </div>
              </div>

              <div className="bk-card">
                <div className="bk-toolbar">
                  <div className="bk-days" role="group" aria-label="Filter by day">
                    <button className={`bk-day-btn${dayFilter === 'all' ? ' bk-day-btn--active' : ''}`} onClick={() => setDayFilter('all')}>Week</button>
                    {DAY_LABELS.map((d, i) => (
                      <button key={d} className={`bk-day-btn${dayFilter === i ? ' bk-day-btn--active' : ''}`} onClick={() => setDayFilter(i)}>{d}</button>
                    ))}
                  </div>
                  <span style={{ fontSize: 12, color: '#999' }}>{detail.rows.length} airport{detail.rows.length !== 1 ? 's' : ''} in this bank</span>
                </div>
                {detail.rows.length === 0 ? (
                  <div className="bk-empty">No scheduled flights arrive or depart {selectedBank.hub_airport_code} inside this bank's windows{dayFilter === 'all' ? '' : ' on this day'}.</div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table className="bk-table">
                      <thead>
                        <tr>
                          <th style={{ width: '26%' }}>Airport</th>
                          <th>Arrival from (local)</th>
                          <th>Departure to (local)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.rows.map(r => (
                          <tr key={r.code}>
                            <td>
                              <button className="bk-dest" onClick={() => onNavigateToAirport?.(r.code)}>{r.code}</button>
                              {r.arr.length > 0 && r.dep.length > 0 && <span className="bk-both">both</span>}
                              <span className="bk-dest-name">{r.name}</span>
                            </td>
                            {[r.arrG, r.depG].map((groups, gi) => (
                              <td key={gi}>
                                {groups.length === 0 ? <span className="bk-none">—</span> : (
                                  <div className="bk-legs">
                                    {groups.map(g => (
                                      <div key={`${g.flight_number}-${g.localMin}`} className="bk-leg" title={[...g.regs].join(', ')}>
                                        <span className="bk-leg-time">{minutesToHHMM(g.localMin)}</span>
                                        <span className="bk-leg-fn">{g.flight_number}</span>
                                        <span className="bk-leg-days">{dayFilter === 'all' ? daysLabel(g.days) : ''}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="bk-card">
                <div className="bk-card-header">
                  <div>
                    <p className="bk-card-title">Hub Banks ({banks.length})</p>
                    <p className="bk-card-sub">Arrival and departure waves per hub · times in hub local time</p>
                  </div>
                  <button className="bk-hdr-btn" onClick={() => openModal()}>+ New Bank</button>
                </div>
                <div className="bk-intro">
                  A bank bundles an arrival window and a departure window at a hub so feeder flights connect onto onward flights.
                  Click a bank to see which destinations it serves.
                  <div style={{ marginTop: 8 }}>
                    <span className="bk-legend"><span className="bk-legend-sw bk-strip-win--arr" style={{ position: 'static' }} />Arrival window</span>
                    <span className="bk-legend"><span className="bk-legend-sw bk-strip-win--dep" style={{ position: 'static' }} />Departure window</span>
                  </div>
                </div>
              </div>

              {hubs.length === 0 ? (
                <div className="bk-card"><div className="bk-empty">No banks yet. Use "+ New Bank" to define your first hub wave.</div></div>
              ) : (
                <div className="bk-grid">
                  {hubs.map(h => (
                    <div key={h.code} className="bk-card bk-tile" style={{ marginBottom: 0 }}>
                      <div className="bk-card-header">
                        <div style={{ minWidth: 0 }}>
                          <button className="bk-iata" onClick={() => onNavigateToAirport?.(h.code)}>{h.code}</button>
                          <span className="bk-tile-name">{airportName(h.code)}</span>
                          <p className="bk-card-sub">{h.banks.length} bank{h.banks.length !== 1 ? 's' : ''}</p>
                        </div>
                        <button className="bk-hdr-btn" onClick={() => openModal(null, h.code)}>+ Bank</button>
                      </div>
                      {h.banks.map(b => {
                        const m = matches[b.id];
                        const dests = new Set([...m.arrivals, ...m.departures].map(l => l.other)).size;
                        return (
                          <div key={b.id} className="bk-bank-row" role="button" tabIndex={0}
                            onClick={() => setSelectedBankId(b.id)}
                            onKeyDown={e => { if (e.key === 'Enter') setSelectedBankId(b.id); }}>
                            <div className="bk-bank-top">
                              <span className="bk-bank-name">{b.name}</span>
                              <span className="bk-bank-stats">{m.arrivals.length} arr · {m.departures.length} dep / wk · {dests} airports</span>
                              <span className="bk-mini-btns" onClick={e => e.stopPropagation()}>
                                <button onClick={() => openModal(b)} title="Edit bank">Edit</button>
                                <button onClick={() => deleteBank(b)} title="Delete bank">×</button>
                              </span>
                            </div>
                            <div className="bk-bank-times">
                              <span><b>Arr</b>{windowLabel(b.earliest_arrival, b.latest_arrival)}</span>
                              <span><b>Dep</b>{windowLabel(b.earliest_departure, b.latest_departure)}</span>
                            </div>
                            <DayStrip bank={b} />
                          </div>
                        );
                      })}
                      <div style={{ padding: '0 20px 10px' }}><StripAxis /></div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {modalOpen && (
        <div className="bk-modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="bk-modal" onClick={e => e.stopPropagation()}>
            <div className="bk-modal-header">
              <h2>{editingId ? 'Edit Bank' : 'New Bank'}</h2>
              <button className="bk-modal-close" onClick={() => setModalOpen(false)}>×</button>
            </div>
            <div className="bk-modal-body">
              {error && <div className="bk-error">{error}</div>}
              <div className="bk-field">
                <label className="bk-label">Bank Name</label>
                <input type="text" className="bk-inp" value={fName} placeholder="e.g. Morning bank" onChange={e => setFName(e.target.value)} />
              </div>
              <div className="bk-field">
                <label className="bk-label">Hub Airport</label>
                <select className="bk-inp" value={fHub} onChange={e => setFHub(e.target.value)}>
                  <option value="">— select hub —</option>
                  {hubOptions.map(ap => (
                    <option key={ap.iata_code} value={ap.iata_code}>{ap.iata_code} – {ap.name}</option>
                  ))}
                </select>
              </div>
              <div className="bk-window">
                <div className="bk-window-hd">
                  Arrival Window
                  {parseHM(fLateArr) < parseHM(fEarlyArr) && <span className="bk-nextday">latest is next day</span>}
                </div>
                <div className="bk-times">
                  <input type="time" className="bk-inp" value={fEarlyArr} onChange={e => setFEarlyArr(e.target.value)} />
                  <span style={{ color: '#999' }}>–</span>
                  <input type="time" className="bk-inp" value={fLateArr} onChange={e => setFLateArr(e.target.value)} />
                </div>
              </div>
              <div className="bk-window">
                <div className="bk-window-hd">
                  Departure Window
                  {parseHM(fLateDep) < parseHM(fEarlyDep) && <span className="bk-nextday">latest is next day</span>}
                </div>
                <div className="bk-times">
                  <input type="time" className="bk-inp" value={fEarlyDep} onChange={e => setFEarlyDep(e.target.value)} />
                  <span style={{ color: '#999' }}>–</span>
                  <input type="time" className="bk-inp" value={fLateDep} onChange={e => setFLateDep(e.target.value)} />
                </div>
              </div>
              <div style={{ fontSize: '0.76rem', color: '#888', lineHeight: 1.5 }}>
                Times are in the hub's local time at {fHub || 'the hub'}.
              </div>
            </div>
            <div className="bk-modal-footer">
              <button className="bk-btn-cancel" onClick={() => setModalOpen(false)}>Cancel</button>
              <button className="bk-btn-submit" disabled={saving} onClick={saveBank}>
                {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Create Bank'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
