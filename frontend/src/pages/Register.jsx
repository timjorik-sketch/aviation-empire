import { useState } from 'react';
import axios from 'axios';
import './Auth.css';

function Register({ onRegister, onSwitchToLogin }) {
  const [formData, setFormData] = useState({
    email: '',
    username: '',
    password: '',
    confirmPassword: '',
    inviteCode: ''
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (formData.password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);

    try {
      const response = await axios.post(
        `${import.meta.env.VITE_API_URL || ''}/api/auth/register`,
        {
          email: formData.email,
          username: formData.username,
          password: formData.password,
          invite_code: formData.inviteCode.trim().toUpperCase()
        }
      );

      localStorage.setItem('token', response.data.token);
      localStorage.setItem('user', JSON.stringify(response.data.user));

      onRegister(response.data.user);
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div
        className="page-hero"
        style={{ backgroundImage: "linear-gradient(rgba(0,0,0,0.4),rgba(0,0,0,0.6)),url('/header-images/Headerimage_Home.png')" }}
      >
        <div className="page-hero-overlay page-hero-overlay--centered">
          <img src="/logo/logo_white.png" alt="Apron Empire" className="page-hero-logo" />
        </div>
      </div>
      <div className="auth-container">
        <div className="auth-card">
          <h2>Join Apron Empire</h2>
        
        {error && <div className="error-message">{error}</div>}
        
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              required
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label>Username (3-20 characters)</label>
            <input
              type="text"
              name="username"
              value={formData.username}
              onChange={handleChange}
              minLength={3}
              maxLength={20}
              required
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label>Password (min 6 characters)</label>
            <input
              type="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              minLength={6}
              required
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label>Confirm Password</label>
            <input
              type="password"
              name="confirmPassword"
              value={formData.confirmPassword}
              onChange={handleChange}
              required
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label>Invite Code</label>
            <input
              type="text"
              name="inviteCode"
              value={formData.inviteCode}
              onChange={handleChange}
              required
              disabled={loading}
              placeholder="e.g. A3F9K2XP"
              autoCapitalize="characters"
              style={{ letterSpacing: '0.05em', textTransform: 'uppercase' }}
            />
          </div>

          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Creating Account...' : 'Register'}
          </button>
        </form>

          <p className="switch-auth">
            Already have an account?{' '}
            <button onClick={onSwitchToLogin} className="link-button">
              Login here
            </button>
          </p>
        </div>
      </div>
    </>
  );
}

export default Register;