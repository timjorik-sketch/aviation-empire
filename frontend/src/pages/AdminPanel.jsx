import { useEffect, useState, useCallback } from 'react';
import TopBar from '../components/TopBar.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

function formatDateTime(dt) {
  if (!dt) return '—';
  const d = new Date(dt);
  return d.toLocaleString('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin'
  });
}

function statusBadge(row) {
  if (row.used_by_username) {
    return { label: 'USED', color: '#666', bg: '#E0E0E0' };
  }
  if (row.revoked) {
    return { label: 'REVOKED', color: '#c33', bg: '#fee' };
  }
  return { label: 'AVAILABLE', color: '#16a34a', bg: '#dcfce7' };
}

export default function AdminPanel({ airline, onBack }) {
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState(null);

  const fetchCodes = useCallback(async () => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/admin/invite-codes`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load codes');
      setCodes(data.codes || []);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCodes(); }, [fetchCodes]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreating(true);
    setError('');
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/admin/invite-codes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ note: note.trim() || null })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create code');
      setNote('');
      await fetchCodes();
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id) => {
    if (!confirm('Revoke this invite code? It will no longer be usable.')) return;
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/admin/invite-codes/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to revoke');
      await fetchCodes();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleCopy = async (code, id) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {}
  };

  return (
    <div className="app">
      <div
        className="page-hero"
        style={{ backgroundImage: "linear-gradient(rgba(0,0,0,0.4),rgba(0,0,0,0.6)),url('/header-images/Headerimage_Home.png')" }}
      >
        <div className="page-hero-overlay">
          <h1>Admin Panel</h1>
          <p>Invite code management</p>
        </div>
      </div>

      <div className="container" style={{ paddingTop: 24 }}>
        <TopBar onBack={onBack} balance={airline?.balance} />

        {error && (
          <div style={{ background: '#fee', color: '#c33', padding: '12px', borderRadius: 6, marginBottom: 16, border: '1px solid #fcc' }}>
            {error}
          </div>
        )}

        {/* Generate new code */}
        <div style={{ background: 'white', borderRadius: 8, padding: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', marginBottom: 24 }}>
          <h3 style={{ margin: '0 0 16px', color: '#2C2C2C' }}>Generate New Invite Code</h3>
          <form onSubmit={handleCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px' }}>
              <label style={{ display: 'block', marginBottom: 6, color: '#666', fontSize: 14, fontWeight: 500 }}>
                Note (optional — e.g. recipient name)
              </label>
              <input
                type="text"
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="e.g. For Marco"
                disabled={creating}
                style={{ width: '100%', padding: 10, border: '1px solid #E0E0E0', borderRadius: 6, fontSize: 14 }}
              />
            </div>
            <button type="submit" disabled={creating} className="btn-primary" style={{ width: 'auto', padding: '12px 24px', margin: 0 }}>
              {creating ? 'Generating…' : 'Generate Code'}
            </button>
          </form>
        </div>

        {/* Codes list */}
        <div style={{ background: 'white', borderRadius: 8, padding: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
          <h3 style={{ margin: '0 0 16px', color: '#2C2C2C' }}>
            Invite Codes ({codes.length})
          </h3>
          {loading ? (
            <p style={{ color: '#666' }}>Loading…</p>
          ) : codes.length === 0 ? (
            <p style={{ color: '#666' }}>No codes generated yet.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '2px solid #E0E0E0', color: '#666' }}>
                    <th style={{ padding: '10px 8px' }}>Code</th>
                    <th style={{ padding: '10px 8px' }}>Status</th>
                    <th style={{ padding: '10px 8px' }}>Note</th>
                    <th style={{ padding: '10px 8px' }}>Created</th>
                    <th style={{ padding: '10px 8px' }}>Used By</th>
                    <th style={{ padding: '10px 8px' }}>Used At</th>
                    <th style={{ padding: '10px 8px', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {codes.map(c => {
                    const badge = statusBadge(c);
                    const canRevoke = !c.used_by_username && !c.revoked;
                    return (
                      <tr key={c.id} style={{ borderBottom: '1px solid #F0F0F0' }}>
                        <td style={{ padding: '12px 8px', fontFamily: 'monospace', fontWeight: 700, letterSpacing: '0.05em' }}>
                          {c.code}
                        </td>
                        <td style={{ padding: '12px 8px' }}>
                          <span style={{
                            background: badge.bg, color: badge.color,
                            padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700
                          }}>
                            {badge.label}
                          </span>
                        </td>
                        <td style={{ padding: '12px 8px', color: '#666' }}>{c.note || '—'}</td>
                        <td style={{ padding: '12px 8px', color: '#666' }}>{formatDateTime(c.created_at)}</td>
                        <td style={{ padding: '12px 8px', color: '#666' }}>{c.used_by_username || '—'}</td>
                        <td style={{ padding: '12px 8px', color: '#666' }}>{formatDateTime(c.used_at)}</td>
                        <td style={{ padding: '12px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button
                            onClick={() => handleCopy(c.code, c.id)}
                            style={{
                              background: copiedId === c.id ? '#dcfce7' : '#F5F5F5',
                              color: copiedId === c.id ? '#16a34a' : '#2C2C2C',
                              border: '1px solid #E0E0E0', padding: '6px 12px', borderRadius: 4,
                              fontSize: 12, fontWeight: 600, cursor: 'pointer', marginRight: 6
                            }}
                          >
                            {copiedId === c.id ? 'Copied!' : 'Copy'}
                          </button>
                          {canRevoke && (
                            <button
                              onClick={() => handleRevoke(c.id)}
                              style={{
                                background: '#fee', color: '#c33', border: '1px solid #fcc',
                                padding: '6px 12px', borderRadius: 4, fontSize: 12,
                                fontWeight: 600, cursor: 'pointer'
                              }}
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
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
