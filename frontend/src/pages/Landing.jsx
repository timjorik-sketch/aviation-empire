import { useState } from 'react';
import axios from 'axios';
import './Auth.css';
import './Landing.css';

const GALLERY = [
  { src: '/images/Apronempire_1.png', alt: 'Apron Empire — Live Flight Tracking Map' },
  { src: '/images/Apronempire_2.png', alt: 'Apron Empire — Fleet Management Overview' },
  { src: '/images/Apronempire_3.png', alt: 'Apron Empire — Service Profile Configuration' },
  { src: '/images/Apronempire_4.png', alt: 'Apron Empire — Route Planning Interface' },
  { src: '/images/Apronempire_5.png', alt: 'Apron Empire — Airline Dashboard Statistics' },
  { src: '/images/Apronempire_6.png', alt: 'Apron Empire — Aircraft Purchase Marketplace' },
];

const FEATURES = [
  {
    icon: '✈️',
    title: 'Build Your Fleet',
    text: 'Start with a single aircraft and grow into a global carrier. Choose from 60+ real-world aircraft — from regional turboprops like the ATR 72 to wide-body giants like the Boeing 747-8 and Airbus A380.',
  },
  {
    icon: '🗺️',
    title: 'Plan Strategic Routes',
    text: 'Connect 2,200+ real airports worldwide. Analyze market demand, set competitive prices, and discover the most profitable routes across short-haul, medium-haul, and intercontinental flights.',
  },
  {
    icon: '👨‍✈️',
    title: 'Manage Your Operations',
    text: 'Hire pilots and cabin crew. Configure cabin layouts. Design service profiles for Economy, Business, and First Class. Every decision impacts passenger satisfaction — and your bottom line.',
  },
  {
    icon: '📊',
    title: 'Real-Time Economics',
    text: 'Dynamic market prices. Realistic fuel costs. Landing fees based on actual airport categories. Experience the challenges of running a profitable airline in a living, competitive world.',
  },
  {
    icon: '🌍',
    title: 'Compete Globally',
    text: 'Play against aviation enthusiasts from around the world. Climb the leaderboards. Form alliances. Dominate the skies.',
  },
  {
    icon: '🎮',
    title: 'Play Anywhere, Anytime',
    text: 'No download required. Apron Empire runs in your browser on desktop, tablet, and mobile. Your airline is always just a click away.',
  },
];

export default function Landing({ onLogin, onSwitchToRegister, onForgotPassword }) {
  const [formData, setFormData] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const response = await axios.post(
        `${import.meta.env.VITE_API_URL || ''}/api/auth/login`,
        formData
      );
      localStorage.setItem('token', response.data.token);
      localStorage.setItem('user', JSON.stringify(response.data.user));
      onLogin(response.data.user);
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const scrollToTop = () => {
    const el = document.querySelector('.landing-auth');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="landing-root">
      {/* ── LEFT: Marketing ──────────────────────────────────────────────── */}
      <main className="landing-marketing">
        <section className="landing-hero">
          <span className="landing-eyebrow">Airline Management Simulation</span>
          <h1 className="landing-h1">Build Your Airline Empire</h1>
          <p className="landing-sub">
            Take control of your own airline. Buy aircraft, plan routes, manage crews,
            and compete with players worldwide in this realistic browser-based simulation.
          </p>
        </section>

        <section className="landing-gallery" aria-label="Game screenshots">
          {GALLERY.map(shot => (
            <a
              key={shot.src}
              href={shot.src}
              target="_blank"
              rel="noopener noreferrer"
              className="landing-gallery-item"
            >
              <img src={shot.src} alt={shot.alt} loading="lazy" />
            </a>
          ))}
        </section>

        <section className="landing-features">
          {FEATURES.slice(0, 3).map(f => (
            <article key={f.title} className="landing-feature">
              <div className="landing-feature-icon" aria-hidden="true">{f.icon}</div>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </article>
          ))}
        </section>

        <section className="landing-features">
          {FEATURES.slice(3, 6).map(f => (
            <article key={f.title} className="landing-feature">
              <div className="landing-feature-icon" aria-hidden="true">{f.icon}</div>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </article>
          ))}
        </section>

        <section className="landing-cta">
          <h2>Ready for Takeoff?</h2>
          <p>
            Join thousands of players building their aviation empires.
            Create your free account and start flying today.
          </p>
          <button className="landing-cta-btn" onClick={scrollToTop}>
            Create Free Account
          </button>
        </section>

        <p className="landing-footer">© Apron Empire — Free to play, no download required.</p>
      </main>

      {/* ── RIGHT: Login ─────────────────────────────────────────────────── */}
      <aside className="landing-auth">
        <div className="landing-auth-card">
          <div className="landing-auth-logo">Apron Empire</div>
          <h2 className="landing-auth-title">Welcome Back</h2>
          <p className="landing-auth-subtitle">Log in to continue your airline</p>

          {error && <div className="error-message">{error}</div>}

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Username or Email</label>
              <input
                type="text"
                name="username"
                value={formData.username}
                onChange={handleChange}
                required
                disabled={loading}
                autoComplete="username"
              />
            </div>

            <div className="form-group">
              <label>Password</label>
              <input
                type="password"
                name="password"
                value={formData.password}
                onChange={handleChange}
                required
                disabled={loading}
                autoComplete="current-password"
              />
            </div>

            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Logging in…' : 'Log In'}
            </button>
          </form>

          <button
            type="button"
            onClick={onForgotPassword}
            className="landing-forgot"
          >
            Forgot password?
          </button>

          <p className="switch-auth">
            Don't have an account?{' '}
            <button onClick={onSwitchToRegister} className="link-button">
              Create one
            </button>
          </p>
        </div>
      </aside>
    </div>
  );
}
