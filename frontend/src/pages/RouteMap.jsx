import { useState, useCallback } from 'react';
import TopBar from '../components/TopBar.jsx';
import RoutePreviewMap from '../components/RoutePreviewMap.jsx';

const API_URL = '';

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatFlightTime(km) {
  const h = Math.floor(km / 900);
  const m = Math.round(((km / 900) - h) * 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export default function RouteMap({ airline, onBack }) {
  const [origin, setOrigin]   = useState('');
  const [dest, setDest]       = useState('');
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);
  const [depCoords, setDepCoords] = useState(null); // { iata, name, lat, lng }
  const [arrCoords, setArrCoords] = useState(null);

  const info = (depCoords && arrCoords) ? (() => {
    const distKm = haversineKm(depCoords.lat, depCoords.lng, arrCoords.lat, arrCoords.lng);
    return { distKm: Math.round(distKm), flightTime: formatFlightTime(distKm) };
  })() : null;

  const handleShow = useCallback(async (e) => {
    e.preventDefault();
    setError('');
    const o = origin.trim().toUpperCase();
    const d = dest.trim().toUpperCase();
    if (!o || !d) { setError('Please enter both IATA codes.'); return; }
    if (o === d)  { setError('Origin and destination must be different.'); return; }

    setLoading(true);
    try {
      const [resO, resD] = await Promise.all([
        fetch(`${API_URL}/api/airports/${o}`),
        fetch(`${API_URL}/api/airports/${d}`),
      ]);
      const [rawO, rawD] = await Promise.all([resO.json(), resD.json()]);
      const aO = rawO.airport, aD = rawD.airport;

      if (!resO.ok || !aO || aO.latitude == null) { setError(`Airport "${o}" not found in database.`); return; }
      if (!resD.ok || !aD || aD.latitude == null) { setError(`Airport "${d}" not found in database.`); return; }

      setDepCoords({ iata: aO.iata_code, name: aO.name, lat: aO.latitude, lng: aO.longitude });
      setArrCoords({ iata: aD.iata_code, name: aD.name, lat: aD.latitude, lng: aD.longitude });
    } catch (err) {
      setError('Failed to load airport data.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [origin, dest]);

  return (
    <div className="app">
      <style>{`
        .rm-inputs { display:grid; grid-template-columns:1fr 1fr auto; gap:1rem; align-items:flex-end; margin-bottom:0.25rem; }
        .rm-field label { display:block; font-weight:600; font-size:0.85rem; color:#2C2C2C; margin-bottom:0.4rem; text-transform:uppercase; letter-spacing:0.05em; }
        .rm-field input { width:100%; padding:0.6rem 0.75rem; border:1px solid #E0E0E0; border-radius:6px; font-size:1rem; font-family:monospace; font-weight:700; text-transform:uppercase; letter-spacing:0.1em; box-sizing:border-box; }
        .rm-field input:focus { outline:none; border-color:#2C2C2C; }
        .rm-error { font-size:0.85rem; color:#dc2626; margin-top:0.5rem; min-height:1.2em; }
        .rm-info-strip { display:grid; grid-template-columns:repeat(3,1fr); border-top:1px solid #F0F0F0; }
        .rm-info-cell { padding:1.25rem 1.5rem; border-right:1px solid #F0F0F0; text-align:center; }
        .rm-info-cell:last-child { border-right:none; }
        .rm-info-value { font-size:1.5rem; font-weight:700; color:#1a6dc4; font-variant-numeric:tabular-nums; font-family:monospace; }
        .rm-info-label { font-size:0.75rem; color:#888; text-transform:uppercase; letter-spacing:0.08em; margin-top:0.2rem; }
        .rm-route-label { text-align:center; font-weight:700; font-family:monospace; font-size:0.95rem; color:#444; padding:0.6rem 1rem; border-bottom:1px solid #F0F0F0; }
        @media (max-width:640px) {
          .rm-inputs { grid-template-columns:1fr 1fr; }
          .rm-inputs .btn-primary { grid-column:1/-1; }
          .rm-info-strip { grid-template-columns:1fr; }
          .rm-info-cell { border-right:none; border-bottom:1px solid #F0F0F0; }
          .rm-info-cell:last-child { border-bottom:none; }
        }
      `}</style>

      <div className="page-hero" style={{
        backgroundImage: 'linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.7)), url("/header-images/Headerimage_Routes.png")',
        height: '180px',
      }}>
        <div className="page-hero-overlay">
          <h1 style={{ fontSize: '2rem' }}>Route Map</h1>
          <p style={{ fontSize: '1rem', opacity: 0.8 }}>Great circle routes between airports</p>
        </div>
      </div>

      <div className="container" style={{ paddingTop: '24px' }}>
        <TopBar onBack={onBack} balance={airline?.balance} backLabel="Dashboard" airline={airline} />

        <div className="info-card" style={{ marginBottom: '1.5rem' }}>
          <div className="card-header-bar">
            <span className="card-header-bar-title">Plot Route</span>
          </div>
          <form onSubmit={handleShow}>
            <div className="rm-inputs">
              <div className="rm-field">
                <label>Origin (IATA)</label>
                <input value={origin}
                  onChange={e => setOrigin(e.target.value.replace(/[^a-zA-Z]/g, '').slice(0, 3))}
                  placeholder="ZRH" maxLength={3} autoComplete="off" spellCheck={false} />
              </div>
              <div className="rm-field">
                <label>Destination (IATA)</label>
                <input value={dest}
                  onChange={e => setDest(e.target.value.replace(/[^a-zA-Z]/g, '').slice(0, 3))}
                  placeholder="JFK" maxLength={3} autoComplete="off" spellCheck={false} />
              </div>
              <button type="submit" className="btn-primary"
                style={{ padding: '0.6rem 1.5rem', whiteSpace: 'nowrap' }}
                disabled={loading || origin.length !== 3 || dest.length !== 3}>
                {loading ? 'Loading…' : 'Show Route'}
              </button>
            </div>
            {error && <div className="rm-error">{error}</div>}
          </form>
        </div>

        <div className="info-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="card-header-bar" style={{ margin: 0, borderRadius: '8px 8px 0 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="card-header-bar-title">
              {depCoords && arrCoords ? `${depCoords.iata} → ${arrCoords.iata}` : 'Map'}
            </span>
            {info && (
              <span style={{ fontWeight: 400, fontSize: '0.78rem', opacity: 0.85, letterSpacing: '0.04em' }}>
                {info.distKm.toLocaleString()} km · {info.flightTime}
              </span>
            )}
          </div>
          <RoutePreviewMap dep={depCoords} arr={arrCoords} />
        </div>
      </div>
    </div>
  );
}
