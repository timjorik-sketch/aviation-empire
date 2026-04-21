import { useState } from 'react';
import axios from 'axios';
import './Auth.css';

export default function ResetPassword({ token, onDone }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | done
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setStatus('loading');
    try {
      await axios.post(
        `${import.meta.env.VITE_API_URL || ''}/api/auth/reset-password`,
        { token, newPassword: password }
      );
      setStatus('done');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not reset password. The link may be expired.');
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
          <h1>Choose a New Password</h1>
        </div>
      </div>
      <div className="auth-container">
        <div className="auth-card">
          <h2>Set New Password</h2>

          {status === 'done' ? (
            <>
              <p style={{ color: '#2C2C2C', marginBottom: 20, lineHeight: 1.5 }}>
                Your password has been reset. You can now log in with your new password.
              </p>
              <button onClick={onDone} className="btn-primary">
                Go to Login
              </button>
            </>
          ) : (
            <>
              {error && <div className="error-message">{error}</div>}

              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label>New Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    minLength={6}
                    disabled={status === 'loading'}
                    autoComplete="new-password"
                  />
                </div>

                <div className="form-group">
                  <label>Confirm New Password</label>
                  <input
                    type="password"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    required
                    minLength={6}
                    disabled={status === 'loading'}
                    autoComplete="new-password"
                  />
                </div>

                <button type="submit" className="btn-primary" disabled={status === 'loading'}>
                  {status === 'loading' ? 'Saving…' : 'Reset Password'}
                </button>
              </form>

              <p className="switch-auth">
                <button onClick={onDone} className="link-button">Back to Login</button>
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
