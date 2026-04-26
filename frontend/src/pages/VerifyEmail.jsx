import { useEffect, useState } from 'react';
import axios from 'axios';
import './Auth.css';

export default function VerifyEmail({ token, onDone }) {
  const [status, setStatus] = useState('pending'); // pending | success | error
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await axios.post(
          `${import.meta.env.VITE_API_URL || ''}/api/auth/verify-email`,
          { token }
        );
        if (cancelled) return;

        // Update cached user so the banner disappears immediately if logged in
        try {
          const raw = localStorage.getItem('user');
          if (raw) {
            const u = JSON.parse(raw);
            u.email_verified = true;
            localStorage.setItem('user', JSON.stringify(u));
          }
        } catch {}

        setStatus('success');
        setMessage(res.data?.message || 'Email verified.');
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setMessage(err.response?.data?.error || 'Verification failed.');
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <>
      <div
        className="page-hero"
        style={{ backgroundImage: "url('/header-images/Headerimage_Home.png')" }}
      >
        <div className="page-hero-overlay">
          <h1>Email Verification</h1>
        </div>
      </div>
      <div className="auth-container">
        <div className="auth-card">
          {status === 'pending' && (
            <>
              <h2>Verifying…</h2>
              <p style={{ color: '#666', textAlign: 'center' }}>Just a moment.</p>
            </>
          )}
          {status === 'success' && (
            <>
              <h2>Email Verified!</h2>
              <p style={{ color: '#2C2C2C', marginBottom: 20, lineHeight: 1.5, textAlign: 'center' }}>
                {message}
              </p>
              <button onClick={onDone} className="btn-primary">Continue</button>
            </>
          )}
          {status === 'error' && (
            <>
              <h2>Verification Failed</h2>
              <div className="error-message">{message}</div>
              <p style={{ color: '#666', fontSize: 14, lineHeight: 1.5 }}>
                Your link may have expired or already been used. Log in and request a new
                verification email from the banner on your dashboard.
              </p>
              <button onClick={onDone} className="btn-primary">Back</button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
