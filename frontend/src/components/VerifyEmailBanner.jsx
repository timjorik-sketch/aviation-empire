import { useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || '';
const DISMISS_KEY = 'verifyEmailBannerDismissed';

export default function VerifyEmailBanner({ user }) {
  const [dismissed, setDismissed] = useState(() => {
    if (typeof sessionStorage === 'undefined') return false;
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  });
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error
  const [message, setMessage] = useState('');

  if (!user || user.email_verified || dismissed) return null;

  const resend = async () => {
    setStatus('sending');
    setMessage('');
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/auth/resend-verification`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not resend.');
      setStatus('sent');
      setMessage(data.message || 'Verification email sent.');
    } catch (e) {
      setStatus('error');
      setMessage(e.message);
    }
  };

  const dismiss = () => {
    try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch {}
    setDismissed(true);
  };

  return (
    <div style={{
      background: '#fff7ed',
      border: '1px solid #fed7aa',
      color: '#9a3412',
      borderRadius: 8,
      padding: '12px 16px',
      marginBottom: 16,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
      fontSize: 14,
    }}>
      <span style={{ flex: '1 1 auto', minWidth: 200 }}>
        <strong>Verify your email</strong> — we sent a link to <strong>{user.email}</strong>.
        Verifying lets you recover your account if you ever forget your password.
        {status === 'sent' && <span style={{ color: '#166534', marginLeft: 8 }}>✓ {message}</span>}
        {status === 'error' && <span style={{ color: '#991b1b', marginLeft: 8 }}>{message}</span>}
      </span>
      <button
        onClick={resend}
        disabled={status === 'sending' || status === 'sent'}
        style={{
          background: '#9a3412', color: '#fff', border: 'none',
          padding: '6px 14px', borderRadius: 4, fontSize: 13,
          fontWeight: 600, cursor: status === 'sending' || status === 'sent' ? 'default' : 'pointer',
          opacity: status === 'sending' || status === 'sent' ? 0.6 : 1,
        }}
      >
        {status === 'sending' ? 'Sending…' : status === 'sent' ? 'Sent' : 'Resend email'}
      </button>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        style={{
          background: 'transparent', color: '#9a3412', border: 'none',
          fontSize: 18, lineHeight: 1, cursor: 'pointer', padding: '0 4px',
        }}
      >
        ×
      </button>
    </div>
  );
}
