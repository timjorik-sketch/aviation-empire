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

function MarketSection() {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const run = async (path, label) => {
    setBusy(label); setMsg(null);
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setMsg({ ok: res.ok, text: data.message || data.error || (res.ok ? 'Done' : 'Error') });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="card">
      <div className="card-header-dark">Market</div>
      <div className="card-body">
        <p style={{ margin: '0 0 16px', color: '#666', fontSize: 14 }}>
          Manage the aircraft marketplace inventory.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button
            onClick={() => run('/api/aircraft/dev/fill-market', 'fill')}
            disabled={!!busy}
            style={{
              background: '#b45309', color: '#fff', border: 'none', borderRadius: 6,
              padding: '10px 20px', fontWeight: 600, fontSize: 14, cursor: busy ? 'wait' : 'pointer',
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy === 'fill' ? 'Filling…' : 'Fill Market'}
          </button>
          <button
            onClick={() => run('/api/aircraft/dev/clear-market', 'clear')}
            disabled={!!busy}
            style={{
              background: '#6b7280', color: '#fff', border: 'none', borderRadius: 6,
              padding: '10px 20px', fontWeight: 600, fontSize: 14, cursor: busy ? 'wait' : 'pointer',
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy === 'clear' ? 'Clearing…' : 'Clear Market'}
          </button>
        </div>
        {msg && (
          <div style={{
            marginTop: 12,
            background: msg.ok ? '#dcfce7' : '#fee',
            color: msg.ok ? '#166534' : '#c33',
            border: `1px solid ${msg.ok ? '#bbf7d0' : '#fcc'}`,
            borderRadius: 6, padding: '8px 12px', fontSize: 13,
          }}>
            {msg.text}
          </div>
        )}
      </div>
    </div>
  );
}

function RoutePriceCalculator() {
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

  useEffect(() => {
    const token = localStorage.getItem('token');
    const h = { Authorization: `Bearer ${token}` };
    fetch(`${API_URL}/api/service-profiles`, { headers: h })
      .then(r => r.json()).then(d => setServiceProfiles(d.profiles || [])).catch(() => {});
    fetch(`${API_URL}/api/cabin-profiles`, { headers: h })
      .then(r => r.json()).then(d => setCabinProfiles(d.profiles || [])).catch(() => {});
  }, []);

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

  const inp = { background: '#fff', border: '1px solid #E0E0E0', borderRadius: 4, padding: '6px 10px', fontSize: 13, color: '#2C2C2C', width: '100%' };
  const lbl = { fontSize: 11, color: '#666', fontWeight: 600, display: 'block', marginBottom: 4 };

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '12px 14px', marginBottom: 16 }}>
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
            <div style={{ marginTop: 4, fontSize: 11, color: '#666', display: 'flex', gap: 10 }}>
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
      <button onClick={calculate} disabled={loading || !dep || !arr} className="btn-primary" style={{ width: 'auto', padding: '10px 24px', margin: 0, opacity: (!dep || !arr) ? 0.5 : 1 }}>
        {loading ? 'Calculating…' : 'Calculate'}
      </button>
      {err && <div style={{ marginTop: 8, color: '#c33', fontSize: 13 }}>{err}</div>}

      {result && (
        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ gridColumn: '1 / -1', background: '#1e293b', color: '#fff', borderRadius: 6, padding: '10px 14px', fontSize: 12, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <span><b>{result.route.dep}</b> {result.route.dep_name} → <b>{result.route.arr}</b> {result.route.arr_name}</span>
            <span>📏 {result.route.dist_km.toLocaleString()} km</span>
            <span>🏢 Cat {result.route.dep_cat} → Cat {result.route.arr_cat}</span>
          </div>

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

          <div style={{ gridColumn: '1 / -1', background: '#fff', border: '1px solid #E0E0E0', borderRadius: 6, padding: '10px 14px' }}>
            <div style={{ fontWeight: 700, fontSize: 12, color: '#2C2C2C', marginBottom: 8 }}>72h Booking Window Forecast</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr) 1fr', gap: 8, marginBottom: 10 }}>
              {[['Economy', result.expected_72h.eco, result.capacity.eco, parseFloat(ecoPx)],
                ['Business', result.expected_72h.biz, result.capacity.biz, parseFloat(bizPx)],
                ['First', result.expected_72h.fir, result.capacity.fir, parseFloat(firPx)],
                ['TOTAL', result.expected_72h.total, result.capacity.total, null]].map(([cls, exp, cap, px]) => (
                <div key={cls} style={{ textAlign: 'center', background: '#F5F5F5', borderRadius: 5, padding: '8px 4px' }}>
                  <div style={{ fontSize: 10, color: '#666', fontWeight: 600 }}>{cls}</div>
                  <div style={{ fontSize: 18, fontWeight: 900, color: '#2C2C2C' }}>{exp}</div>
                  <div style={{ fontSize: 10, color: '#888' }}>/ {cap} seats</div>
                  {px > 0 && <div style={{ fontSize: 10, color: '#16a34a', fontWeight: 600 }}>${(exp * px).toLocaleString()}</div>}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, color: '#555', whiteSpace: 'nowrap' }}>Load Factor</span>
              <div style={{ flex: 1, height: 12, background: '#E0E0E0', borderRadius: 6, overflow: 'hidden' }}>
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
  );
}

export default function AdminPanel({ airline, onBack, onNavigate }) {
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState(null);
  const [interestStats, setInterestStats] = useState(null);

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

  useEffect(() => {
    const token = localStorage.getItem('token');
    fetch(`${API_URL}/api/admin/interest-stats`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(r => r.json())
      .then(d => setInterestStats(d))
      .catch(() => {});
  }, []);

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

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <button
            onClick={() => onNavigate && onNavigate('admin-players')}
            style={{
              background: '#2C2C2C', color: '#fff', border: 'none',
              padding: '10px 20px', borderRadius: 6, fontSize: 14,
              fontWeight: 600, cursor: 'pointer'
            }}
          >
            Player Management
          </button>
        </div>

        {interestStats && (
          <div style={{
            background: '#fff', borderRadius: 8, padding: 20, marginBottom: 16,
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 16,
          }}>
            <div>
              <div style={{ fontSize: 12, color: '#666', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Interest (total)</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: '#2C2C2C', marginTop: 4 }}>
                {interestStats.total?.toLocaleString('en-US') ?? 0}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#666', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Last 7 days</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: '#2C2C2C', marginTop: 4 }}>
                {interestStats.last_7d?.toLocaleString('en-US') ?? 0}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#666', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Last 24 hours</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: '#2C2C2C', marginTop: 4 }}>
                {interestStats.last_24h?.toLocaleString('en-US') ?? 0}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div style={{ background: '#fee', color: '#c33', padding: '12px', borderRadius: 6, marginBottom: 16, border: '1px solid #fcc' }}>
            {error}
          </div>
        )}

        <MarketSection />

        <div className="card">
          <div className="card-header-dark">Prices</div>
          <div className="card-body">
            <p style={{ margin: '0 0 16px', color: '#666', fontSize: 14 }}>
              Route Price Calculator — preview demand, attractiveness and 72h booking forecast for any route.
            </p>
            <RoutePriceCalculator />
          </div>
        </div>

        {/* Invite code generation */}
        <div className="card">
          <div className="card-header-dark">Generate New Invite Code</div>
          <div className="card-body">
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
        </div>

        {/* Invite codes list */}
        <div className="card">
          <div className="card-header-dark">Invite Codes ({codes.length})</div>
          <div className="card-body">
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
    </div>
  );
}
