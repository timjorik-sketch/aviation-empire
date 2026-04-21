import { useEffect, useState, useCallback } from 'react';
import TopBar from '../components/TopBar.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

function formatMoney(n) {
  if (n == null || isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function Pagination({ page, totalPages, onPage }) {
  if (totalPages <= 1) return null;

  const pages = [];
  const windowSize = 2;
  const add = (p) => pages.push(p);
  add(1);
  const start = Math.max(2, page - windowSize);
  const end = Math.min(totalPages - 1, page + windowSize);
  if (start > 2) add('…l');
  for (let p = start; p <= end; p++) add(p);
  if (end < totalPages - 1) add('…r');
  if (totalPages > 1) add(totalPages);

  const btn = (p, label, disabled, active) => (
    <button
      key={label ?? p}
      onClick={() => !disabled && !active && typeof p === 'number' && onPage(p)}
      disabled={disabled}
      style={{
        minWidth: 36, padding: '6px 10px',
        border: '1px solid #E0E0E0', borderRadius: 4, cursor: disabled || active ? 'default' : 'pointer',
        background: active ? '#2C2C2C' : '#fff',
        color: active ? '#fff' : '#2C2C2C',
        fontWeight: active ? 700 : 500, fontSize: 13,
      }}
    >
      {label ?? p}
    </button>
  );

  return (
    <div style={{ display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center', marginTop: 20, flexWrap: 'wrap' }}>
      {btn(page - 1, '‹', page <= 1, false)}
      {pages.map(p => typeof p === 'number'
        ? btn(p, null, false, p === page)
        : <span key={p} style={{ padding: '6px 4px', color: '#666' }}>…</span>
      )}
      {btn(page + 1, '›', page >= totalPages, false)}
    </div>
  );
}

export default function AdminPlayers({ airline, onBack }) {
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actingId, setActingId] = useState(null);

  const [moneyModalPlayer, setMoneyModalPlayer] = useState(null);
  const [moneyAirlines, setMoneyAirlines] = useState([]);
  const [moneyAirlineId, setMoneyAirlineId] = useState('');
  const [moneyAmount, setMoneyAmount] = useState('');
  const [moneyNote, setMoneyNote] = useState('');
  const [moneyLoading, setMoneyLoading] = useState(false);
  const [moneyError, setMoneyError] = useState('');

  const fetchPlayers = useCallback(async (p = page, s = appliedSearch) => {
    setLoading(true);
    const token = localStorage.getItem('token');
    try {
      const url = `${API_URL}/api/admin/players?page=${p}${s ? `&search=${encodeURIComponent(s)}` : ''}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load players');
      setPlayers(data.players || []);
      setTotalPages(data.totalPages || 1);
      setTotal(data.total || 0);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [page, appliedSearch]);

  useEffect(() => { fetchPlayers(); }, [fetchPlayers]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setPage(1);
    setAppliedSearch(search.trim());
  };

  const handleSearchChange = (v) => {
    setSearch(v);
    if (v.trim() === '') {
      setPage(1);
      setAppliedSearch('');
    }
  };

  const toggleBan = async (player) => {
    if (!confirm(player.is_banned ? `Unban ${player.username}?` : `Ban ${player.username}?`)) return;
    setActingId(`ban-${player.id}`);
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/admin/players/${player.id}/ban`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setPlayers(list => list.map(p => p.id === player.id ? { ...p, is_banned: data.is_banned } : p));
    } catch (e) {
      setError(e.message);
    } finally {
      setActingId(null);
    }
  };

  const toggleAdmin = async (player) => {
    const msg = player.is_admin
      ? `Remove admin role from ${player.username}?`
      : `Promote ${player.username} to admin?`;
    if (!confirm(msg)) return;
    setActingId(`admin-${player.id}`);
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/admin/players/${player.id}/admin`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setPlayers(list => list.map(p => p.id === player.id ? { ...p, is_admin: data.is_admin } : p));
    } catch (e) {
      setError(e.message);
    } finally {
      setActingId(null);
    }
  };

  const openMoneyModal = async (player) => {
    setMoneyModalPlayer(player);
    setMoneyAirlines([]);
    setMoneyAirlineId('');
    setMoneyAmount('');
    setMoneyNote('');
    setMoneyError('');
    setMoneyLoading(true);
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/admin/players/${player.id}/airlines`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load airlines');
      setMoneyAirlines(data.airlines || []);
      if ((data.airlines || []).length > 0) setMoneyAirlineId(String(data.airlines[0].id));
    } catch (e) {
      setMoneyError(e.message);
    } finally {
      setMoneyLoading(false);
    }
  };

  const submitMoney = async (e) => {
    e.preventDefault();
    setMoneyError('');
    const amt = Number(moneyAmount);
    if (!moneyAirlineId) { setMoneyError('Select an airline'); return; }
    if (!Number.isFinite(amt) || amt === 0) { setMoneyError('Enter a non-zero amount'); return; }
    setMoneyLoading(true);
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/admin/players/${moneyModalPlayer.id}/adjust-balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          airline_id: Number(moneyAirlineId),
          amount: amt,
          note: moneyNote.trim() || null,
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setMoneyAirlines(list => list.map(a => a.id === data.id ? { ...a, balance: data.balance } : a));
      setMoneyAmount('');
      setMoneyNote('');
    } catch (e) {
      setMoneyError(e.message);
    } finally {
      setMoneyLoading(false);
    }
  };

  const selectedAirline = moneyAirlines.find(a => String(a.id) === moneyAirlineId);

  return (
    <div className="app">
      <div
        className="page-hero"
        style={{ backgroundImage: "linear-gradient(rgba(0,0,0,0.4),rgba(0,0,0,0.6)),url('/header-images/Headerimage_Home.png')" }}
      >
        <div className="page-hero-overlay">
          <h1>Player Management</h1>
          <p>Search, ban, promote and adjust balances</p>
        </div>
      </div>

      <div className="container" style={{ paddingTop: 24 }}>
        <TopBar onBack={onBack} balance={airline?.balance} />

        {error && (
          <div style={{ background: '#fee', color: '#c33', padding: '12px', borderRadius: 6, marginBottom: 16, border: '1px solid #fcc' }}>
            {error}
          </div>
        )}

        <div style={{ background: 'white', borderRadius: 8, padding: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
          <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="Search by name or email…"
              value={search}
              onChange={e => handleSearchChange(e.target.value)}
              style={{ flex: '1 1 260px', padding: 10, border: '1px solid #E0E0E0', borderRadius: 6, fontSize: 14 }}
            />
            <button type="submit" className="btn-primary" style={{ width: 'auto', padding: '10px 20px', margin: 0 }}>
              Search
            </button>
          </form>

          <div style={{ color: '#666', fontSize: 13, marginBottom: 12 }}>
            {loading ? 'Loading…' : `${total} player${total === 1 ? '' : 's'} found`}
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '2px solid #E0E0E0', color: '#666' }}>
                  <th style={{ padding: '10px 8px' }}>Name</th>
                  <th style={{ padding: '10px 8px' }}>Email</th>
                  <th style={{ padding: '10px 8px', textAlign: 'center' }}>Airlines</th>
                  <th style={{ padding: '10px 8px', textAlign: 'center' }}>Level</th>
                  <th style={{ padding: '10px 8px' }}>Status</th>
                  <th style={{ padding: '10px 8px' }}>Role</th>
                  <th style={{ padding: '10px 8px', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {players.length === 0 && !loading ? (
                  <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: '#666' }}>No players found.</td></tr>
                ) : players.map(p => (
                  <tr key={p.id} style={{ borderBottom: '1px solid #F0F0F0' }}>
                    <td style={{ padding: '12px 8px', fontWeight: 600 }}>{p.username}</td>
                    <td style={{ padding: '12px 8px', color: '#666' }}>{p.email}</td>
                    <td style={{ padding: '12px 8px', textAlign: 'center' }}>{p.airline_count}</td>
                    <td style={{ padding: '12px 8px', textAlign: 'center' }}>{p.airline_count > 0 ? p.max_level : '—'}</td>
                    <td style={{ padding: '12px 8px' }}>
                      <span style={{
                        background: p.is_banned ? '#fee' : '#dcfce7',
                        color: p.is_banned ? '#c33' : '#16a34a',
                        padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700
                      }}>
                        {p.is_banned ? 'BANNED' : 'ACTIVE'}
                      </span>
                    </td>
                    <td style={{ padding: '12px 8px' }}>
                      <span style={{
                        background: p.is_admin ? '#e0e7ff' : '#F5F5F5',
                        color: p.is_admin ? '#4338ca' : '#666',
                        padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700
                      }}>
                        {p.is_admin ? 'ADMIN' : 'PLAYER'}
                      </span>
                    </td>
                    <td style={{ padding: '12px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        onClick={() => toggleBan(p)}
                        disabled={actingId === `ban-${p.id}`}
                        style={{
                          background: p.is_banned ? '#dcfce7' : '#fee',
                          color: p.is_banned ? '#16a34a' : '#c33',
                          border: `1px solid ${p.is_banned ? '#bbf7d0' : '#fcc'}`,
                          padding: '6px 12px', borderRadius: 4, fontSize: 12,
                          fontWeight: 600, cursor: 'pointer', marginRight: 6
                        }}
                      >
                        {p.is_banned ? 'Unban' : 'Ban'}
                      </button>
                      <button
                        onClick={() => openMoneyModal(p)}
                        disabled={p.airline_count === 0}
                        title={p.airline_count === 0 ? 'Player has no airline' : ''}
                        style={{
                          background: '#F5F5F5', color: '#2C2C2C',
                          border: '1px solid #E0E0E0', padding: '6px 12px', borderRadius: 4,
                          fontSize: 12, fontWeight: 600,
                          cursor: p.airline_count === 0 ? 'not-allowed' : 'pointer',
                          opacity: p.airline_count === 0 ? 0.5 : 1,
                          marginRight: 6
                        }}
                      >
                        Adjust Money
                      </button>
                      <button
                        onClick={() => toggleAdmin(p)}
                        disabled={actingId === `admin-${p.id}`}
                        style={{
                          background: p.is_admin ? '#F5F5F5' : '#e0e7ff',
                          color: p.is_admin ? '#2C2C2C' : '#4338ca',
                          border: `1px solid ${p.is_admin ? '#E0E0E0' : '#c7d2fe'}`,
                          padding: '6px 12px', borderRadius: 4, fontSize: 12,
                          fontWeight: 600, cursor: 'pointer'
                        }}
                      >
                        {p.is_admin ? 'Remove Admin' : 'Make Admin'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination page={page} totalPages={totalPages} onPage={setPage} />
        </div>
      </div>

      {moneyModalPlayer && (
        <div
          onClick={() => setMoneyModalPlayer(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
        >
          <form
            onClick={e => e.stopPropagation()}
            onSubmit={submitMoney}
            style={{ background: '#fff', borderRadius: 8, padding: 24, width: 'min(460px, 92vw)', boxShadow: '0 8px 24px rgba(0,0,0,0.2)' }}
          >
            <h3 style={{ margin: '0 0 4px', color: '#2C2C2C' }}>Adjust Balance</h3>
            <p style={{ margin: '0 0 16px', color: '#666', fontSize: 13 }}>
              Player: <strong>{moneyModalPlayer.username}</strong>
            </p>

            {moneyError && (
              <div style={{ background: '#fee', color: '#c33', padding: 10, borderRadius: 6, marginBottom: 12, border: '1px solid #fcc', fontSize: 13 }}>
                {moneyError}
              </div>
            )}

            <label style={{ display: 'block', marginBottom: 6, color: '#666', fontSize: 13, fontWeight: 500 }}>
              Airline
            </label>
            <select
              value={moneyAirlineId}
              onChange={e => setMoneyAirlineId(e.target.value)}
              disabled={moneyLoading || moneyAirlines.length === 0}
              style={{ width: '100%', padding: 10, border: '1px solid #E0E0E0', borderRadius: 6, fontSize: 14, marginBottom: 12 }}
            >
              {moneyAirlines.length === 0 && <option>— None —</option>}
              {moneyAirlines.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.airline_code}) — Lvl {a.level}
                </option>
              ))}
            </select>

            {selectedAirline && (
              <div style={{ background: '#F5F5F5', padding: 12, borderRadius: 6, marginBottom: 12, fontSize: 14 }}>
                Current balance: <strong>{formatMoney(selectedAirline.balance)}</strong>
              </div>
            )}

            <label style={{ display: 'block', marginBottom: 6, color: '#666', fontSize: 13, fontWeight: 500 }}>
              Amount (positive = add, negative = subtract)
            </label>
            <input
              type="number"
              step="1"
              value={moneyAmount}
              onChange={e => setMoneyAmount(e.target.value)}
              placeholder="e.g. 1000000 or -500000"
              style={{ width: '100%', padding: 10, border: '1px solid #E0E0E0', borderRadius: 6, fontSize: 14, marginBottom: 12, boxSizing: 'border-box' }}
            />

            <label style={{ display: 'block', marginBottom: 6, color: '#666', fontSize: 13, fontWeight: 500 }}>
              Note (optional)
            </label>
            <input
              type="text"
              value={moneyNote}
              onChange={e => setMoneyNote(e.target.value)}
              placeholder="Reason for adjustment"
              style={{ width: '100%', padding: 10, border: '1px solid #E0E0E0', borderRadius: 6, fontSize: 14, marginBottom: 20, boxSizing: 'border-box' }}
            />

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setMoneyModalPlayer(null)}
                style={{ background: '#F5F5F5', color: '#2C2C2C', border: '1px solid #E0E0E0', padding: '10px 16px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={moneyLoading || moneyAirlines.length === 0}
                className="btn-primary"
                style={{ width: 'auto', padding: '10px 20px', margin: 0 }}
              >
                {moneyLoading ? 'Saving…' : 'Confirm'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
