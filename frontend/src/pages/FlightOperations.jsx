import { useState, useEffect } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function FlightOperations({ airline, onBalanceUpdate, onBack }) {
  const [flights, setFlights] = useState([]);
  const [availableRoutes, setAvailableRoutes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scheduling, setScheduling] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Form state
  const [selectedRoute, setSelectedRoute] = useState('');
  const [ticketPrice, setTicketPrice] = useState('');

  useEffect(() => {
    fetchData();
    // Auto-refresh flights every 10 seconds to see status updates
    const interval = setInterval(fetchFlights, 10000);
    return () => clearInterval(interval);
  }, []);

  const fetchData = async () => {
    const token = localStorage.getItem('token');
    try {
      const [flightsRes, routesRes] = await Promise.all([
        fetch(`${API_URL}/api/flights`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        fetch(`${API_URL}/api/flights/available-routes`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
      ]);

      const flightsData = await flightsRes.json();
      const routesData = await routesRes.json();

      setFlights(flightsData.flights || []);
      setAvailableRoutes(routesData.routes || []);
    } catch (err) {
      console.error('Failed to fetch data:', err);
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const fetchFlights = async () => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/flights`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setFlights(data.flights || []);

      // Update balance if flights completed
      const airlineRes = await fetch(`${API_URL}/api/airline`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const airlineData = await airlineRes.json();
      if (airlineData.airline && airlineData.airline.balance !== airline.balance) {
        onBalanceUpdate(airlineData.airline.balance);
      }
    } catch (err) {
      console.error('Failed to refresh flights:', err);
    }
  };

  const handleScheduleFlight = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setScheduling(true);

    const token = localStorage.getItem('token');

    try {
      const res = await fetch(`${API_URL}/api/flights/schedule`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          route_id: parseInt(selectedRoute),
          ticket_price: parseFloat(ticketPrice)
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to schedule flight');
      }

      setSuccess(`Flight ${data.flight.flight_number} scheduled! ${data.flight.seats_sold}/${data.flight.total_seats} seats sold. Est. revenue: $${data.flight.estimated_revenue.toLocaleString()}`);
      setSelectedRoute('');
      setTicketPrice('');

      // Refresh flights
      await fetchFlights();
    } catch (err) {
      setError(err.message);
    } finally {
      setScheduling(false);
    }
  };

  const handleCancelFlight = async (flightId) => {
    if (!confirm('Are you sure you want to cancel this flight?')) {
      return;
    }

    const token = localStorage.getItem('token');
    setError('');

    try {
      const res = await fetch(`${API_URL}/api/flights/${flightId}/cancel`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to cancel flight');
      }

      setSuccess('Flight cancelled successfully');
      await fetchFlights();
    } catch (err) {
      setError(err.message);
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'scheduled': return '#2196f3';
      case 'boarding': return '#ff9800';
      case 'in-flight': return '#4caf50';
      case 'completed': return '#9e9e9e';
      case 'cancelled': return '#f44336';
      default: return '#666';
    }
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'scheduled': return '[ ]';
      case 'boarding': return '[B]';
      case 'in-flight': return '[>]';
      case 'completed': return '[+]';
      case 'cancelled': return '[X]';
      default: return '[-]';
    }
  };

  const formatTime = (isoString) => {
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (isoString) => {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const suggestPrice = (route) => {
    if (!route) return '';
    // Suggest price based on distance ($0.10-0.15 per km)
    const basePrice = route.distance_km * 0.12;
    return Math.round(basePrice);
  };

  const selectedRouteData = availableRoutes.find(r => r.id === parseInt(selectedRoute));

  // Separate flights by status
  const activeFlights = flights.filter(f => ['scheduled', 'boarding', 'in-flight'].includes(f.status));
  const completedFlights = flights.filter(f => f.status === 'completed').slice(0, 10);
  const cancelledFlights = flights.filter(f => f.status === 'cancelled').slice(0, 5);

  if (loading) {
    return (
      <div className="app">
        <div className="container">
          <div className="header">
            <h1>Aviation Empire</h1>
            <p className="subtitle">Loading flight operations...</p>
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
          <p className="subtitle">{airline.name} - Flight Operations</p>
        </div>

        <button onClick={onBack} className="btn-secondary" style={{ marginBottom: '1rem' }}>
          Back to Dashboard
        </button>

        <div className="balance-display" style={{ marginBottom: '1rem', padding: '1rem', background: '#f0f0f0', borderRadius: '8px' }}>
          <strong>Balance:</strong> ${airline.balance.toLocaleString()}
        </div>

        {error && <div className="error-message" style={{ marginBottom: '1rem' }}>{error}</div>}
        {success && <div className="success-message" style={{ marginBottom: '1rem', color: 'green', padding: '0.5rem', background: '#e8f5e9', borderRadius: '4px' }}>{success}</div>}

        {/* Schedule Flight Form */}
        <div className="info-card" style={{ marginBottom: '1.5rem' }}>
          <h3>Schedule New Flight</h3>
          {availableRoutes.length === 0 ? (
            <p style={{ color: '#666', marginTop: '1rem' }}>
              No routes available. Create routes and assign aircraft in Route Planning first.
            </p>
          ) : (
            <form onSubmit={handleScheduleFlight} style={{ display: 'grid', gap: '1rem', marginTop: '1rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                  Select Route
                </label>
                <select
                  value={selectedRoute}
                  onChange={(e) => {
                    setSelectedRoute(e.target.value);
                    const route = availableRoutes.find(r => r.id === parseInt(e.target.value));
                    if (route) {
                      setTicketPrice(suggestPrice(route).toString());
                    }
                  }}
                  required
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid #ccc' }}
                >
                  <option value="">Select a route...</option>
                  {availableRoutes.map(route => (
                    <option key={route.id} value={route.id}>
                      {route.flight_number}: {route.departure_airport} - {route.arrival_airport} ({route.distance_km.toLocaleString()} km) - {route.aircraft_registration}
                    </option>
                  ))}
                </select>
              </div>

              {selectedRouteData && (
                <div style={{ padding: '0.75rem', background: '#e3f2fd', borderRadius: '4px', fontSize: '0.9rem' }}>
                  <div><strong>Aircraft:</strong> {selectedRouteData.aircraft_type} ({selectedRouteData.aircraft_registration})</div>
                  <div><strong>Capacity:</strong> {selectedRouteData.max_seats} seats</div>
                  <div><strong>Flight Duration:</strong> ~{Math.floor(selectedRouteData.estimated_duration / 60)}h {selectedRouteData.estimated_duration % 60}m</div>
                  <div><strong>Suggested Price:</strong> ${suggestPrice(selectedRouteData)} (competitive)</div>
                </div>
              )}

              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                  Ticket Price ($)
                </label>
                <input
                  type="number"
                  value={ticketPrice}
                  onChange={(e) => setTicketPrice(e.target.value)}
                  min="1"
                  step="1"
                  required
                  placeholder="Enter ticket price"
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }}
                />
                <small style={{ color: '#666' }}>
                  Higher prices = fewer passengers. Lower prices = more passengers but less revenue per seat.
                </small>
              </div>

              <button
                type="submit"
                disabled={scheduling || !selectedRoute || !ticketPrice}
                className="btn-primary"
                style={{ padding: '0.75rem' }}
              >
                {scheduling ? 'Scheduling...' : 'Schedule Flight'}
              </button>
            </form>
          )}
        </div>

        {/* Active Flights */}
        <div className="info-card" style={{ marginBottom: '1.5rem' }}>
          <h3>Active Flights ({activeFlights.length})</h3>
          {activeFlights.length === 0 ? (
            <p style={{ color: '#666', marginTop: '1rem' }}>No active flights. Schedule a flight above!</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.75rem', marginTop: '1rem' }}>
              {activeFlights.map(flight => (
                <div key={flight.id} style={{
                  padding: '1rem',
                  background: '#fff',
                  borderRadius: '8px',
                  border: `2px solid ${getStatusColor(flight.status)}`,
                  borderLeft: `4px solid ${getStatusColor(flight.status)}`
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <span style={{ fontFamily: 'monospace', color: getStatusColor(flight.status) }}>
                          {getStatusIcon(flight.status)}
                        </span>
                        <strong style={{ fontSize: '1.1rem' }}>{flight.flight_number}</strong>
                        <span style={{
                          padding: '0.2rem 0.5rem',
                          background: getStatusColor(flight.status),
                          color: 'white',
                          borderRadius: '4px',
                          fontSize: '0.75rem',
                          textTransform: 'uppercase'
                        }}>
                          {flight.status}
                        </span>
                      </div>
                      <div style={{ fontSize: '1rem', marginBottom: '0.25rem' }}>
                        {flight.departure_airport} → {flight.arrival_airport}
                      </div>
                      <div style={{ color: '#666', fontSize: '0.85rem' }}>
                        {formatDate(flight.departure_time)} | Dep: {formatTime(flight.departure_time)} - Arr: {formatTime(flight.arrival_time)}
                      </div>
                      <div style={{ marginTop: '0.5rem', display: 'flex', gap: '1rem', fontSize: '0.9rem' }}>
                        <span><strong>Passengers:</strong> {flight.seats_sold}/{flight.total_seats}</span>
                        <span><strong>Price:</strong> ${flight.ticket_price}</span>
                        <span><strong>Est. Revenue:</strong> ${(flight.seats_sold * flight.ticket_price).toLocaleString()}</span>
                      </div>
                      <div style={{ color: '#888', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                        {flight.aircraft_registration} - {flight.aircraft_type}
                      </div>
                    </div>
                    {flight.status === 'scheduled' && (
                      <button
                        onClick={() => handleCancelFlight(flight.id)}
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
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Completed Flights */}
        {completedFlights.length > 0 && (
          <div className="info-card" style={{ marginBottom: '1.5rem' }}>
            <h3>Recent Completed Flights</h3>
            <div style={{ display: 'grid', gap: '0.5rem', marginTop: '1rem' }}>
              {completedFlights.map(flight => (
                <div key={flight.id} style={{
                  padding: '0.75rem',
                  background: '#f5f5f5',
                  borderRadius: '4px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}>
                  <div>
                    <strong>{flight.flight_number}</strong>: {flight.departure_airport} → {flight.arrival_airport}
                    <span style={{ color: '#666', marginLeft: '0.5rem', fontSize: '0.85rem' }}>
                      ({flight.seats_sold}/{flight.total_seats} pax)
                    </span>
                  </div>
                  <div style={{ color: '#4caf50', fontWeight: 'bold' }}>
                    +${flight.revenue.toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Cancelled Flights */}
        {cancelledFlights.length > 0 && (
          <div className="info-card">
            <h3>Cancelled Flights</h3>
            <div style={{ display: 'grid', gap: '0.5rem', marginTop: '1rem' }}>
              {cancelledFlights.map(flight => (
                <div key={flight.id} style={{
                  padding: '0.5rem 0.75rem',
                  background: '#ffebee',
                  borderRadius: '4px',
                  color: '#c62828',
                  fontSize: '0.9rem'
                }}>
                  {flight.flight_number}: {flight.departure_airport} → {flight.arrival_airport}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default FlightOperations;
