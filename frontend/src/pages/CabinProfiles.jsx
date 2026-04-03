import { useState, useEffect } from 'react';
import TopBar from '../components/TopBar.jsx';
import Toast from '../components/Toast.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

const SEAT_TYPES = [
  { key: 'economy',         label: 'Economy',        ratio: 1.0, image: 'Seating_Economy.png' },
  { key: 'premium_economy', label: 'Premium Eco',    ratio: 1.4, image: 'Seating_Premium_Economy.png' },
  { key: 'business',        label: 'Business',       ratio: 2.8, image: 'Seating_Business.png' },
  { key: 'first',           label: 'First',          ratio: 4.5, image: 'Seating_First.png' },
  { key: 'first_suite',     label: 'First Suite',    ratio: 6.5, image: 'Seating_First_Suite.png' },
];

const CLASS_LABELS = { economy: 'Economy Cabin', business: 'Business Cabin', first: 'First Cabin' };
const CLASS_COLORS = { economy: '#3b82f6', business: '#f59e0b', first: '#8b5cf6' };

const DEFAULT_CLASSES = [
  { class_type: 'economy',  seat_type: 'economy',  seat_ratio: 1.0, percentage: 80 },
  { class_type: 'business', seat_type: 'business', seat_ratio: 2.2, percentage: 15 },
  { class_type: 'first',    seat_type: 'first',    seat_ratio: 4.0, percentage: 5 },
];

function calcCapacity(maxPax, pct, ratio) {
  return Math.floor((pct / 100) * maxPax / ratio);
}

