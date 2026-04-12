import { useState, useEffect } from 'react';
import RoutePreviewMap from './RoutePreviewMap';

const API_URL = import.meta.env.VITE_API_URL || '';

export default function AirlineProfilePopup({ airlineCode, onClose }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!airlineCode) return;
    setLoading(true);
    setError(null);
    const token = localStorage.getItem('token');
    fetch(`${API_URL}/api/airline/public/${airlineCode}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(r => { if (!r.ok) throw new Error('Not found'); return r.json(); })
      .then(data => { setProfile(data.profile); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [airlineCode]);

  return (
    <div className="hp-popup-backdrop" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
      padding: '0.5rem'
    }} onClick={onClose}>
      <div className="hp-popup-card" style={{
        background: '#fff', borderRadius: 12, width: '100%', maxWidth: 580,
        maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)'
      }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{
          background: '#2C2C2C', color: '#fff', padding: '14px 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderRadius: '12px 12px 0 0', flexShrink: 0
        }}>
          <span style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            {loading ? 'Loading...' : profile ? profile.name : 'Airline Profile'}
          </span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
            fontSize: '1.3rem', cursor: 'pointer', lineHeight: 1
          }}>&times;</button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {loading && (
            <div style={{ padding: '3rem', textAlign: 'center', color: '#999', fontSize: '0.85rem' }}>Loading airline profile...</div>
          )}
          {error && (
            <div style={{ padding: '3rem', textAlign: 'center', color: '#dc2626', fontSize: '0.85rem' }}>Could not load airline profile.</div>
          )}
          {profile && (
            <>
              {/* Identity: Code + Name + Logo */}
              <div style={{ background: '#fff', borderBottom: '1px solid #F0F0F0' }}>
                <div className="hp-it-section-label">Airline</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 1.1rem' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: '1.5rem', fontWeight: 700, color: '#2C2C2C', letterSpacing: '0.05em', flexShrink: 0 }}>
                    {profile.airline_code}
                  </span>
                  <span style={{ fontSize: '1rem', fontWeight: 600, color: '#2C2C2C', lineHeight: 1.2 }}>
                    {profile.name}
                  </span>
                </div>
                {profile.logo_filename && (
                  <div style={{ borderTop: '1px solid #F0F0F0' }}>
                    <img
                      src={profile.logo_filename.startsWith('http') ? profile.logo_filename : `${API_URL}/airline-logos/${profile.logo_filename}`}
                      alt="logo"
                      style={{ display: 'block', width: '100%', height: 'auto', aspectRatio: '4/1', objectFit: 'contain' }}
                    />
                  </div>
                )}
              </div>

              {/* Passengers — total only */}
              <table className="hp-info-table">
                <tbody>
                  <tr className="hp-it-divider">
                    <td colSpan={2} className="hp-it-section-label">Passengers</td>
                  </tr>
                  <tr>
                    <td className="hp-it-label">Total</td>
                    <td className="hp-it-val">{(profile.total_passengers || 0).toLocaleString()}</td>
                  </tr>
                </tbody>
              </table>

              {/* Network */}
              <table className="hp-info-table">
                <tbody>
                  <tr className="hp-it-divider">
                    <td colSpan={2} className="hp-it-section-label">Network</td>
                  </tr>
                  <tr>
                    <td className="hp-it-label">Home Airport</td>
                    <td className="hp-it-val">
                      {profile.home_airport?.code}
                      {profile.home_airport?.name && <span style={{ color: '#888', marginLeft: 6, fontSize: '0.8rem' }}>{profile.home_airport.name}</span>}
                    </td>
                  </tr>
                  <tr>
                    <td className="hp-it-label">Hubs</td>
                    <td className="hp-it-val">
                      {profile.hubs.length === 0 ? '—' : profile.hubs.map(h => h.code).join(', ')}
                    </td>
                  </tr>
                  <tr className="hp-it-last">
                    <td className="hp-it-label">Destinations</td>
                    <td className="hp-it-val">
                      {profile.destinations_count} destination{profile.destinations_count !== 1 ? 's' : ''}
                    </td>
                  </tr>
                </tbody>
              </table>

              {/* Routes map */}
              <div style={{ borderTop: '1px solid #F0F0F0', overflow: 'hidden' }}>
                <div className="hp-it-section-label" style={{ padding: '6px 1.1rem' }}>Routes</div>
                <RoutePreviewMap
                  routes={profile.routes}
                  hubs={profile.hubs}
                  homeAirport={profile.home_airport}
                />
              </div>

              {/* Fleet */}
              <div style={{ borderTop: '1px solid #F0F0F0' }}>
                <div className="hp-it-section-label">Fleet ({profile.fleet_count})</div>
                {profile.fleet.length === 0 ? (
                  <div style={{ padding: '2rem 1.1rem', textAlign: 'center', color: '#AAA', fontSize: '0.85rem', fontStyle: 'italic' }}>
                    No aircraft in fleet
                  </div>
                ) : (
                  <table className="hp-fleet-table">
                    <tbody>
                      {profile.fleet.map((type, i) => (
                        <tr key={i} style={i > 0 && type.manufacturer !== profile.fleet[i - 1].manufacturer ? { borderTop: '2px solid #F0F0F0' } : {}}>
                          <td>
                            {type.image_filename && (
                              <img src={`/aircraft-images/${type.image_filename}`} className="hp-fleet-img" alt={type.full_name} />
                            )}
                          </td>
                          <td className="hp-fleet-name">{type.full_name}</td>
                          <td className="hp-fleet-count">{type.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
