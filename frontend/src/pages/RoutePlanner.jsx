import { useState, useEffect } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function RoutePlanner({ airline, onBack }) {
  const [routes, setRoutes] = useState([]);
  const [airports, setAirports] = useState([]);
  const [fleet, setFleet] = useState([]);
  const [airlineCode, setAirlineCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Form state
  const [departureAirport, setDepartureAirport] = useState('');
  const [arrivalAirport, setArrivalAirport] = useState('');
  const [selectedAircraft, setSelectedAircraft] = useState('');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    const token = localStorage.getItem('token');
    try {
      const [routesRes, airportsRes, fleetRes] = await Promise.all([
        fetch(`${API_URL}/api/routes`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        fetch(`${API_URL}/api/airline/airports`),
        fetch(`${API_URL}/api/aircraft/fleet`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
      ]);

      const routesData = await routesRes.json();
      const airportsData = await airportsRes.json();
      const fleetData = await fleetRes.json();

      setRoutes(routesData.routes || []);
      setAirlineCode(routesData.airline_code || '');
      setAirports(airportsData.airports || []);
      setFleet(fleetData.fleet || []);
    } catch (err) {
      console.error('Failed to fetch data:', err);
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateRoute = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setCreating(true);

    const token = localStorage.getItem('token');

    try {
      const res = await fetch(`${API_URL}/api/routes/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          departure_airport: departureAirport,
          arrival_airport: arrivalAirport,
          aircraft_id: selectedAircraft ? parseInt(selectedAircraft) : null
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to create route');
      }

      setSuccess(`Route ${data.route.flight_number} created: ${departureAirport} - ${arrivalAirport}`);
      setDepartureAirport('');
      setArrivalAirport('');
      setSelectedAircraft('');

      // Refresh routes
      const routesRes = await fetch(`${API_URL}/api/routes`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const routesData = await routesRes.json();
      setRoutes(routesData.routes || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleAssignAircraft = async (routeId, aircraftId) => {
    const token = localStorage.getItem('token');
    setError('');

    try {
      const res = await fetch(`${API_URL}/api/routes/${routeId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          aircraft_id: aircraftId ? parseInt(aircraftId) : null
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to update route');
      }

      // Refresh routes
      const routesRes = await fetch(`${API_URL}/api/routes`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const routesData = await routesRes.json();
      setRoutes(routesData.routes || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteRoute = async (routeId) => {
    if (!confirm('Are you sure you want to delete this route?')) {
      return;
    }

    const token = localStorage.getItem('token');
    setError('');

    try {
      const res = await fetch(`${API_URL}/api/routes/${routeId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to delete route');
      }

      setSuccess('Route deleted successfully');

      // Refresh routes
      const routesRes = await fetch(`${API_URL}/api/routes`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const routesData = await routesRes.json();
      setRoutes(routesData.routes || []);
    } catch (err) {
      setError(err.message);
    }
  };

  // Group airports by country
  const airportsByCountry = airports.reduce((acc, airport) => {
    if (!acc[airport.country]) {
      acc[airport.country] = [];
    }
    acc[airport.country].push(airport);
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="app">
        <div className="container">
          <div className="header">
            <h1>Aviation Empire</h1>
            <p className="subtitle">Loading routes...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="container">
        <div className="header">
          <h1>Aviation Empire</h1>
          <p className="subtitle">{airline.name} - Route Planning</p>
        </div>

        <button onClick={onBack} className="btn-secondary" style={{ marginBottom: '1rem' }}>
          Back to Dashboard
        </button>

        {error && <div className="error-message" style={{ marginBottom: '1rem' }}>{error}</div>}
        {success && <div className="success-message" style={{ marginBottom: '1rem', color: 'green', padding: '0.5rem', background: '#e8f5e9', borderRadius: '4px' }}>{success}</div>}

        {/* Create Route Form */}
        <div className="info-card" style={{ marginBottom: '1.5rem' }}>
          <h3>Create New Route</h3>
          <form onSubmit={handleCreateRoute} style={{ display: 'grid', gap: '1rem', marginTop: '1rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                  Departure Airport
                </label>
                <select
                  value={departureAirport}
                  onChange={(e) => setDepartureAirport(e.target.value)}
                  required
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid #ccc' }}
                >
                  <option value="">Select departure...</option>
                  {Object.entries(airportsByCountry).map(([country, countryAirports]) => (
                    <optgroup key={country} label={country}>
                      {countryAirports.map(airport => (
                        <option key={airport.iata_code} value={airport.iata_code}>
                          {airport.iata_code} - {airport.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                  Arrival Airport
                </label>
                <select
                  value={arrivalAirport}
                  onChange={(e) => setArrivalAirport(e.target.value)}
                  required
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid #ccc' }}
                >
                  <option value="">Select arrival...</option>
                  {Object.entries(airportsByCountry).map(([country, countryAirports]) => (
                    <optgroup key={country} label={country}>
                      {countryAirports.map(airport => (
                        <option
                          key={airport.iata_code}
                          value={airport.iata_code}
                          disabled={airport.iata_code === departureAirport}
                        >
                          {airport.iata_code} - {airport.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                Assign Aircraft (Optional)
              </label>
              <select
                value={selectedAircraft}
                onChange={(e) => setSelectedAircraft(e.target.value)}
                style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid #ccc' }}
              >
                <option value="">No aircraft assigned</option>
                {fleet.map(aircraft => (
                  <option key={aircraft.id} value={aircraft.id}>
                    {aircraft.registration} - {aircraft.full_name} ({aircraft.range_km.toLocaleString()} km range)
                  </option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              disabled={creating || !departureAirport || !arrivalAirport}
              className="btn-primary"
              style={{ padding: '0.75rem' }}
            >
              {creating ? 'Creating...' : 'Create Route'}
            </button>
          </form>
        </div>

        {/* Existing Routes */}
        <div className="info-card">
          <h3>Your Routes ({routes.length})</h3>
          {routes.length === 0 ? (
            <p style={{ color: '#666', marginTop: '1rem' }}>No routes yet. Create your first route above!</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.75rem', marginTop: '1rem' }}>
              {routes.map(route => (
                <div key={route.id} style={{
                  padding: '1rem',
                  background: '#fff',
                  borderRadius: '8px',
                  border: '1px solid #ddd'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <strong style={{ fontSize: '1.1rem', color: '#1976d2' }}>
                          {route.flight_number}
                        </strong>
                        <span style={{ fontSize: '1.1rem' }}>
                          {route.departure_airport} → {route.arrival_airport}
                        </span>
                      </div>
                      <div style={{ color: '#666', fontSize: '0.9rem' }}>
                        {route.departure_name} → {route.arrival_name}
                      </div>
                      {route.distance_km && (
                        <div style={{ color: '#888', fontSize: '0.85rem', marginTop: '0.25rem' }}>
                          Distance: {route.distance_km.toLocaleString()} km
                        </div>
                      )}
                      <div style={{ marginTop: '0.75rem' }}>
                        <label style={{ fontSize: '0.85rem', color: '#666' }}>Aircraft: </label>
                        <select
                          value={route.aircraft_id || ''}
                          onChange={(e) => handleAssignAircraft(route.id, e.target.value)}
                          style={{
                            padding: '0.25rem 0.5rem',
                            borderRadius: '4px',
                            border: '1px solid #ccc',
                            fontSize: '0.9rem'
                          }}
                        >
                          <option value="">Not assigned</option>
                          {fleet.map(aircraft => (
                            <option key={aircraft.id} value={aircraft.id}>
                              {aircraft.registration} - {aircraft.full_name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDeleteRoute(route.id)}
                      style={{
                        padding: '0.5rem 0.75rem',
                        background: '#f44336',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '0.85rem'
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default RoutePlanner;