function CabinProfiles({ airline, onBack, backLabel = 'Dashboard' }) {
  const [mode, setMode] = useState('list');
  const [profiles, setProfiles] = useState([]);
  const [aircraftTypes, setAircraftTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [editingId, setEditingId] = useState(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formTypeId, setFormTypeId] = useState('');
  const [formClasses, setFormClasses] = useState(DEFAULT_CLASSES.map(c => ({ ...c })));

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    const token = localStorage.getItem('token');
    try {
      const [profilesRes, typesRes] = await Promise.all([
        fetch(`${API_URL}/api/cabin-profiles`, { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`${API_URL}/api/aircraft/fleet/grouped`, { headers: { 'Authorization': `Bearer ${token}` } }),
      ]);
      const profilesData = await profilesRes.json();
      const fleetData = await typesRes.json();
      setProfiles(profilesData.profiles || []);
      const ownedTypes = (fleetData.fleet || [])
        .map(g => ({ id: g.type_id, full_name: g.full_name, max_passengers: g.max_passengers, manufacturer: g.manufacturer, model: g.model }))
        .sort((a, b) => a.full_name.localeCompare(b.full_name));
      setAircraftTypes(ownedTypes);
    } catch (err) {
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const selectedType = aircraftTypes.find(t => t.id === parseInt(formTypeId)) || null;
  const maxPax = selectedType ? selectedType.max_passengers : 0;
  const getClassCap = (cls) => maxPax > 0 ? calcCapacity(maxPax, cls.percentage, cls.seat_ratio) : 0;
  const totalPct = formClasses.reduce((s, c) => s + c.percentage, 0);
  const totalCap = formClasses.reduce((s, c) => s + getClassCap(c), 0);
  const premiumPct = formClasses.filter(c => c.class_type === 'business' || c.class_type === 'first').reduce((s, c) => s + c.percentage, 0);

  const updateClass = (idx, field, value) => {
    setFormClasses(prev => prev.map((c, i) => {
      if (i !== idx) return c;
      const updated = { ...c, [field]: value };
      if (field === 'seat_type') {
        const st = SEAT_TYPES.find(s => s.key === value);
        if (st) updated.seat_ratio = st.ratio;
      }
      // Block increases that would push the total space allocation over 100%
      if (field === 'percentage' && value > c.percentage) {
        const otherPct = prev.reduce((s, cls, j) => j !== idx ? s + cls.percentage : s, 0);
        updated.percentage = Math.min(value, Math.max(0, 100 - otherPct));
      }
      return updated;
    }));
  };

  const openCreate = () => {
    setFormName('');
    setFormTypeId(aircraftTypes.length > 0 ? String(aircraftTypes[0].id) : '');
    setFormClasses(DEFAULT_CLASSES.map(c => ({ ...c })));
    setEditingId(null);
    setError('');
    setSuccess('');
    setMode('create');
  };

  const openEdit = (profile) => {
    setFormName(profile.name);
    setFormTypeId(String(profile.aircraft_type_id));
    const classes = ['economy', 'business', 'first'].map(ct => {
      const ex = profile.classes.find(c => c.class_type === ct);
      if (ex) return { class_type: ct, seat_type: ex.seat_type, seat_ratio: ex.seat_ratio, percentage: ex.percentage };
      const def = DEFAULT_CLASSES.find(d => d.class_type === ct);
      return def ? { ...def } : { class_type: ct, seat_type: ct, seat_ratio: 1.0, percentage: 0 };
    });
    setFormClasses(classes);
    setEditingId(profile.id);
    setError('');
    setSuccess('');
    setMode('edit');
  };

  const handleSave = async () => {
    if (!formName.trim()) { setError('Profile name is required'); return; }
    if (!formTypeId) { setError('Aircraft type is required'); return; }
    if (premiumPct > 40) { setError('Business + First Class cannot exceed 40% of total cabin space.'); return; }
    const token = localStorage.getItem('token');
    const body = {
      name: formName.trim(),
      aircraft_type_id: parseInt(formTypeId),
      classes: formClasses.map(c => ({
        class_type: c.class_type, seat_type: c.seat_type,
        seat_ratio: c.seat_ratio, percentage: c.percentage
      }))
    };
    try {
      const url = mode === 'edit'
        ? `${API_URL}/api/cabin-profiles/${editingId}`
        : `${API_URL}/api/cabin-profiles`;
      const res = await fetch(url, {
        method: mode === 'edit' ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setSuccess(mode === 'edit' ? 'Profile updated.' : 'Profile created.');
      await fetchData();
      setMode('list');
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (profileId) => {
    if (!confirm('Delete this cabin profile?')) return;
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/cabin-profiles/${profileId}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Delete failed'); }
      setProfiles(prev => prev.filter(p => p.id !== profileId));
    } catch (err) {
      setError(err.message);
    }
  };

  // Group by aircraft type for list
  const profilesByType = {};
  for (const p of profiles) {
    const key = p.aircraft_type_id;
    if (!profilesByType[key]) {
      profilesByType[key] = { aircraft_type_name: p.aircraft_type_name, manufacturer: p.manufacturer, model: p.model, profiles: [] };
    }
    profilesByType[key].profiles.push(p);
  }

  if (loading) return (
    <div className="cp-page">
      <div className="cp-loading"><div className="cp-spinner" /><p>Loading...</p></div>
    </div>
  );

  return (
    <div className="cp-page">
      {/* Hero */}
      <div className="cp-hero">
        <div className="cp-hero-overlay">
          <h1>Cabin Profiles</h1>
          <p>{airline.name} — Define Your Seating Layouts</p>
        </div>
      </div>

      <div className="cp-container">
        {/* Top bar */}
        <TopBar
          onBack={mode === 'list' ? onBack : () => { setMode('list'); setError(''); }}
          balance={airline.balance}
          backLabel={mode === 'list' ? backLabel : 'All Profiles'}
        />
        {mode === 'list' && (
          <div className="cp-list-header">
            <span className="cp-list-header-title">Cabin Profiles</span>
            <button onClick={openCreate} className="hdr-btn">+ New Profile</button>
          </div>
        )}

        <Toast error={error} onClearError={() => setError('')} success={success} onClearSuccess={() => setSuccess('')} />

        {/* ── LIST VIEW ── */}
        {mode === 'list' && (
          <div className="cp-list">
            {profiles.length === 0 ? (
              <div className="cp-empty">
                <div className="cp-empty-icon">✈</div>
                <p style={{ fontSize: '1.1rem', fontWeight: 600, color: '#2C2C2C', margin: '0 0 8px' }}>
                  No cabin profiles yet
                </p>
                <p style={{ color: '#666', margin: '0 0 20px' }}>
                  Create profiles to define seating layouts for your aircraft types.
                </p>
                <button onClick={openCreate} className="cp-btn-create">Create First Profile</button>
              </div>
            ) : (
              Object.entries(profilesByType).map(([typeId, group]) => (
                <div key={typeId} className="cp-type-group">
                  <h2 className="cp-type-heading">
                    <span className="cp-type-mfr">{group.manufacturer}</span> {group.model}
                  </h2>
                  <div className="cp-profile-grid">
                    {group.profiles.map(p => (
                      <div key={p.id} className="cp-profile-card">
                        <div className="cp-profile-head">
                          <h3 className="cp-profile-name">{p.name}</h3>
                          <span className="cp-total-cap">{p.total_capacity} seats</span>
                        </div>
                        <div className="cp-class-rows">
                          {p.classes.map(cls => {
                            const st = SEAT_TYPES.find(s => s.key === cls.seat_type);
                            return (
                              <div key={cls.class_type} className="cp-class-row">
                                <span className="cp-class-seat-name">{st ? st.label : cls.seat_type}</span>
                                <span className="cp-class-pct">{cls.percentage}%</span>
                                <span className="cp-class-cap">{cls.actual_capacity} pax</span>
                              </div>
                            );
                          })}
                        </div>
                        <div className="cp-card-actions">
                          <button className="cp-btn-edit" onClick={() => openEdit(p)}>Edit</button>
                          <button className="cp-btn-delete" onClick={() => handleDelete(p.id)}>Delete</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ── CREATE / EDIT VIEW ── */}
        {(mode === 'create' || mode === 'edit') && (
          <div className="cp-form-wrap">
            <div className="cp-form-card">
              <h2 className="cp-form-title">
                {mode === 'create' ? 'Create Cabin Profile' : 'Edit Cabin Profile'}
              </h2>

              {error && <div className="cp-msg cp-msg--error" style={{ marginBottom: '20px' }}>{error}</div>}

              <div className="cp-field">
                <label className="cp-label">Profile Name</label>
                <input
                  type="text"
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="e.g., Premium Short-Haul"
                  className="cp-input"
                />
              </div>

              <div className="cp-field">
                <label className="cp-label">Aircraft Type</label>
                <select
                  value={formTypeId}
                  onChange={e => setFormTypeId(e.target.value)}
                  disabled={mode === 'edit'}
                  className="cp-select"
                >
                  <option value="">Select aircraft type...</option>
                  {aircraftTypes.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.full_name} ({t.max_passengers} pax max)
                    </option>
                  ))}
                </select>
                {mode === 'edit' && (
                  <p className="cp-hint">Aircraft type cannot be changed after creation.</p>
                )}
              </div>

              {formClasses.map((cls, idx) => (
                <div key={cls.class_type} className="cp-class-config">
                  <div className="cp-class-config-header">
                    <h3>{CLASS_LABELS[cls.class_type]}</h3>
                  </div>

                  {/* Seat type cards */}
                  <p className="cp-sub-label">Seat Type</p>
                  <div className="cp-seat-type-grid">
                    {SEAT_TYPES.map(st => (
                      <button
                        key={st.key}
                        type="button"
                        className={`cp-seat-btn${cls.seat_type === st.key ? ' cp-seat-btn--active' : ''}`}
                        onClick={() => updateClass(idx, 'seat_type', st.key)}
                      >
                        <div className="cp-seat-img-wrap">
                          <img
                            src={`/seating-images/${st.image}`}
                            alt={st.label}
                            className="cp-seat-img"
                            onError={e => {
                              e.target.style.display = 'none';
                              e.target.parentNode.querySelector('.cp-seat-img-fallback').style.display = 'flex';
                            }}
                          />
                          <div className="cp-seat-img-fallback">✈</div>
                        </div>
                        <div className="cp-seat-label">{st.label}</div>
                        <div className="cp-seat-ratio">×{st.ratio.toFixed(1)}</div>
                      </button>
                    ))}
                  </div>

                  {/* Percentage */}
                  <p className="cp-sub-label">Space Allocation</p>
                  <div className="cp-pct-row">
                    <input
                      type="range"
                      min="0" max="100"
                      value={cls.percentage}
                      onChange={e => updateClass(idx, 'percentage', parseInt(e.target.value))}
                      className="cp-range"
                    />
                    <input
                      type="number"
                      min="0" max="100"
                      value={cls.percentage}
                      onChange={e => updateClass(idx, 'percentage', Math.max(0, Math.min(100, parseInt(e.target.value) || 0)))}
                      className="cp-pct-input"
                    />
                    <span className="cp-pct-unit">%</span>
                    <span className="cp-cap-display">
                      {maxPax > 0
                        ? <strong>{getClassCap(cls)} seats</strong>
                        : <span style={{ color: '#aaa' }}>Select type</span>
                      }
                    </span>
                  </div>
                </div>
              ))}

              {/* Summary */}
              <div className="cp-summary">
                <div className={`cp-summary-pct${totalPct > 100 ? ' warn' : totalPct === 100 ? ' ok' : ''}`}>
                  Space used: <strong>{totalPct}%</strong>
                  {totalPct > 100 && ' ⚠ Over 100% — cabin classes overlap'}
                  {totalPct === 100 && ' ✓ Perfect'}
                </div>
                {premiumPct > 40 && (
                  <div className="cp-summary-premium-warn">
                    ⚠ Business + First Class = <strong>{premiumPct}%</strong> — maximum is 40%. Reduce premium cabin space to save.
                  </div>
                )}
                {premiumPct > 0 && premiumPct <= 40 && (
                  <div className="cp-summary-premium-ok">
                    Premium cabins (Biz + First): <strong>{premiumPct}%</strong> / 40% max
                  </div>
                )}
                {maxPax > 0 && (
                  <div className="cp-summary-caps">
                    <span>Total: <strong>{totalCap}</strong> / {maxPax} max seats</span>
                    {formClasses.map(cls => (
                      <span key={cls.class_type} className="cp-chip">
                        {cls.class_type.charAt(0).toUpperCase()}: {getClassCap(cls)}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="cp-form-actions">
                <button className="cp-btn-cancel" onClick={() => { setMode('list'); setError(''); }}>
                  Cancel
                </button>
                <button className="cp-btn-save" onClick={handleSave}>
                  {mode === 'edit' ? 'Update Profile' : 'Create Profile'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <style>{`
        .cp-page { min-height: 100vh; background: #F5F5F5; }

        .cp-loading {
          display: flex; flex-direction: column; align-items: center;
          justify-content: center; min-height: 100vh; color: #2C2C2C; gap: 1rem;
        }
        .cp-spinner {
          width: 48px; height: 48px;
          border: 4px solid #E0E0E0; border-top-color: #2C2C2C;
          border-radius: 50%; animation: cp-spin 1s linear infinite;
        }
        @keyframes cp-spin { to { transform: rotate(360deg); } }

        .cp-hero {
          width: 100%; height: 240px;
          background: linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.6)),
                      url('/header-images/Headerimage_cabin.png') center/cover;
          display: flex; align-items: center; justify-content: center;
        }
        .cp-hero-overlay { text-align: center; color: white; }
        .cp-hero-overlay h1 { font-size: 2.5rem; margin: 0; text-shadow: 2px 2px 4px rgba(0,0,0,0.5); }
        .cp-hero-overlay p { margin: 8px 0 0; font-size: 1rem; opacity: 0.85; }

        .cp-container { max-width: 1100px; margin: 0 auto; padding: 24px 20px 60px; }

        .cp-top-bar {
          display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;
        }
        .cp-btn-back {
          background: white; border: 1px solid #E0E0E0; color: #2C2C2C;
          padding: 10px 18px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;
        }
        .cp-btn-back:hover { background: #F5F5F5; }
        .cp-btn-create {
          background: #2C2C2C; color: white; border: none;
          padding: 10px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600;
        }
        .cp-btn-create:hover { background: #444; }

        .cp-msg { padding: 12px 16px; border-radius: 6px; margin-bottom: 16px; font-size: 14px; }
        .cp-msg--error { background: #fee2e2; color: #dc2626; border: 1px solid #fca5a5; }
        .cp-msg--success { background: #dcfce7; color: #16a34a; border: 1px solid #86efac; }

        .cp-empty {
          text-align: center; padding: 60px 20px;
          background: white; border-radius: 12px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.08); color: #666;
        }
        .cp-empty-icon { font-size: 3rem; margin-bottom: 1rem; }

        .cp-list-header {
          display: flex; align-items: center; justify-content: space-between;
          background: #2C2C2C; color: white;
          padding: 14px 20px; border-radius: 8px; margin-bottom: 24px;
        }
        .cp-list-header-title {
          font-size: 0.78rem; font-weight: 700; text-transform: uppercase;
          letter-spacing: 0.1em; color: white;
        }

        .cp-type-group {
          margin-bottom: 32px; overflow: hidden;
          border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); background: white;
        }
        .cp-type-heading {
          font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
          color: white; margin: 0; padding: 14px 20px; background: #2C2C2C;
        }
        .cp-type-mfr { color: rgba(255,255,255,0.6); font-weight: 400; }
        .cp-type-group .cp-profile-grid { padding: 20px; }

        .cp-profile-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px;
        }
        .cp-profile-card {
          background: #F9F9F9; border-radius: 8px; padding: 20px;
          border: 1px solid #E8E8E8;
        }
        .cp-profile-head {
          display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px;
        }
        .cp-profile-name { font-size: 1rem; font-weight: 600; color: #2C2C2C; margin: 0; }
        .cp-total-cap { font-size: 0.85rem; color: #666; }

        .cp-class-rows { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
        .cp-class-row { display: flex; align-items: center; gap: 8px; font-size: 0.84rem; }
        .cp-class-badge {
          display: inline-block; padding: 2px 8px; border-radius: 4px;
          color: white; font-size: 0.72rem; font-weight: 600; min-width: 58px; text-align: center;
        }
        .cp-class-seat-name { color: #555; flex: 1; }
        .cp-class-pct { color: #888; font-size: 0.78rem; }
        .cp-class-cap { color: #2C2C2C; font-weight: 600; min-width: 48px; text-align: right; }

        .cp-card-actions {
          display: flex; gap: 8px; padding-top: 12px; border-top: 1px solid #F0F0F0;
        }
        .cp-btn-edit {
          flex: 1; background: #F5F5F5; border: 1px solid #E0E0E0; color: #2C2C2C;
          padding: 7px 12px; border-radius: 5px; cursor: pointer; font-size: 13px; font-weight: 500;
        }
        .cp-btn-edit:hover { background: #E8E8E8; }
        .cp-btn-delete {
          flex: 1; background: white; border: 1px solid #fca5a5; color: #dc2626;
          padding: 7px 12px; border-radius: 5px; cursor: pointer; font-size: 13px; font-weight: 500;
        }
        .cp-btn-delete:hover { background: #fee2e2; }

        /* Form */
        .cp-form-wrap { max-width: 820px; margin: 0 auto; }
        .cp-form-card {
          background: white; border-radius: 12px; padding: 32px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.08); overflow: hidden;
        }
        .cp-form-title {
          font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
          color: white; background: #2C2C2C;
          margin: -32px -32px 28px; padding: 14px 20px; border-radius: 8px 8px 0 0;
        }

        .cp-field { margin-bottom: 20px; }
        .cp-label {
          display: block; font-size: 12px; font-weight: 700; color: #555;
          margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em;
        }
        .cp-sub-label {
          font-size: 12px; font-weight: 600; color: #888; margin: 0 0 8px;
          text-transform: uppercase; letter-spacing: 0.03em;
        }
        .cp-input, .cp-select {
          width: 100%; padding: 10px 14px; border: 1px solid #E0E0E0;
          border-radius: 6px; font-size: 14px; color: #2C2C2C;
          background: white; outline: none; box-sizing: border-box;
        }
        .cp-input:focus, .cp-select:focus { border-color: #2C2C2C; }
        .cp-select:disabled { background: #F5F5F5; color: #888; }
        .cp-hint { margin: 4px 0 0; font-size: 12px; color: #888; }

        /* Class config block */
        .cp-class-config {
          border: 1px solid #E8E8E8; border-radius: 8px; padding: 20px; margin-bottom: 16px;
          overflow: hidden;
        }
        .cp-class-config-header {
          padding: 10px 16px; margin: -20px -20px 14px;
          background: #2C2C2C;
        }
        .cp-class-config-header h3 { margin: 0; font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: white; }

        /* Seat type selector */
        .cp-seat-type-grid { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
        .cp-seat-btn {
          flex: 1; min-width: 80px; max-width: 120px;
          background: #F9F9F9; border: 2px solid #E0E0E0; border-radius: 8px;
          padding: 0; cursor: pointer; text-align: center;
          overflow: hidden;
          transition: border-color 0.15s, background 0.15s;
        }
        .cp-seat-btn:hover { border-color: #aaa; background: #F5F5F5; }
        .cp-seat-btn--active { border-color: #2C2C2C !important; background: #EFEFEF; }

        .cp-seat-img-wrap {
          width: 100%; aspect-ratio: 3/2; overflow: hidden;
        }
        .cp-seat-img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .cp-seat-img-fallback {
          display: none; width: 100%; height: 100%;
          background: #E8E8E8;
          align-items: center; justify-content: center;
          font-size: 1.1rem; color: #888;
        }
        .cp-seat-label { font-size: 0.7rem; font-weight: 600; color: #2C2C2C; line-height: 1.2; padding: 6px 4px 2px; }
        .cp-seat-ratio { font-size: 0.68rem; color: #888; padding: 0 4px 6px; }

        /* Percentage row */
        .cp-pct-row {
          display: flex; align-items: center; gap: 10px;
        }
        .cp-range { flex: 1; height: 4px; accent-color: #2C2C2C; cursor: pointer; }
        .cp-pct-input {
          width: 60px; padding: 6px 8px; border: 1px solid #E0E0E0;
          border-radius: 5px; font-size: 14px; text-align: center; color: #2C2C2C;
        }
        .cp-pct-unit { font-size: 14px; color: #666; }
        .cp-cap-display { font-size: 0.85rem; color: #2C2C2C; min-width: 70px; text-align: right; }

        /* Summary */
        .cp-summary {
          background: #F9F9F9; border: 1px solid #E8E8E8; border-radius: 8px;
          padding: 16px; margin-bottom: 24px; display: flex; flex-direction: column; gap: 8px;
        }
        .cp-summary-pct { font-size: 14px; color: #666; }
        .cp-summary-pct.ok { color: #16a34a; font-weight: 600; }
        .cp-summary-pct.warn { color: #dc2626; font-weight: 600; }
        .cp-summary-premium-warn {
          font-size: 13px; color: #dc2626; font-weight: 600;
          background: #fef2f2; border: 1px solid #fecaca;
          border-radius: 6px; padding: 8px 12px;
        }
        .cp-summary-premium-ok {
          font-size: 13px; color: #555;
        }
        .cp-summary-caps {
          font-size: 14px; color: #2C2C2C; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        }
        .cp-chip {
          display: inline-block; padding: 2px 8px; border-radius: 10px;
          background: #E0E0E0; color: #2C2C2C; font-size: 0.75rem; font-weight: 600;
        }

        /* Form actions */
        .cp-form-actions { display: flex; gap: 12px; justify-content: flex-end; }
        .cp-btn-cancel {
          background: white; border: 1px solid #E0E0E0; color: #2C2C2C;
          padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;
        }
        .cp-btn-cancel:hover { background: #F5F5F5; }
        .cp-btn-save {
          background: #2C2C2C; color: white; border: none;
          padding: 12px 28px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600;
        }
        .cp-btn-save:hover { background: #444; }

        @media (max-width: 640px) {
          .cp-hero { height: 180px; }
          .cp-hero-overlay h1 { font-size: 1.8rem; }
          .cp-form-card { padding: 20px; }
          .cp-seat-btn { min-width: 64px; }
        }
      `}</style>
    </div>
  );
}

export default CabinProfiles;
