import { useState, useEffect } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function FleetPage({ airline, onBalanceUpdate, onBack }) {
  const [aircraftTypes, setAircraftTypes] = useState([]);
  const [fleet, setFleet] = useState([]);
  const [airlineLevel, setAirlineLevel] = useState(1);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    const token = localStorage.getItem('token');
    try {
      const [typesRes, fleetRes] = await Promise.all([
        fetch(`${API_URL}/api/aircraft/types`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        fetch(`${API_URL}/api/aircraft/fleet`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
      ]);

      const typesData = await typesRes.json();
      const fleetData = await fleetRes.json();

      setAircraftTypes(typesData.aircraft_types || []);
      setAirlineLevel(typesData.airline_level || 1);
      setFleet(fleetData.fleet || []);
    } catch (err) {
      console.error('Failed to fetch data:', err);
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handlePurchase = async (aircraftType) => {
    setError('');
    setSuccess('');
    setPurchasing(aircraftType.id);

    const token = localStorage.getItem('token');

    try {
      const res = await fetch(`${API_URL}/api/aircraft/purchase`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          aircraft_type_id: aircraftType.id
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to purchase aircraft');
      }

      setSuccess(`Purchased ${data.aircraft.full_name} (${data.aircraft.registration})`);
      onBalanceUpdate(data.new_balance);

      // Refresh fleet
      const fleetRes = await fetch(`${API_URL}/api/aircraft/fleet`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const fleetData = await fleetRes.json();
      setFleet(fleetData.fleet || []);

    } catch (err) {
      setError(err.message);
    } finally {
      setPurchasing(null);
    }
  };

  const formatPrice = (price) => {
    if (price >= 1000000) {
      return `$${(price / 1000000).toFixed(0)}M`;
    }
    return `$${price.toLocaleString()}`;
  };

  if (loading) {
    return (
      <div className="app">
        <div className="container">
          <div className="header">
            <h1>Aviation Empire</h1>
            <p className="subtitle">Loading fleet...</p>
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
          <p className="subtitle">{airline.name} - Fleet Management</p>
        </div>

        <button onClick={onBack} className="btn-secondary" style={{ marginBottom: '1rem' }}>
          Back to Dashboard
        </button>

        <div className="balance-display" style={{ marginBottom: '1rem', padding: '1rem', background: '#f0f0f0', borderRadius: '8px' }}>
          <strong>Balance:</strong> ${airline.balance.toLocaleString()} | <strong>Level:</strong> {airlineLevel}
        </div>

        {error && <div className="error-message" style={{ marginBottom: '1rem' }}>{error}</div>}
        {success && <div className="success-message" style={{ marginBottom: '1rem', color: 'green', padding: '0.5rem', background: '#e8f5e9', borderRadius: '4px' }}>{success}</div>}

        {/* Owned Fleet */}
        <div className="info-card" style={{ marginBottom: '1.5rem' }}>
          <h3>Your Fleet ({fleet.length} aircraft)</h3>
          {fleet.length === 0 ? (
            <p style={{ color: '#666' }}>No aircraft yet. Purchase your first aircraft below!</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {fleet.map(aircraft => (
                <div key={aircraft.id} style={{
                  padding: '0.75rem',
                  background: '#fff',
                  borderRadius: '4px',
                  border: '1px solid #ddd',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}>
                  <div>
                    <strong>{aircraft.registration}</strong>
                    {aircraft.name && <span> "{aircraft.name}"</span>}
                    <br />
                    <span style={{ color: '#666', fontSize: '0.9rem' }}>
                      {aircraft.full_name} | {aircraft.max_seats} seats | {aircraft.range_km.toLocaleString()} km range
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Available Aircraft */}
        <div className="info-card">
          <h3>Available Aircraft</h3>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {aircraftTypes.map(type => {
              const canAfford = airline.balance >= type.new_price;
              const canPurchase = type.can_purchase && canAfford;

              return (
                <div key={type.id} style={{
                  padding: '1rem',
                  background: type.can_purchase ? '#fff' : '#f5f5f5',
                  borderRadius: '8px',
                  border: `1px solid ${type.can_purchase ? '#ddd' : '#ccc'}`,
                  opacity: type.can_purchase ? 1 : 0.7
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <strong style={{ fontSize: '1.1rem' }}>{type.full_name}</strong>
                      {!type.can_purchase && (
                        <span style={{ marginLeft: '0.5rem', color: '#f57c00', fontSize: '0.8rem' }}>
                          (Requires Level {type.required_level})
                        </span>
                      )}
                      <div style={{ color: '#666', fontSize: '0.9rem', marginTop: '0.25rem' }}>
                        {type.max_seats} seats | {type.range_km.toLocaleString()} km range
                      </div>
                      <div style={{ marginTop: '0.5rem', fontWeight: 'bold', color: canAfford ? '#2e7d32' : '#c62828' }}>
                        {formatPrice(type.new_price)}
                      </div>
                    </div>
                    <button
                      onClick={() => handlePurchase(type)}
                      disabled={!canPurchase || purchasing === type.id}
                      className="btn-primary"
                      style={{
                        padding: '0.5rem 1rem',
                        opacity: canPurchase ? 1 : 0.5,
                        cursor: canPurchase ? 'pointer' : 'not-allowed'
                      }}
                    >
                      {purchasing === type.id ? 'Buying...' : 'Buy'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export default FleetPage;
