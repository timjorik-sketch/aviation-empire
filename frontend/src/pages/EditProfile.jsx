import { useState, useEffect, useCallback } from 'react';
import Toast from '../components/Toast.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

// ── Modal: Change Password ──────────────────────────────────────────────────
function ChangePasswordModal({ onClose }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) { setError('Passwords do not match'); return; }
    if (newPassword.length < 6) { setError('New password must be at least 6 characters'); return; }
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/auth/change-password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSuccess('Password changed successfully');
      setTimeout(onClose, 1500);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ep-modal-backdrop" onClick={onClose}>
      <div className="ep-modal" onClick={e => e.stopPropagation()}>
        <div className="ep-modal-header">
          <span className="ep-modal-title">Change Password</span>
          <button className="ep-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="ep-modal-body">
          {error && <div className="ep-alert ep-alert-error">{error}</div>}
          {success && <div className="ep-alert ep-alert-success">{success}</div>}
          <form onSubmit={handleSubmit}>
            <div className="ep-form-group">
              <label>Current Password</label>
              <input
                type="password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <div className="ep-form-group">
              <label>New Password</label>
              <input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                autoComplete="new-password"
                minLength={6}
                required
              />
            </div>
            <div className="ep-form-group">
              <label>Confirm New Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </div>
            <div className="ep-modal-actions">
              <button type="submit" className="ep-btn-primary" disabled={saving}>
                {saving ? 'Saving...' : 'Change Password'}
              </button>
              <button type="button" className="ep-btn-secondary" onClick={onClose}>Cancel</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── Modal: Change E-Mail ────────────────────────────────────────────────────
