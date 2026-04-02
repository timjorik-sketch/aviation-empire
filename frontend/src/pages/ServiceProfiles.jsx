import { useState, useEffect, useCallback } from 'react';
import TopBar from '../components/TopBar.jsx';
import Toast from '../components/Toast.jsx';

const API_URL = '';

const CABIN_LABELS = { economy: 'Economy', business: 'Business', first: 'First Class' };

const CATEGORY_COLORS = {
  Beverages:     '#3b82f6',
  Food:          '#f97316',
  Entertainment: '#8b5cf6',
  Comfort:       '#10b981',
  Luggage:       '#78716c',
};

// Maps cabin class key → image field on item object
const CABIN_IMAGE_KEY = { economy: 'image_eco', business: 'image_bus', first: 'image_fir' };

function ServiceProfiles({ airline, onBack, backLabel = 'Dashboard' }) {
  const [view, setView] = useState('list');   // 'list' | 'edit'
  const [profiles, setProfiles] = useState([]);
  const [itemTypes, setItemTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Edit state
  const [editingId, setEditingId] = useState(null);   // null = create new
  const [profileName, setProfileName] = useState('');
  const [selectedItems, setSelectedItems] = useState(new Set()); // "itemTypeId|cabinClass"

  useEffect(() => { fetchInitial(); }, []);

  const fetchInitial = async () => {
    const token = localStorage.getItem('token');
    try {
      const [profilesRes, typesRes] = await Promise.all([
        fetch(`${API_URL}/api/service-profiles`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        fetch(`${API_URL}/api/service-profiles/item-types`)
      ]);
      const profilesData = await profilesRes.json();
      const typesData = await typesRes.json();
      setProfiles(profilesData.profiles || []);
      setItemTypes(typesData.item_types || []);
    } catch (err) {
      console.error('Failed to fetch service profiles:', err);
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const fetchProfiles = async () => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/service-profiles`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setProfiles(data.profiles || []);
    } catch (err) {
      console.error('Failed to refresh profiles:', err);
    }
  };

  // ── Navigation ───────────────────────────────────────────────────────────

  const startCreate = () => {
    setEditingId(null);
    setProfileName('');
    setSelectedItems(new Set());
    setError('');
    setSuccess('');
    setView('edit');
  };

  const startEdit = async (profileId) => {
    setError('');
    setSuccess('');
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/service-profiles/${profileId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load profile');

      setEditingId(profileId);
      setProfileName(data.profile.name);

      // Rebuild selectedItems Set from the returned array
      const set = new Set(
        data.selected_items.map(i => `${i.item_type_id}|${i.cabin_class}`)
      );
      setSelectedItems(set);
      setView('edit');
    } catch (err) {
      setError(err.message);
    }
  };

  // ── Delete modal state ───────────────────────────────────────────────────
  const [deleteModal, setDeleteModal] = useState(null);
  // { profileId, profileName, inUse, routeCount, scheduleCount, replacementId }

  const handleDelete = async (profileId, profileName) => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/service-profiles/${profileId}/usage`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setDeleteModal({
        profileId,
        profileName,
        inUse: data.in_use,
        routeCount: data.route_count,
        scheduleCount: data.schedule_count,
        replacementId: '',
      });
    } catch (err) {
      setError('Could not check profile usage.');
    }
  };

  const confirmDelete = async () => {
    const { profileId, inUse, replacementId } = deleteModal;
    if (inUse && !replacementId) {
      setError('Please select a replacement profile.');
      return;
    }
    const token = localStorage.getItem('token');
    try {
      const body = replacementId ? { replacement_id: parseInt(replacementId) } : {};
      const res = await fetch(`${API_URL}/api/service-profiles/${profileId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete');
      }
      setDeleteModal(null);
      await fetchProfiles();
      setSuccess('Profile deleted.');
    } catch (err) {
      setError(err.message);
    }
  };

  const backToList = () => {
    setView('list');
    setError('');
    setSuccess('');
  };

  // ── Item selection ───────────────────────────────────────────────────────

  const key = (itemTypeId, cabinClass) => `${itemTypeId}|${cabinClass}`;

  const isSelected = (itemTypeId, cabinClass) =>
    selectedItems.has(key(itemTypeId, cabinClass));

  const toggleItem = (itemTypeId, cabinClass) => {
    const k = key(itemTypeId, cabinClass);
    setSelectedItems(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  const itemPrice = (item, cabinClass) =>
    cabinClass === 'first'    ? (item.price_first    ?? item.price_economy ?? 0) :
    cabinClass === 'business' ? (item.price_business ?? item.price_economy ?? 0) :
    (item.price_economy ?? 0);

  const cabinTotal = (cabinClass) => {
    let total = 0;
    for (const item of itemTypes) {
      if (isSelected(item.id, cabinClass)) {
        total += itemPrice(item, cabinClass);
      }
    }
    return total;
  };

  // ── Save ─────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!profileName.trim()) {
      setError('Profile name is required.');
      return;
    }
    setError('');
    setSaving(true);
    const token = localStorage.getItem('token');

    const items = [];
    for (const k of selectedItems) {
      const [itemTypeId, cabinClass] = k.split('|');
      items.push({ item_type_id: parseInt(itemTypeId), cabin_class: cabinClass });
    }

    const url = editingId
      ? `${API_URL}/api/service-profiles/${editingId}`
      : `${API_URL}/api/service-profiles`;
    const method = editingId ? 'PUT' : 'POST';

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name: profileName.trim(), items })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save profile');
      await fetchProfiles();
      setSuccess(editingId ? 'Profile updated.' : 'Profile created.');
      setView('list');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="sp-page">
        <div className="sp-loading">
          <div className="sp-spinner"></div>
          <p>Loading service profiles...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="sp-page">
      {/* Hero */}
      <div className="sp-hero">
        <div className="sp-hero-overlay">
          <h1>Service Profiles</h1>
          <p>{airline.name} — Cabin Service Configuration</p>
        </div>
      </div>

      <div className="sp-container">
        {/* Top Bar */}
        <TopBar
          onBack={view === 'edit' ? backToList : onBack}
          balance={airline.balance}
          backLabel={view === 'edit' ? 'Back to Profiles' : backLabel}
        />

        <Toast error={error} onClearError={() => setError('')} success={success} onClearSuccess={() => setSuccess('')} />

        {/* ── LIST VIEW ─────────────────────────────────────────────── */}
        {view === 'list' && (
          <section className="sp-section">
            <div className="sp-section-bar">
              <span className="sp-section-bar-title">Service Profiles</span>
              <button className="hdr-btn" onClick={startCreate}>
                + Add New Profile
              </button>
            </div>

            {profiles.length === 0 ? (
              <div className="sp-empty">
                <p>No service profiles yet.</p>
                <button className="sp-btn-add" style={{ marginTop: '1rem' }} onClick={startCreate}>
                  + Create your first profile
                </button>
              </div>
            ) : (
              <div className="sp-table-wrap">
                <table className="sp-table">
                  <thead>
                    <tr>
                      <th>Profile Name</th>
                      <th>Economy Cost</th>
                      <th>Business Cost</th>
                      <th>First Class Cost</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {profiles.map(p => (
                      <tr key={p.id}>
                        <td className="sp-td-name">{p.name}</td>
                        <td>${p.economy_cost.toFixed(2)} / pax</td>
                        <td>${p.business_cost.toFixed(2)} / pax</td>
                        <td>${p.first_cost.toFixed(2)} / pax</td>
                        <td className="sp-td-actions">
                          <button className="sp-btn-edit" onClick={() => startEdit(p.id)}>
                            Edit
                          </button>
                          <button className="sp-btn-delete" onClick={() => handleDelete(p.id, p.name)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* ── EDIT / CREATE VIEW ────────────────────────────────────── */}
        {view === 'edit' && (
          <>
            <section className="sp-section">
              <div className="sp-section-bar">
                <span className="sp-section-bar-title">{editingId ? 'Edit Profile' : 'Create New Profile'}</span>
              </div>

              {/* Profile name */}
              <div className="sp-name-row">
                <label className="sp-name-label">Profile Name</label>
                <input
                  type="text"
                  className="sp-name-input"
                  placeholder="e.g., Economy Basic, Business Premium…"
                  value={profileName}
                  onChange={e => setProfileName(e.target.value)}
                  maxLength={60}
                />
              </div>
            </section>

            {/* One section per cabin class */}
            {['economy', 'business', 'first'].map(cabin => (
              <section key={cabin} className="sp-section sp-section--cabin">
                <div className="sp-section-bar">
                  <span className="sp-section-bar-title">{CABIN_LABELS[cabin]}</span>
                  <div className="sp-cabin-total sp-cabin-total--hdr">
                    Total:&nbsp;
                    <strong>${cabinTotal(cabin).toFixed(2)}</strong> / pax
                  </div>
                </div>

                <div className="sp-items-grid">
                  {itemTypes.map(item => {
                    const checked   = isSelected(item.id, cabin);
                    const color     = CATEGORY_COLORS[item.category] || '#999';
                    const imgField  = CABIN_IMAGE_KEY[cabin];
                    const imgFile   = item[imgField];
                    return (
                      <div
                        key={item.id}
                        className={`sp-item-card${checked ? ' sp-item-card--selected' : ''}`}
                        onClick={() => toggleItem(item.id, cabin)}
                      >
                        {/* Image — left, 3:2 ratio */}
                        <div className="sp-item-img-wrap">
                          {imgFile ? (
                            <img
                              src={`/service-images/${imgFile}`}
                              alt={item.item_name}
                              className="sp-item-img"
                            />
                          ) : (
                            <div className="sp-item-img-fallback" style={{ background: color }} />
                          )}
                        </div>

                        {/* Info — right */}
                        <div className="sp-item-body">
                          <div className="sp-item-category">{item.category}</div>
                          <div className="sp-item-name">{item.item_name}</div>
                          <div className="sp-item-price-row">
                            <span className="sp-item-price">
                              +<strong>${itemPrice(item, cabin).toFixed(2)}</strong>&nbsp;/&nbsp;pax
                            </span>
                            <label className="sp-item-check" onClick={e => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleItem(item.id, cabin)}
                              />
                            </label>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}

            {/* Save / Cancel */}
            <div className="sp-save-bar">
              <button className="sp-btn-cancel" onClick={backToList} disabled={saving}>
                Cancel
              </button>
              <button className="sp-btn-save" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : (editingId ? 'Update Profile' : 'Create Profile')}
              </button>
            </div>
          </>
        )}
      </div>

      <style>{`
        .sp-page {
          min-height: 100vh;
          background: #F5F5F5;
        }

        .sp-loading {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          color: #2C2C2C;
          gap: 1rem;
        }

        .sp-spinner {
          width: 48px;
          height: 48px;
          border: 4px solid #E0E0E0;
          border-top-color: #2C2C2C;
          border-radius: 50%;
          animation: sp-spin 1s linear infinite;
        }

        @keyframes sp-spin { to { transform: rotate(360deg); } }

        /* Hero */
        .sp-hero {
          width: 100%;
          height: 280px;
          background: linear-gradient(rgba(0,0,0,0.45), rgba(0,0,0,0.65)),
                      url('/header-images/Headerimage_Services.png') center/cover;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .sp-hero-overlay {
          text-align: center;
          color: white;
        }

        .sp-hero-overlay h1 {
          font-size: 2.75rem;
          margin: 0;
          text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }

        .sp-hero-overlay p {
          font-size: 1.1rem;
          margin-top: 0.5rem;
          opacity: 0.9;
        }

        /* Container */
        .sp-container {
          max-width: 1100px;
          margin: 0 auto;
          padding: 24px;
        }

        /* Top Bar */
        .sp-top-bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1.5rem;
          flex-wrap: wrap;
          gap: 1rem;
        }

        .sp-btn-back {
          background: #2C2C2C;
          color: white;
          border: none;
          padding: 0.75rem 1.5rem;
          border-radius: 6px;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          transition: opacity 0.2s;
        }

        .sp-btn-back:hover { opacity: 0.85; }

        .sp-balance {
          background: white;
          padding: 0.75rem 1.5rem;
          border-radius: 6px;
          color: #2C2C2C;
          border: 1px solid #E0E0E0;
        }

        .sp-balance-label { margin-right: 0.5rem; color: #666666; }
        .sp-balance-amount { font-weight: 700; font-size: 1.1rem; }

        /* Messages */
        .sp-msg {
          padding: 1rem;
          border-radius: 6px;
          margin-bottom: 1rem;
          text-align: center;
          font-size: 0.95rem;
        }

        .sp-msg--error   { background: #fee2e2; color: #dc2626; border: 1px solid #fca5a5; }
        .sp-msg--success { background: #dcfce7; color: #16a34a; border: 1px solid #86efac; }

        /* Section card */
        .sp-section {
          background: white;
          border-radius: 8px;
          padding: 2rem;
          margin-bottom: 1.5rem;
          box-shadow: 0 2px 8px rgba(0,0,0,0.08);
          overflow: hidden;
        }

        .sp-section--cabin {
          padding-bottom: 1.5rem;
        }

        /* Black header bar inside sp-section */
        .sp-section-bar {
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

        .sp-section-bar-title {
          font-size: 0.78rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: white;
        }


        .sp-cabin-total--hdr {
          font-size: 0.82rem;
          color: rgba(255,255,255,0.75);
          background: rgba(255,255,255,0.12);
          padding: 0.3rem 0.75rem;
          border-radius: 5px;
          border: 1px solid rgba(255,255,255,0.2);
        }
        .sp-cabin-total--hdr strong { color: white; }

        .sp-subtitle {
          margin: 0.4rem 0 0;
          color: #666666;
          font-size: 0.9rem;
        }

        /* Add button */
        .sp-btn-add {
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
        }

        .sp-btn-add:hover { opacity: 0.85; }

        /* Empty state */
        .sp-empty {
          text-align: center;
          padding: 3rem;
          color: #999;
        }

        /* Table */
        .sp-table-wrap {
          overflow-x: auto;
        }

        .sp-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.9rem;
        }

        .sp-table thead tr {
          background: #FAFAFA;
          border-bottom: 2px solid #E8E8E8;
        }

        .sp-table th {
          padding: 0.7rem 1rem;
          text-align: left;
          font-size: 0.78rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #666666;
          white-space: nowrap;
        }

        .sp-table td {
          padding: 0.85rem 1rem;
          border-bottom: 1px solid #F2F2F2;
          color: #2C2C2C;
          vertical-align: middle;
        }

        .sp-table tbody tr:last-child td { border-bottom: none; }
        .sp-table tbody tr:hover td { background: #FAFAFA; }

        .sp-td-name {
          font-weight: 600;
        }

        .sp-td-actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }

        .sp-btn-edit {
          padding: 0.35rem 0.9rem;
          border: 1px solid #2C2C2C;
          border-radius: 5px;
          background: white;
          color: #2C2C2C;
          font-size: 0.82rem;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s, color 0.15s;
          white-space: nowrap;
        }

        .sp-btn-edit:hover {
          background: #2C2C2C;
          color: white;
        }

        .sp-btn-delete {
          padding: 0.35rem 0.9rem;
          border: 1px solid #fca5a5;
          border-radius: 5px;
          background: white;
          color: #dc2626;
          font-size: 0.82rem;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s, color 0.15s;
          white-space: nowrap;
        }

        .sp-btn-delete:hover {
          background: #dc2626;
          color: white;
        }

        /* Profile name input */
        .sp-name-row {
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-width: 480px;
        }

        .sp-name-label {
          font-size: 0.82rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #666666;
        }

        .sp-name-input {
          padding: 0.75rem 1rem;
          border: 1px solid #E0E0E0;
          border-radius: 6px;
          font-size: 1rem;
          color: #2C2C2C;
          width: 100%;
        }

        .sp-name-input:focus {
          outline: none;
          border-color: #2C2C2C;
        }

        /* Cabin section header */
        .sp-cabin-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1.25rem;
          flex-wrap: wrap;
          gap: 0.5rem;
        }

        .sp-cabin-title {
          margin: 0;
          font-size: 1.2rem;
          font-weight: 700;
          color: #2C2C2C;
        }

        .sp-cabin-total {
          font-size: 0.9rem;
          color: #666666;
          background: #F5F5F5;
          padding: 0.4rem 0.9rem;
          border-radius: 6px;
          border: 1px solid #E0E0E0;
        }

        .sp-cabin-total strong {
          color: #2C2C2C;
        }

        /* Items grid — 3 columns */
        .sp-items-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
        }

        /* Item card — horizontal: image left, info right */
        .sp-item-card {
          display: flex;
          flex-direction: row;
          align-items: stretch;
          border: 2px solid #E0E0E0;
          border-radius: 8px;
          overflow: hidden;
          cursor: pointer;
          transition: border-color 0.15s, box-shadow 0.15s;
          background: white;
          user-select: none;
          min-height: 80px;
        }

        .sp-item-card:hover {
          border-color: #AAAAAA;
          box-shadow: 0 2px 6px rgba(0,0,0,0.08);
        }

        .sp-item-card--selected {
          border-color: #2C2C2C;
          box-shadow: 0 2px 6px rgba(0,0,0,0.12);
        }

        .sp-item-card--selected .sp-item-body {
          background: #FAFAFA;
        }

        /* Image — left side, fixed width, 3:2 aspect ratio */
        .sp-item-img-wrap {
          width: 120px;
          min-width: 120px;
          flex-shrink: 0;
          overflow: hidden;
          background: #f0f0f0;
          position: relative;
        }

        .sp-item-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          object-position: center;
          display: block;
        }

        .sp-item-img-fallback {
          width: 100%;
          height: 100%;
        }

        /* Info — right side */
        .sp-item-body {
          flex: 1;
          min-width: 0;
          padding: 7px 10px;
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 2px;
        }

        .sp-item-category {
          font-size: 0.62rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #AAAAAA;
          line-height: 1;
        }

        .sp-item-name {
          font-size: 0.8rem;
          font-weight: 700;
          color: #2C2C2C;
          line-height: 1.25;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .sp-item-price-row {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-top: 1px;
        }

        .sp-item-price {
          font-size: 0.72rem;
          color: #666666;
          white-space: nowrap;
        }

        .sp-item-price strong {
          color: #2C2C2C;
          font-weight: 700;
        }

        .sp-item-check {
          display: flex;
          align-items: center;
          margin-left: auto;
          cursor: pointer;
          flex-shrink: 0;
        }

        .sp-item-check input[type="checkbox"] {
          width: 13px;
          height: 13px;
          cursor: pointer;
          accent-color: #2C2C2C;
        }

        /* Save bar */
        .sp-save-bar {
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          margin-top: 0.5rem;
          margin-bottom: 2rem;
        }

        .sp-btn-cancel {
          padding: 0.75rem 2rem;
          border: 1px solid #E0E0E0;
          border-radius: 6px;
          background: white;
          color: #2C2C2C;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.2s;
        }

        .sp-btn-cancel:hover:not(:disabled) { background: #F5F5F5; }

        .sp-btn-save {
          padding: 0.75rem 2rem;
          border: none;
          border-radius: 6px;
          background: #2C2C2C;
          color: white;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          transition: opacity 0.2s;
        }

        .sp-btn-save:hover:not(:disabled) { opacity: 0.85; }

        .sp-btn-cancel:disabled,
        .sp-btn-save:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        /* Delete confirmation modal */
        .sp-modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.45);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .sp-modal {
          background: white;
          border-radius: 10px;
          padding: 2rem;
          width: 100%;
          max-width: 440px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.18);
        }

        .sp-modal h3 {
          margin: 0 0 0.75rem;
          font-size: 1.15rem;
          font-weight: 700;
          color: #2C2C2C;
        }

        .sp-modal-warning {
          background: #fff7ed;
          border: 1px solid #fed7aa;
          border-radius: 6px;
          padding: 0.85rem 1rem;
          margin-bottom: 1.25rem;
          font-size: 0.88rem;
          color: #92400e;
          line-height: 1.5;
        }

        .sp-modal-desc {
          font-size: 0.9rem;
          color: #555;
          margin: 0 0 1.25rem;
          line-height: 1.5;
        }

        .sp-modal-label {
          display: block;
          font-size: 0.82rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #666;
          margin-bottom: 0.4rem;
        }

        .sp-modal-select {
          width: 100%;
          padding: 0.65rem 0.9rem;
          border: 1px solid #E0E0E0;
          border-radius: 6px;
          font-size: 0.95rem;
          color: #2C2C2C;
          margin-bottom: 1.5rem;
          background: white;
        }

        .sp-modal-select:focus {
          outline: none;
          border-color: #2C2C2C;
        }

        .sp-modal-actions {
          display: flex;
          gap: 0.75rem;
          justify-content: flex-end;
        }

        .sp-modal-cancel {
          padding: 0.6rem 1.25rem;
          border: 1px solid #E0E0E0;
          border-radius: 6px;
          background: white;
          color: #2C2C2C;
          font-size: 0.9rem;
          font-weight: 600;
          cursor: pointer;
        }

        .sp-modal-cancel:hover { background: #F5F5F5; }

        .sp-modal-confirm {
          padding: 0.6rem 1.25rem;
          border: none;
          border-radius: 6px;
          background: #dc2626;
          color: white;
          font-size: 0.9rem;
          font-weight: 600;
          cursor: pointer;
        }

        .sp-modal-confirm:hover { background: #b91c1c; }

        /* Responsive */
        @media (max-width: 900px) {
          .sp-items-grid { grid-template-columns: repeat(2, 1fr); }
        }

        @media (max-width: 768px) {
          .sp-hero { height: 200px; }
          .sp-hero-overlay h1 { font-size: 1.75rem; }
          .sp-section { padding: 1.25rem; }
          .sp-top-bar { flex-direction: column; align-items: stretch; }
          .sp-items-grid { grid-template-columns: repeat(2, 1fr); }
          .sp-section-header { flex-direction: column; align-items: stretch; }
          .sp-cabin-header { flex-direction: column; align-items: flex-start; }
          .sp-save-bar { flex-direction: column; }
          .sp-btn-cancel, .sp-btn-save { width: 100%; }
        }

        @media (max-width: 480px) {
          .sp-items-grid { grid-template-columns: repeat(2, 1fr); }
        }
      `}</style>

      {/* ── DELETE CONFIRMATION MODAL ─────────────────────────────────── */}
      {deleteModal && (
        <div className="sp-modal-overlay" onClick={() => setDeleteModal(null)}>
          <div className="sp-modal" onClick={e => e.stopPropagation()}>
            <h3>Delete "{deleteModal.profileName}"?</h3>

            {deleteModal.inUse ? (
              <>
                <div className="sp-modal-warning">
                  ⚠️ This profile is actively in use:{' '}
                  {deleteModal.routeCount > 0 && <><strong>{deleteModal.routeCount}</strong> route{deleteModal.routeCount !== 1 ? 's' : ''}</>}
                  {deleteModal.routeCount > 0 && deleteModal.scheduleCount > 0 && ' and '}
                  {deleteModal.scheduleCount > 0 && <><strong>{deleteModal.scheduleCount}</strong> scheduled flight{deleteModal.scheduleCount !== 1 ? 's' : ''}</>}.
                </div>
                <p className="sp-modal-desc">
                  Select a replacement profile. All routes and schedules currently using this profile will be switched to the replacement.
                </p>
                <label className="sp-modal-label">Replace with</label>
                <select
                  className="sp-modal-select"
                  value={deleteModal.replacementId}
                  onChange={e => setDeleteModal(prev => ({ ...prev, replacementId: e.target.value }))}
                >
                  <option value="">— Select a profile —</option>
                  {profiles
                    .filter(p => p.id !== deleteModal.profileId)
                    .map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))
                  }
                </select>
              </>
            ) : (
              <p className="sp-modal-desc">
                This profile is not in use. Are you sure you want to delete it? This cannot be undone.
              </p>
            )}

            <div className="sp-modal-actions">
              <button className="sp-modal-cancel" onClick={() => setDeleteModal(null)}>Cancel</button>
              <button
                className="sp-modal-confirm"
                onClick={confirmDelete}
                disabled={deleteModal.inUse && !deleteModal.replacementId}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ServiceProfiles;
