import { useState } from 'react';
import axios from 'axios';
import './Auth.css';

export default function ForgotPassword({ onBack }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | sent
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setStatus('loading');
    try {
      await axios.post(
        `${import.meta.env.VITE_API_URL || ''}/api/auth/forgot-password`,
        { email: email.trim() }
      );
      setStatus('sent');
    } catch (err) {
      setError(err.response?.data?.error || 'Something went wrong — please try again.');
      setStatus('idle');
    }
  };

  return (
    <>
      <div
        className="page-hero"
        style={{ backgroundImage: "linear-gradient(rgba(0,0,0,0.4),rgba(0,0,0,0.6)),url('/header-images/Headerimage_Home.png')" }}
      >
        <div className="page-hero-overlay">
          <h1>Reset Password</h1>
        </div>
      </div>
      <div className="auth-container">
        <div className="auth-card">
          <h2>Forgot your password?</h2>

          {status === 'sent' ? (
            <>
              <p style={{ color: '#2C2C2C', marginBottom: 20, lineHeight: 1.5 }}>
                If an account exists for <strong>{email}</strong>, we've sent a password
                reset link. Check your inbox (and spam folder) — the link is valid for 1 hour.
              </p>
              <button onClick={onBack} className="btn-primary">
                Back to Login
              </button>
            </>
          ) : (
            <>
              <p style={{ color: '#666', marginTop: -10, marginBottom: 20, fontSize: 14, lineHeight: 1.5 }}>
                Enter the email address linked to your account and we'll send you a secure
                reset link.
              </p>

              {error && <div className="error-message">{error}</div>}

              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label>Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    disabled={status === 'loading'}
                    autoComplete="email"
                  />
                </div>

                <button type="submit" className="btn-primary" disabled={status === 'loading'}>
                  {status === 'loading' ? 'Sending…' : 'Send Reset Link'}
                </button>
              </form>

              <p className="switch-auth">
                Remembered your password?{' '}
                <button onClick={onBack} className="link-button">Back to Login</button>
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
