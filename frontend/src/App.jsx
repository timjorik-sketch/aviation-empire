import { useState, useEffect } from 'react';
import Login from './pages/Login';
import Register from './pages/Register';
import './App.css';

function App() {
  const [user, setUser] = useState(null);
  const [showRegister, setShowRegister] = useState(false);

  useEffect(() => {
    // Check if user is already logged in
    const savedUser = localStorage.getItem('user');
    if (savedUser) {
      setUser(JSON.parse(savedUser));
    }
  }, []);

  const handleLogin = (userData) => {
    setUser(userData);
  };

  const handleRegister = (userData) => {
    setUser(userData);
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  };

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

  // If logged in, show dashboard
  return (
    <div className="app">
      <div className="container">
        <div className="header">
          <h1>✈️ Aviation Empire</h1>
          <p className="subtitle">Multiplayer Airline Simulation</p>
        </div>

        <div className="welcome-card">
          <h2>Welcome, {user.username}! 🎉</h2>
          <p>You are successfully logged in!</p>
          <button onClick={handleLogout} className="btn-logout">
            Logout
          </button>
        </div>

        <div className="info-card">
          <h3>🎮 Next Steps</h3>
          <ul>
            <li>✈️ Create your first airline</li>
            <li>🛩️ Buy aircraft</li>
            <li>🗺️ Plan routes worldwide</li>
            <li>💰 Manage your finances</li>
            <li>🏆 Climb the leaderboard</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default App;