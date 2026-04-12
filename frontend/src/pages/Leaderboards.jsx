import { useState, useEffect } from 'react';
import TopBar from '../components/TopBar.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

const MAX_VISIBLE = 10;

const CATEGORIES = [
  { key: 'passengers',     label: 'Passengers',        valueKey: 'total_passengers' },
  { key: 'destinations',   label: 'Destinations',      valueKey: 'destination_count' },
  { key: 'fleet',          label: 'Fleet Size',        valueKey: 'fleet_size' },
  { key: 'weekly_flights', label: 'Flights per Week',  valueKey: 'weekly_flights' },
];

function LeaderboardTable({ rows, valueKey, myAirlineId }) {
  if (!rows || rows.length === 0) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: '#999', fontSize: '0.85rem' }}>No data yet.</div>;
  }

  const myIndex = rows.findIndex(r => r.airline_id === myAirlineId);
  const myOutsideTop = myIndex >= MAX_VISIBLE;

  // Show top N, plus the user's row if they're outside the top N
  const visibleRows = rows.slice(0, MAX_VISIBLE);

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
      <thead>
        <tr style={{ background: '#F5F5F5' }}>
          <th style={thStyle}>Rank</th>
          <th style={{ ...thStyle, textAlign: 'left' }}>Airline</th>
          <th style={{ ...thStyle, textAlign: 'right' }}>Score</th>
        </tr>
      </thead>
      <tbody>
        {visibleRows.map((row, i) => {
          const rank = i + 1;
          const isMe = row.airline_id === myAirlineId;
          return (
            <tr key={row.airline_id} style={{
              background: isMe ? 'rgba(44,44,44,0.06)' : i % 2 === 0 ? '#fff' : '#FAFAFA',
              fontWeight: isMe ? 600 : 400,
            }}>
              <td style={{ ...tdStyle, textAlign: 'center', width: '50px', fontWeight: 700, color: '#999', fontSize: '0.82rem' }}>
                #{rank}
              </td>
              <td style={{ ...tdStyle, color: '#2C2C2C' }}>
                {row.name}
                {isMe && <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#fff', background: '#2C2C2C', borderRadius: '3px', padding: '1px 5px', marginLeft: '6px', verticalAlign: 'middle' }}>YOU</span>}
              </td>
              <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: '#2C2C2C', fontVariantNumeric: 'tabular-nums' }}>
                {(row[valueKey] ?? 0).toLocaleString()}
              </td>
            </tr>
          );
        })}
        {myOutsideTop && (
          <>
            <tr><td colSpan={3} style={{ padding: '2px 0', textAlign: 'center', color: '#CCC', fontSize: '0.72rem', borderBottom: '1px solid #F2F2F2' }}>...</td></tr>
            <tr style={{ background: 'rgba(44,44,44,0.06)', fontWeight: 600 }}>
              <td style={{ ...tdStyle, textAlign: 'center', width: '50px', fontWeight: 700, color: '#999', fontSize: '0.82rem' }}>
                #{myIndex + 1}
              </td>
              <td style={{ ...tdStyle, color: '#2C2C2C' }}>
                {rows[myIndex].name}
                <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#fff', background: '#2C2C2C', borderRadius: '3px', padding: '1px 5px', marginLeft: '6px', verticalAlign: 'middle' }}>YOU</span>
              </td>
              <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: '#2C2C2C', fontVariantNumeric: 'tabular-nums' }}>
                {(rows[myIndex][valueKey] ?? 0).toLocaleString()}
              </td>
            </tr>
          </>
        )}
      </tbody>
    </table>
  );
}

const thStyle = {
  padding: '0.5rem 0.75rem',
  textAlign: 'center',
  fontWeight: 700,
  fontSize: '0.7rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: '#999',
  borderBottom: '1px solid #E8E8E8',
};

const tdStyle = {
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid #F2F2F2',
};

export default function Leaderboards({ airline, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchLeaderboards();
  }, []);

  const fetchLeaderboards = async () => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/leaderboards`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setData(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const getMyRank = (key) => {
    if (!data) return null;
    const rows = data[key] || [];
    const idx = rows.findIndex(r => r.airline_id === data.my_airline_id);
    return idx >= 0 ? idx + 1 : null;
  };

  if (loading) return (
    <div className="app">
      <div className="page-hero" style={{ backgroundImage: "linear-gradient(rgba(0,0,0,0.45),rgba(0,0,0,0.65)),url('/header-images/Headerimage_Leaderboards.png')" }}>
        <div className="page-hero-overlay"><h1>Leaderboards</h1></div>
      </div>
      <div className="container" style={{ paddingTop: 24 }}>
        <TopBar onBack={onBack} balance={airline.balance} airline={airline} />
        <p style={{ color: '#666', marginTop: '2rem' }}>Loading...</p>
      </div>
    </div>
  );

  return (
    <div className="app">
      <div className="page-hero" style={{ backgroundImage: "linear-gradient(rgba(0,0,0,0.45),rgba(0,0,0,0.65)),url('/header-images/Headerimage_Leaderboards.png')" }}>
        <div className="page-hero-overlay">
          <h1>Leaderboards</h1>
          <p>Airline Rankings</p>
        </div>
      </div>

      <div className="container" style={{ paddingTop: 24 }}>
        <TopBar onBack={onBack} balance={airline.balance} airline={airline} />
        {error && <div className="error-message" style={{ marginBottom: '1rem' }}>{error}</div>}

        {/* KPI cards */}
        <div style={{ display: 'flex', gap: '16px', marginBottom: '20px', flexWrap: 'wrap' }}>
          {CATEGORIES.map(cat => {
            const rank = getMyRank(cat.key);
            const rows = data?.[cat.key] || [];
            const myRow = rows.find(r => r.airline_id === data?.my_airline_id);
            const myVal = myRow ? (myRow[cat.valueKey] ?? 0) : 0;
            return (
              <div key={cat.key} style={{ background: '#fff', borderRadius: '8px', padding: '20px 24px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', flex: '1 1 0', minWidth: '160px' }}>
                <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#999', marginBottom: '6px' }}>{cat.label}</div>
                <div style={{ fontSize: '1.55rem', fontWeight: 700, color: '#2C2C2C', lineHeight: 1.1 }}>
                  {rank ? `#${rank}` : '--'}
                </div>
                <div style={{ marginTop: '6px', fontSize: '0.75rem', color: '#888' }}>
                  {myVal.toLocaleString()} {cat.label.toLowerCase()} — {rows.length} airline{rows.length !== 1 ? 's' : ''}
                </div>
              </div>
            );
          })}
        </div>

        {/* 2x2 Leaderboard grid */}
        <div className="lb-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
          {CATEGORIES.map(cat => (
            <div key={cat.key} className="info-card" style={{ marginBottom: 0 }}>
              <div className="card-header-bar">
                <span className="card-header-bar-title">{cat.label}</span>
                {(() => {
                  const rank = getMyRank(cat.key);
                  return rank ? (
                    <span style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.55)' }}>Your Rank: #{rank}</span>
                  ) : null;
                })()}
              </div>
              <LeaderboardTable rows={data?.[cat.key] || []} valueKey={cat.valueKey} myAirlineId={data?.my_airline_id} />
            </div>
          ))}
        </div>

        <style>{`
          @media (max-width: 900px) {
            .lb-grid { grid-template-columns: 1fr !important; }
          }
        `}</style>
      </div>
    </div>
  );
}
