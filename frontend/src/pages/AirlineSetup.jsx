import { useState, useEffect } from 'react';

const API_URL = import.meta.env.VITE_API_URL || '';

function AirlineSetup({ onAirlineCreated }) {
  const [name, setName] = useState('');
  const [airlineCode, setAirlineCode] = useState('');
  const [selectedCountry, setSelectedCountry] = useState('');
  const [homeAirport, setHomeAirport] = useState('');
  const [airports, setAirports] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchAirports();
  }, []);

  const fetchAirports = async () => {
    try {
      const res = await fetch(`${API_URL}/api/airline/airports`);
      const data = await res.json();
      setAirports(data.airports || []);
    } catch (err) {
      console.error('Failed to fetch airports:', err);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const token = localStorage.getItem('token');

    try {
      const res = await fetch(`${API_URL}/api/airline`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          name,
          airline_code: airlineCode.toUpperCase(),
          home_airport_code: homeAirport
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || data.errors?.[0]?.msg || 'Failed to create airline');
      }

      onAirlineCreated(data.airline);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCodeChange = (e) => {
    const value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
    setAirlineCode(value);
  };

  const countries = [...new Set(airports.map(a => a.country))].sort();
  const airportsInCountry = airports.filter(a => a.country === selectedCountry);

  return (
    <div className="app">
      <div className="container">
        <div className="header">
          <img src="/logo/logo_black.png" alt="Apron Empire" className="brand-logo" />
          <p className="subtitle">Create Your Airline</p>
        </div>

        <div className="auth-card">
          <h2>Airline Setup</h2>
          <p style={{ marginBottom: '1.5rem', color: '#666' }}>
            Set up your airline to start your Apron Empire!
          </p>

          {error && <div className="error-message">{error}</div>}

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="name">Airline Name</label>
              <input
                type="text"
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Sky Express Airways"
                minLength={3}
                maxLength={50}
                required
              />
              <small style={{ color: '#888' }}>3-50 characters</small>
            </div>

            <div className="form-group">
              <label htmlFor="code">IATA Code</label>
              <input
                type="text"
                id="code"
                value={airlineCode}
                onChange={handleCodeChange}
                placeholder="e.g., SE"
                style={{ textTransform: 'uppercase' }}
                required
              />
              <small style={{ color: '#888' }}>2-3 uppercase letters (your unique airline identifier)</small>
            </div>

            <div className="form-group">
              <label htmlFor="country">Country</label>
              <select
                id="country"
                value={selectedCountry}
                onChange={(e) => { setSelectedCountry(e.target.value); setHomeAirport(''); }}
                required
              >
                <option value="">Select country…</option>
                {countries.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="airport">Home Airport</label>
              <select
                id="airport"
                value={homeAirport}
                onChange={(e) => setHomeAirport(e.target.value)}
                disabled={!selectedCountry}
                required
              >
                <option value="">{selectedCountry ? 'Select airport…' : 'Select a country first'}</option>
                {airportsInCountry.map(airport => (
                  <option key={airport.iata_code} value={airport.iata_code}>
                    {airport.name} ({airport.iata_code})
                  </option>
                ))}
              </select>
            </div>

            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Creating...' : 'Create Airline'}
            </button>
          </form>

          <div className="info-card" style={{ marginTop: '1.5rem' }}>
            <h3>Starting Benefits</h3>
            <ul style={{ textAlign: 'left', paddingLeft: '1.5rem' }}>
              <li>$50,000,000 starting capital</li>
              <li>Access to regional aircraft</li>
              <li>Your home airport as hub</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AirlineSetup;
