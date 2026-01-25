import { useState, useEffect } from 'react';
import Login from './pages/Login';
import Register from './pages/Register';
import AirlineSetup from './pages/AirlineSetup';
import FleetPage from './pages/FleetPage';
import RoutePlanner from './pages/RoutePlanner';
import FlightOperations from './pages/FlightOperations';
import Finances from './pages/Finances';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function App() {
  const [user, setUser] = useState(null);
  const [airline, setAirline] = useState(null);
  const [showRegister, setShowRegister] = useState(false);
  const [currentPage, setCurrentPage] = useState('dashboard');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check if user is already logged in
    const savedUser = localStorage.getItem('user');
    if (savedUser) {
      setUser(JSON.parse(savedUser));
      fetchAirline();
    } else {
      setLoading(false);
    }
  }, []);

  const fetchAirline = async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(`${API_URL}/api/airline`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      const data = await res.json();
      if (data.airline) {
        setAirline(data.airline);
      }
    } catch (err) {
      console.error('Failed to fetch airline:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (userData) => {
    setUser(userData);
    await fetchAirline();
  };

  const handleRegister = (userData) => {
    setUser(userData);
    setAirline(null); // New users don't have an airline
  };

  const handleAirlineCreated = (airlineData) => {
    setAirline(airlineData);
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
    setAirline(null);
    setCurrentPage('dashboard');
  };

  const handleBalanceUpdate = (newBalance) => {
    setAirline(prev => ({ ...prev, balance: newBalance }));
  };

  // Loading state
  if (loading) {
    return (
      <div className="app">
        <div className="container">
          <div className="header">
            <h1>Aviation Empire</h1>
            <p className="subtitle">Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  // If not logged in, show auth screens
  if (!user) {
    if (showRegister) {
      return (
        <Register
          onRegister={handleRegister}
          onSwitchToLogin={() => setShowRegister(false)}
        />
      );
    }
    return (
      <Login
        onLogin={handleLogin}
        onSwitchToRegister={() => setShowRegister(true)}
      />
    );
  }

  // If logged in but no airline, show airline setup
  if (!airline) {
    return <AirlineSetup onAirlineCreated={handleAirlineCreated} />;
  }

  // Fleet page
  if (currentPage === 'fleet') {
    return (
      <FleetPage
        airline={airline}
        onBalanceUpdate={handleBalanceUpdate}
        onBack={() => setCurrentPage('dashboard')}
      />
    );
  }

  // Route planner page
  if (currentPage === 'routes') {
    return (
      <RoutePlanner
        airline={airline}
        onBack={() => setCurrentPage('dashboard')}
      />
    );
  }

  // Flight operations page
  if (currentPage === 'flights') {
    return (
      <FlightOperations
        airline={airline}
        onBalanceUpdate={handleBalanceUpdate}
        onBack={() => setCurrentPage('dashboard')}
      />
    );
  }

  // Finances page
  if (currentPage === 'finances') {
    return (
      <Finances
        airline={airline}
        onBack={() => setCurrentPage('dashboard')}
      />
    );
  }

  // Dashboard
  return (
    <div className="app">
      <div className="container">
        <div className="header">
          <h1>Aviation Empire</h1>
          <p className="subtitle">{airline.name} ({airline.airline_code})</p>
        </div>

        <div className="welcome-card">
          <h2>Welcome, {user.username}!</h2>
          <p>Managing {airline.name}</p>
          <div style={{ marginTop: '1rem', fontSize: '1.2rem' }}>
            <strong>Balance:</strong> ${airline.balance.toLocaleString()}
          </div>
          <div style={{ marginTop: '0.5rem' }}>
            <strong>Home Airport:</strong> {airline.home_airport_code}
          </div>
          <button onClick={handleLogout} className="btn-logout" style={{ marginTop: '1rem' }}>
            Logout
          </button>
        </div>

        <div className="info-card">
          <h3>Manage Your Airline</h3>
          <div style={{ display: 'grid', gap: '0.5rem', marginTop: '1rem' }}>
            <button onClick={() => setCurrentPage('fleet')} className="btn-primary">
              Fleet Management
            </button>
            <button onClick={() => setCurrentPage('routes')} className="btn-primary">
              Route Planning
            </button>
            <button onClick={() => setCurrentPage('flights')} className="btn-primary">
              Flight Operations
            </button>
            <button onClick={() => setCurrentPage('finances')} className="btn-primary">
              Finances
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;