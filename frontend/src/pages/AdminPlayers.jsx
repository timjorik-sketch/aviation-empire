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

  // "Update User" modal — overview of the player's airlines with per-airline
  // adjust-money / adjust-points actions.
  const [updatePlayer, setUpdatePlayer] = useState(null);
  const [updateAirlines, setUpdateAirlines] = useState([]);
  const [updateLoading, setUpdateLoading] = useState(false);
  const [updateError, setUpdateError] = useState('');
  // Inline form state per airline: { [airlineId]: { mode: 'money'|'points', amount, note, busy, error } }
  const [adjustForms, setAdjustForms] = useState({});

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

  const closeUpdateModal = () => {
    setUpdatePlayer(null);
    setUpdateAirlines([]);
    setAdjustForms({});
    setUpdateError('');
  };

  const openUpdateModal = async (player) => {
    setUpdatePlayer(player);
    setUpdateAirlines([]);
    setAdjustForms({});
    setUpdateError('');
    setUpdateLoading(true);
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/admin/players/${player.id}/airlines`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load airlines');
      setUpdateAirlines(data.airlines || []);
    } catch (e) {
      setUpdateError(e.message);
    } finally {
      setUpdateLoading(false);
    }
  };

  const setForm = (airlineId, patch) => {
    setAdjustForms(prev => ({
      ...prev,
      [airlineId]: { mode: null, amount: '', note: '', busy: false, error: '', ...prev[airlineId], ...patch },
    }));
  };

  const startAdjust = (airlineId, mode) => {
    setForm(airlineId, { mode, amount: '', note: '', error: '' });
  };

  const cancelAdjust = (airlineId) => {
    setForm(airlineId, { mode: null, amount: '', note: '', error: '' });
  };

  const submitAdjust = async (airlineId) => {
    const form = adjustForms[airlineId];
    if (!form || !form.mode) return;
    const amt = Number(form.amount);
    if (!Number.isFinite(amt) || amt === 0) {
      setForm(airlineId, { error: 'Enter a non-zero amount' });
      return;
    }
    setForm(airlineId, { busy: true, error: '' });
    const token = localStorage.getItem('token');
    const path = form.mode === 'points' ? 'adjust-points' : 'adjust-balance';
    try {
      const res = await fetch(`${API_URL}/api/admin/players/${updatePlayer.id}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          airline_id: airlineId,
          amount: form.mode === 'points' ? Math.trunc(amt) : amt,
          note: form.note.trim() || null,
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setUpdateAirlines(list => list.map(a => a.id === data.id
        ? {
            ...a,
            balance: data.balance ?? a.balance,
            total_points: data.total_points ?? a.total_points,
            level: data.level ?? a.level,
          }
        : a));
      setForm(airlineId, { mode: null, amount: '', note: '', busy: false, error: '' });
    } catch (e) {
      setForm(airlineId, { busy: false, error: e.message });
    }
  };

  return (
    <div className="app">
      <div
        className="page-hero"
        style={{ backgroundImage: "url('/header-images/Headerimage_Home.png')" }}
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
                  <th style={{ padding: '10px 8px' }}>Status</th>
                  <th style={{ padding: '10px 8px' }}>Role</th>
                  <th style={{ padding: '10px 8px', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {players.length === 0 && !loading ? (
                  <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#666' }}>No players found.</td></tr>
                ) : players.map(p => (
                  <tr key={p.id} style={{ borderBottom: '1px solid #F0F0F0' }}>
                    <td style={{ padding: '12px 8px', fontWeight: 600 }}>{p.username}</td>
                    <td style={{ padding: '12px 8px', color: '#666' }}>{p.email}</td>
                    <td style={{ padding: '12px 8px', textAlign: 'center' }}>{p.airline_count}</td>
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
                        onClick={() => openUpdateModal(p)}
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
                        Update User
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

      {updatePlayer && (
        <div
          onClick={closeUpdateModal}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 8, padding: 24, width: 'min(640px, 96vw)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.2)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: '0 0 4px', color: '#2C2C2C' }}>Update User</h3>
                <p style={{ margin: 0, color: '#666', fontSize: 13 }}>
                  Player: <strong>{updatePlayer.username}</strong> · {updatePlayer.email}
                </p>
              </div>
              <button
                type="button"
                onClick={closeUpdateModal}
                style={{ background: 'transparent', border: 'none', fontSize: 22, color: '#666', cursor: 'pointer', lineHeight: 1, padding: 4 }}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {updateError && (
              <div style={{ background: '#fee', color: '#c33', padding: 10, borderRadius: 6, marginBottom: 12, border: '1px solid #fcc', fontSize: 13 }}>
                {updateError}
              </div>
            )}

            {updateLoading ? (
              <div style={{ padding: 24, textAlign: 'center', color: '#666' }}>Loading airlines…</div>
            ) : updateAirlines.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: '#666' }}>This player has no airlines.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {updateAirlines.map(a => {
                  const f = adjustForms[a.id] || { mode: null, amount: '', note: '', busy: false, error: '' };
                  return (
                    <div key={a.id} style={{ border: '1px solid #E0E0E0', borderRadius: 8, padding: 16, background: '#FAFAFA' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                        <div style={{ fontWeight: 700, color: '#2C2C2C', fontSize: 15 }}>
                          {a.name} <span style={{ color: '#666', fontWeight: 500 }}>({a.airline_code})</span>
                        </div>
                        <div style={{ display: 'flex', gap: 16, color: '#666', fontSize: 13 }}>
                          <span>Level <strong style={{ color: '#2C2C2C' }}>{a.level}</strong></span>
                          <span>Balance <strong style={{ color: '#2C2C2C' }}>{formatMoney(a.balance)}</strong></span>
                          <span>Points <strong style={{ color: '#2C2C2C' }}>{Number(a.total_points || 0).toLocaleString()}</strong></span>
                        </div>
                      </div>

                      {f.mode === null ? (
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            type="button"
                            onClick={() => startAdjust(a.id, 'money')}
                            style={{ background: '#2C2C2C', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                          >
                            Adjust Money
                          </button>
                          <button
                            type="button"
                            onClick={() => startAdjust(a.id, 'points')}
                            style={{ background: '#fff', color: '#2C2C2C', border: '1px solid #2C2C2C', padding: '8px 14px', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                          >
                            Adjust Points
                          </button>
                        </div>
                      ) : (
                        <form
                          onSubmit={e => { e.preventDefault(); submitAdjust(a.id); }}
                          style={{ display: 'flex', flexDirection: 'column', gap: 8, background: '#fff', padding: 12, borderRadius: 6, border: '1px solid #E0E0E0' }}
                        >
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#2C2C2C' }}>
                            {f.mode === 'money' ? 'Adjust Money' : 'Adjust Points'} — positive adds, negative subtracts
                          </div>
                          {f.error && (
                            <div style={{ background: '#fee', color: '#c33', padding: 8, borderRadius: 4, border: '1px solid #fcc', fontSize: 12 }}>
                              {f.error}
                            </div>
                          )}
                          <input
                            type="number"
                            step={f.mode === 'points' ? '1' : '1'}
                            value={f.amount}
                            onChange={e => setForm(a.id, { amount: e.target.value })}
                            placeholder={f.mode === 'money' ? 'e.g. 1000000 or -500000' : 'e.g. 5000 or -1000'}
                            autoFocus
                            style={{ padding: 8, border: '1px solid #E0E0E0', borderRadius: 4, fontSize: 14 }}
                          />
                          <input
                            type="text"
                            value={f.note}
                            onChange={e => setForm(a.id, { note: e.target.value })}
                            placeholder="Note (optional)"
                            style={{ padding: 8, border: '1px solid #E0E0E0', borderRadius: 4, fontSize: 14 }}
                          />
                          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                            <button
                              type="button"
                              onClick={() => cancelAdjust(a.id)}
                              disabled={f.busy}
                              style={{ background: '#F5F5F5', color: '#2C2C2C', border: '1px solid #E0E0E0', padding: '8px 14px', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              disabled={f.busy}
                              style={{ background: '#2C2C2C', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: f.busy ? 'default' : 'pointer', opacity: f.busy ? 0.6 : 1 }}
                            >
                              {f.busy ? 'Saving…' : 'Confirm'}
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                type="button"
                onClick={closeUpdateModal}
                style={{ background: '#F5F5F5', color: '#2C2C2C', border: '1px solid #E0E0E0', padding: '10px 16px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