function ChangeEmailModal({ currentEmail, onClose, onEmailChanged }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/auth/change-email`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ currentPassword, newEmail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSuccess('E-Mail changed successfully');
      onEmailChanged(data.newEmail);
      setTimeout(onClose, 1500);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ep-modal-backdrop" onClick={onClose}>
      <div className="ep-modal" onClick={e => e.stopPropagation()}>
        <div className="ep-modal-header">
          <span className="ep-modal-title">Change E-Mail</span>
          <button className="ep-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="ep-modal-body">
          {error && <div className="ep-alert ep-alert-error">{error}</div>}
          {success && <div className="ep-alert ep-alert-success">{success}</div>}
          <div className="ep-current-val">Current: <strong>{currentEmail}</strong></div>
          <form onSubmit={handleSubmit}>
            <div className="ep-form-group">
              <label>New E-Mail Address</label>
              <input
                type="email"
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                required
              />
            </div>
            <div className="ep-form-group">
              <label>Current Password</label>
              <input
                type="password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <div className="ep-modal-actions">
              <button type="submit" className="ep-btn-primary" disabled={saving}>
                {saving ? 'Saving...' : 'Change E-Mail'}
              </button>
              <button type="button" className="ep-btn-secondary" onClick={onClose}>Cancel</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── Modal: Delete Account ────────────────────────────────────────────────────
function DeleteAccountModal({ username, onClose, onDeleted }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (confirm !== username) { setError(`Type your username exactly: "${username}"`); return; }
    setDeleting(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/auth/account`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onDeleted();
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  };

  return (
    <div className="ep-modal-backdrop" onClick={onClose}>
      <div className="ep-modal ep-modal-danger" onClick={e => e.stopPropagation()}>
        <div className="ep-modal-header ep-modal-header-danger">
          <span className="ep-modal-title">Delete Account</span>
          <button className="ep-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="ep-modal-body">
          <div className="ep-delete-warning">
            <div className="ep-delete-warning-icon">⚠</div>
            <div>
              <strong>This action is permanent and cannot be undone.</strong>
              <p>All your airlines, aircraft, routes, flights, and all associated data will be deleted forever.</p>
            </div>
          </div>
          {error && <div className="ep-alert ep-alert-error">{error}</div>}
          <form onSubmit={handleSubmit}>
            <div className="ep-form-group">
              <label>Type your username to confirm: <strong>{username}</strong></label>
              <input
                type="text"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder={username}
                autoComplete="off"
                required
              />
            </div>
            <div className="ep-form-group">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <div className="ep-modal-actions">
              <button
                type="submit"
                className="ep-btn-delete-confirm"
                disabled={deleting || confirm !== username || !password}
              >
                {deleting ? 'Deleting...' : 'Delete My Account'}
              </button>
              <button type="button" className="ep-btn-secondary" onClick={onClose}>Cancel</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────
export default function EditProfile({ user, onBack, onLogout, onAirlinesChanged }) {
  const [profile, setProfile] = useState(null);
  const [airlines, setAirlines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const headers = { 'Authorization': `Bearer ${localStorage.getItem('token')}` };

  const fetchData = useCallback(async () => {
    try {
      const [profileRes, airlinesRes] = await Promise.all([
        fetch(`${API_URL}/api/auth/profile`, { headers }),
        fetch(`${API_URL}/api/airline/all`, { headers }),
      ]);
      const profileData = await profileRes.json();
      const airlinesData = await airlinesRes.json();
      if (profileRes.ok) setProfile(profileData.user);
      setAirlines(airlinesData.airlines || []);
    } catch (err) {
      setError('Failed to load profile data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleDeleteAirline = async (id, name) => {
    if (!window.confirm(`Delete airline "${name}"? This will permanently delete all aircraft, routes, and flights.`)) return;
    setDeletingId(id);
    setError('');
    try {
      const res = await fetch(`${API_URL}/api/airline/${id}`, {
        method: 'DELETE',
        headers,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const updated = airlines.filter(a => a.id !== id);
      setAirlines(updated);
      setSuccess(`Airline "${name}" deleted`);
      setTimeout(() => setSuccess(''), 3000);
      onAirlinesChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const formatDate = (dt) => {
    if (!dt) return '—';
    const d = new Date(dt);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  };

  return (
    <div className="ep-root">
      <style>{`
        .ep-root { min-height: 100vh; background: #F5F5F5; }

        /* ── Hero ── */
        .ep-hero {
          width: 100%; height: 260px;
          background: linear-gradient(rgba(0,0,0,0.45), rgba(0,0,0,0.65)),
                      url('/header-images/Headerimage_Home.png') center/cover;
          display: flex; align-items: center; justify-content: center;
        }
        .ep-hero h1 { color: #fff; font-size: 2.4rem; margin: 0; text-shadow: 2px 2px 4px rgba(0,0,0,0.5); }

        /* ── Top bar ── */
        .ep-topbar {
          background: #fff; border-bottom: 1px solid #E0E0E0;
          display: flex; align-items: center; gap: 12px;
          padding: 10px 32px;
        }
        .ep-topbar-back {
          background: transparent; border: 1px solid #E0E0E0; color: #555;
          padding: 7px 16px; border-radius: 6px; font-size: 0.88rem;
          cursor: pointer; transition: all 0.15s;
        }
        .ep-topbar-back:hover { background: #F5F5F5; border-color: #AAAAAA; }
        .ep-topbar-title { font-size: 1rem; font-weight: 600; color: #2C2C2C; }

        /* ── Layout ── */
        .ep-container { max-width: 1100px; margin: 0 auto; padding: 32px 24px 60px; }
        .ep-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; align-items: start; }
        @media (max-width: 768px) { .ep-cols { grid-template-columns: 1fr; } }

        /* ── Cards ── */
        .ep-card {
          background: #fff; border-radius: 8px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden;
        }
        .ep-card-header {
          padding: 14px 20px; border-bottom: 1px solid #F0F0F0;
          font-size: 0.88rem; font-weight: 700; color: #2C2C2C;
          text-transform: uppercase; letter-spacing: 0.05em;
        }
        .ep-card-body { padding: 20px; }

        /* ── Profile table ── */
        .ep-profile-table { width: 100%; border-collapse: collapse; }
        .ep-profile-table tr + tr td { border-top: 1px solid #F5F5F5; }
        .ep-profile-table td { padding: 10px 0; font-size: 0.9rem; }
        .ep-profile-table td:first-child { color: #666; width: 40%; }
        .ep-profile-table td:last-child { font-weight: 600; color: #2C2C2C; word-break: break-all; }

        .ep-profile-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 20px; }

        /* ── Buttons ── */
        .ep-btn-primary {
          background: #2C2C2C; color: #fff; border: none;
          padding: 9px 18px; border-radius: 6px; font-size: 0.88rem;
          font-weight: 600; cursor: pointer; transition: opacity 0.15s;
          white-space: nowrap;
        }
        .ep-btn-primary:hover { opacity: 0.8; }
        .ep-btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }

        .ep-btn-secondary {
          background: transparent; color: #555; border: 1px solid #E0E0E0;
          padding: 9px 18px; border-radius: 6px; font-size: 0.88rem;
          font-weight: 500; cursor: pointer; transition: all 0.15s;
        }
        .ep-btn-secondary:hover { background: #F5F5F5; border-color: #AAAAAA; }

        .ep-btn-outline {
          background: transparent; color: #2C2C2C; border: 1px solid #2C2C2C;
          padding: 8px 16px; border-radius: 6px; font-size: 0.85rem;
          font-weight: 600; cursor: pointer; transition: all 0.15s; width: 100%; text-align: left;
        }
        .ep-btn-outline:hover { background: #2C2C2C; color: #fff; }

        .ep-btn-danger {
          background: transparent; color: #dc2626; border: 1px solid #fca5a5;
          padding: 6px 12px; border-radius: 6px; font-size: 0.8rem;
          font-weight: 600; cursor: pointer; transition: all 0.15s;
          white-space: nowrap;
        }
        .ep-btn-danger:hover { background: #dc2626; color: #fff; border-color: #dc2626; }
        .ep-btn-danger:disabled { opacity: 0.4; cursor: not-allowed; }

        /* ── Airlines list ── */
        .ep-airline-list { display: flex; flex-direction: column; gap: 0; }
        .ep-airline-item {
          display: flex; align-items: center; gap: 12px;
          padding: 12px 0; border-bottom: 1px solid #F5F5F5;
        }
        .ep-airline-item:last-child { border-bottom: none; }
        .ep-al-code {
          font-size: 1rem; font-weight: 800; font-family: monospace;
          color: #2C2C2C; background: #F5F5F5; border-radius: 6px;
          padding: 4px 8px; min-width: 44px; text-align: center;
          flex-shrink: 0;
        }
        .ep-al-info { flex: 1; min-width: 0; }
        .ep-al-name { font-weight: 600; color: #2C2C2C; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ep-al-meta { font-size: 0.78rem; color: #666; margin-top: 2px; }
        .ep-al-badge {
          font-size: 0.7rem; font-weight: 700; background: #2C2C2C; color: #fff;
          border-radius: 4px; padding: 2px 6px; margin-left: 6px; vertical-align: middle;
        }

        .ep-empty { text-align: center; color: #AAAAAA; font-size: 0.85rem; font-style: italic; padding: 24px 0; }

        /* ── Alerts ── */
        .ep-alert { padding: 10px 14px; border-radius: 6px; font-size: 0.85rem; margin-bottom: 14px; }
        .ep-alert-error { background: #fef2f2; color: #dc2626; border: 1px solid #fca5a5; }
        .ep-alert-success { background: #f0fdf4; color: #16a34a; border: 1px solid #86efac; }

        /* ── Global alerts ── */
        .ep-global-alerts { margin-bottom: 20px; }

        /* ── Modal ── */
        .ep-modal-backdrop {
          position: fixed; inset: 0; background: rgba(0,0,0,0.5);
          display: flex; align-items: center; justify-content: center;
          z-index: 1000; padding: 16px;
        }
        .ep-modal {
          background: #fff; border-radius: 8px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.2);
          width: 100%; max-width: 440px;
        }
        .ep-modal-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 16px 20px; border-bottom: 1px solid #F0F0F0;
        }
        .ep-modal-title { font-size: 1rem; font-weight: 700; color: #2C2C2C; }
        .ep-modal-close {
          background: none; border: none; font-size: 1.4rem; cursor: pointer;
          color: #888; line-height: 1; padding: 0 2px;
        }
        .ep-modal-close:hover { color: #2C2C2C; }
        .ep-modal-body { padding: 20px; }

        .ep-form-group { margin-bottom: 14px; }
        .ep-form-group label { display: block; font-size: 0.82rem; font-weight: 600; color: #555; margin-bottom: 5px; }
        .ep-form-group input {
          width: 100%; padding: 9px 12px; border: 1px solid #E0E0E0;
          border-radius: 6px; font-size: 0.9rem; color: #2C2C2C;
          outline: none; box-sizing: border-box;
        }
        .ep-form-group input:focus { border-color: #2C2C2C; }

        .ep-modal-actions { display: flex; gap: 10px; margin-top: 18px; }
        .ep-current-val { font-size: 0.85rem; color: #666; margin-bottom: 16px; }

        /* ── Danger zone ── */
        .ep-danger-zone {
          margin-top: 24px; padding-top: 20px;
          border-top: 1px solid #fca5a5;
        }
        .ep-danger-zone-label {
          font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
          letter-spacing: 0.08em; color: #dc2626; margin-bottom: 10px;
        }
        .ep-btn-delete {
          background: transparent; color: #dc2626; border: 1px solid #fca5a5;
          padding: 9px 18px; border-radius: 6px; font-size: 0.88rem;
          font-weight: 600; cursor: pointer; transition: all 0.15s; width: 100%; text-align: left;
        }
        .ep-btn-delete:hover { background: #dc2626; color: #fff; border-color: #dc2626; }

        .ep-modal-danger { border-top: 3px solid #dc2626; }
        .ep-modal-header-danger { background: #fef2f2; }

        .ep-delete-warning {
          display: flex; gap: 12px; align-items: flex-start;
          background: #fef2f2; border: 1px solid #fca5a5; border-radius: 6px;
          padding: 14px; margin-bottom: 18px; font-size: 0.85rem; color: #7f1d1d;
        }
        .ep-delete-warning-icon { font-size: 1.4rem; line-height: 1; flex-shrink: 0; }
        .ep-delete-warning p { margin: 4px 0 0; color: #991b1b; }

        .ep-btn-delete-confirm {
          background: #dc2626; color: #fff; border: none;
          padding: 9px 18px; border-radius: 6px; font-size: 0.88rem;
          font-weight: 600; cursor: pointer; transition: opacity 0.15s;
        }
        .ep-btn-delete-confirm:hover { opacity: 0.85; }
        .ep-btn-delete-confirm:disabled { opacity: 0.4; cursor: not-allowed; }
      `}</style>

      {/* Hero */}
      <div className="ep-hero">
        <h1>Edit Profile</h1>
      </div>

      {/* Top bar */}
      <div className="ep-topbar">
        <button className="ep-topbar-back" onClick={onBack}>← Back</button>
        <span className="ep-topbar-title">Account Settings</span>
      </div>

      <div className="ep-container">
        <Toast error={error} onClearError={() => setError('')} success={success} onClearSuccess={() => setSuccess('')} />

        {loading ? (
          <div style={{ textAlign: 'center', color: '#666', padding: '60px 0' }}>Loading...</div>
        ) : (
          <div className="ep-cols">

            {/* ── Left: Profile Information ── */}
            <div className="ep-card">
              <div className="ep-card-header">Profile Information</div>
              <div className="ep-card-body">
                <table className="ep-profile-table">
                  <tbody>
                    <tr>
                      <td>Username</td>
                      <td>{profile?.username || user?.username || '—'}</td>
                    </tr>
                    <tr>
                      <td>E-Mail</td>
                      <td>{profile?.email || user?.email || '—'}</td>
                    </tr>
                    <tr>
                      <td>Member since</td>
                      <td>{formatDate(profile?.created_at)}</td>
                    </tr>
                  </tbody>
                </table>

                <div className="ep-profile-actions">
                  <button className="ep-btn-outline" onClick={() => setShowPasswordModal(true)}>
                    Change Password
                  </button>
                  <button className="ep-btn-outline" onClick={() => setShowEmailModal(true)}>
                    Change E-Mail
                  </button>
                </div>

                <div className="ep-danger-zone">
                  <div className="ep-danger-zone-label">Danger Zone</div>
                  <button className="ep-btn-delete" onClick={() => setShowDeleteModal(true)}>
                    Delete Account
                  </button>
                </div>
              </div>
            </div>

            {/* ── Right: Airlines ── */}
            <div className="ep-card">
              <div className="ep-card-header">Airlines ({airlines.length})</div>
              <div className="ep-card-body">
                {airlines.length === 0 ? (
                  <div className="ep-empty">No airlines yet</div>
                ) : (
                  <div className="ep-airline-list">
                    {airlines.map(al => (
                      <div key={al.id} className="ep-airline-item">
                        <span className="ep-al-code">{al.airline_code}</span>
                        <div className="ep-al-info">
                          <div className="ep-al-name">
                            {al.name}
                            {al.is_active && <span className="ep-al-badge">Active</span>}
                          </div>
                          <div className="ep-al-meta">
                            ${al.balance?.toLocaleString()} · {al.fleet_count} aircraft · {al.home_airport_code}
                          </div>
                        </div>
                        <button
                          className="ep-btn-danger"
                          disabled={deletingId === al.id}
                          onClick={() => handleDeleteAirline(al.id, al.name)}
                        >
                          {deletingId === al.id ? '...' : 'Delete'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

          </div>
        )}
      </div>

      {/* Modals */}
      {showPasswordModal && (
        <ChangePasswordModal onClose={() => setShowPasswordModal(false)} />
      )}
      {showEmailModal && (
        <ChangeEmailModal
          currentEmail={profile?.email || user?.email || ''}
          onClose={() => setShowEmailModal(false)}
          onEmailChanged={(newEmail) => setProfile(prev => prev ? { ...prev, email: newEmail } : prev)}
        />
      )}
      {showDeleteModal && (
        <DeleteAccountModal
          username={profile?.username || user?.username || ''}
          onClose={() => setShowDeleteModal(false)}
          onDeleted={() => {
            localStorage.removeItem('token');
            onLogout?.();
          }}
        />
      )}
    </div>
  );
}
