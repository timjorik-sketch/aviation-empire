import { useState, useEffect } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Simple bar chart component
function BarChart({ data, valueKey, labelKey, title, color = '#1976d2', maxBars = 10 }) {
  if (!data || data.length === 0) {
    return <div style={{ color: '#666', padding: '1rem' }}>No data available</div>;
  }

  const displayData = data.slice(0, maxBars);
  const maxValue = Math.max(...displayData.map(d => d[valueKey]));

  return (
    <div>
      {title && <h4 style={{ marginBottom: '0.75rem', color: '#333' }}>{title}</h4>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {displayData.map((item, index) => (
          <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: '100px', fontSize: '0.8rem', color: '#666', textAlign: 'right', flexShrink: 0 }}>
              {item[labelKey]}
            </div>
            <div style={{ flex: 1, background: '#f0f0f0', borderRadius: '4px', height: '24px', overflow: 'hidden' }}>
              <div
                style={{
                  width: maxValue > 0 ? `${(item[valueKey] / maxValue) * 100}%` : '0%',
                  height: '100%',
                  background: color,
                  borderRadius: '4px',
                  transition: 'width 0.3s ease',
                  minWidth: item[valueKey] > 0 ? '2px' : '0'
                }}
              />
            </div>
            <div style={{ width: '80px', fontSize: '0.8rem', fontWeight: 'bold', flexShrink: 0 }}>
              ${item[valueKey].toLocaleString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Simple line chart component using SVG
function LineChart({ data, title, height = 200 }) {
  if (!data || data.length === 0) {
    return <div style={{ color: '#666', padding: '1rem' }}>No data available</div>;
  }

  const padding = { top: 20, right: 20, bottom: 40, left: 60 };
  const width = 100; // Percentage based
  const chartHeight = height - padding.top - padding.bottom;

  const revenues = data.map(d => d.revenue);
  const profits = data.map(d => d.profit);
  const allValues = [...revenues, ...profits];
  const minValue = Math.min(0, ...allValues);
  const maxValue = Math.max(...allValues);
  const valueRange = maxValue - minValue || 1;

  const getY = (value) => {
    return chartHeight - ((value - minValue) / valueRange) * chartHeight + padding.top;
  };

  const getX = (index) => {
    return padding.left + (index / (data.length - 1 || 1)) * (100 - padding.left - padding.right);
  };

  // Create path for revenue line
  const revenuePath = data.map((d, i) => {
    const x = getX(i);
    const y = getY(d.revenue);
    return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');

  // Create path for profit line
  const profitPath = data.map((d, i) => {
    const x = getX(i);
    const y = getY(d.profit);
    return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');

  // Zero line position
  const zeroY = getY(0);

  return (
    <div>
      {title && <h4 style={{ marginBottom: '0.5rem', color: '#333' }}>{title}</h4>}
      <svg viewBox={`0 0 100 ${height}`} style={{ width: '100%', height: `${height}px` }}>
        {/* Grid lines */}
        <line x1={padding.left} y1={padding.top} x2={padding.left} y2={height - padding.bottom} stroke="#e0e0e0" strokeWidth="0.5" />
        <line x1={padding.left} y1={height - padding.bottom} x2={100 - padding.right} y2={height - padding.bottom} stroke="#e0e0e0" strokeWidth="0.5" />

        {/* Zero line */}
        {minValue < 0 && (
          <line x1={padding.left} y1={zeroY} x2={100 - padding.right} y2={zeroY} stroke="#999" strokeWidth="0.5" strokeDasharray="2,2" />
        )}

        {/* Revenue line */}
        <path d={revenuePath} fill="none" stroke="#4caf50" strokeWidth="1.5" />

        {/* Profit line */}
        <path d={profitPath} fill="none" stroke="#2196f3" strokeWidth="1.5" />

        {/* Data points - Revenue */}
        {data.map((d, i) => (
          <circle key={`rev-${i}`} cx={getX(i)} cy={getY(d.revenue)} r="1.5" fill="#4caf50" />
        ))}

        {/* Data points - Profit */}
        {data.map((d, i) => (
          <circle key={`prof-${i}`} cx={getX(i)} cy={getY(d.profit)} r="1.5" fill="#2196f3" />
        ))}

        {/* Y-axis labels */}
        <text x={padding.left - 5} y={padding.top} fontSize="3" fill="#666" textAnchor="end" dominantBaseline="middle">
          ${(maxValue / 1000).toFixed(0)}k
        </text>
        <text x={padding.left - 5} y={height - padding.bottom} fontSize="3" fill="#666" textAnchor="end" dominantBaseline="middle">
          ${(minValue / 1000).toFixed(0)}k
        </text>

        {/* X-axis labels (first and last date) */}
        {data.length > 0 && (
          <>
            <text x={padding.left} y={height - padding.bottom + 10} fontSize="3" fill="#666" textAnchor="start">
              {data[0].date}
            </text>
            <text x={100 - padding.right} y={height - padding.bottom + 10} fontSize="3" fill="#666" textAnchor="end">
              {data[data.length - 1].date}
            </text>
          </>
        )}
      </svg>
      <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', marginTop: '0.5rem', fontSize: '0.8rem' }}>
        <span><span style={{ color: '#4caf50' }}>--</span> Revenue</span>
        <span><span style={{ color: '#2196f3' }}>--</span> Profit</span>
      </div>
    </div>
  );
}

// Donut chart component
function DonutChart({ data, title, size = 150 }) {
  if (!data || data.length === 0) {
    return <div style={{ color: '#666', padding: '1rem' }}>No data available</div>;
  }

  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (total === 0) {
    return <div style={{ color: '#666', padding: '1rem' }}>No data to display</div>;
  }

  const colors = ['#1976d2', '#4caf50', '#ff9800', '#9c27b0', '#f44336', '#00bcd4', '#8bc34a', '#ff5722'];
  const radius = 40;
  const innerRadius = 25;
  const center = 50;

  let currentAngle = -90; // Start from top

  const segments = data.map((item, index) => {
    const percentage = item.value / total;
    const angle = percentage * 360;
    const startAngle = currentAngle;
    const endAngle = currentAngle + angle;
    currentAngle = endAngle;

    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;

    const x1 = center + radius * Math.cos(startRad);
    const y1 = center + radius * Math.sin(startRad);
    const x2 = center + radius * Math.cos(endRad);
    const y2 = center + radius * Math.sin(endRad);

    const ix1 = center + innerRadius * Math.cos(startRad);
    const iy1 = center + innerRadius * Math.sin(startRad);
    const ix2 = center + innerRadius * Math.cos(endRad);
    const iy2 = center + innerRadius * Math.sin(endRad);

    const largeArc = angle > 180 ? 1 : 0;

    const path = `
      M ${x1} ${y1}
      A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}
      L ${ix2} ${iy2}
      A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix1} ${iy1}
      Z
    `;

    return { ...item, path, color: colors[index % colors.length], percentage };
  });

  return (
    <div>
      {title && <h4 style={{ marginBottom: '0.5rem', color: '#333' }}>{title}</h4>}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <svg viewBox="0 0 100 100" style={{ width: `${size}px`, height: `${size}px` }}>
          {segments.map((seg, i) => (
            <path key={i} d={seg.path} fill={seg.color} />
          ))}
          <text x={center} y={center} textAnchor="middle" dominantBaseline="middle" fontSize="8" fontWeight="bold">
            ${(total / 1000000).toFixed(1)}M
          </text>
        </svg>
        <div style={{ fontSize: '0.8rem' }}>
          {segments.map((seg, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
              <div style={{ width: '12px', height: '12px', borderRadius: '2px', background: seg.color }} />
              <span>{seg.label}: {(seg.percentage * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Finances({ airline, onBack }) {
  const [overview, setOverview] = useState(null);
  const [routeRevenue, setRouteRevenue] = useState([]);
  const [aircraftCosts, setAircraftCosts] = useState([]);
  const [profitHistory, setProfitHistory] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    const token = localStorage.getItem('token');
    try {
      const [overviewRes, routeRes, aircraftRes, historyRes, transRes] = await Promise.all([
        fetch(`${API_URL}/api/finances/overview`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        fetch(`${API_URL}/api/finances/revenue-by-route`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        fetch(`${API_URL}/api/finances/aircraft-costs`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        fetch(`${API_URL}/api/finances/profit-history`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        fetch(`${API_URL}/api/finances/transactions`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
      ]);

      const overviewData = await overviewRes.json();
      const routeData = await routeRes.json();
      const aircraftData = await aircraftRes.json();
      const historyData = await historyRes.json();
      const transData = await transRes.json();

      setOverview(overviewData);
      setRouteRevenue(routeData.routeRevenue || []);
      setAircraftCosts(aircraftData.aircraftCosts || []);
      setProfitHistory(historyData.profitHistory || []);
      setTransactions(transData.transactions || []);
    } catch (err) {
      console.error('Failed to fetch financial data:', err);
      setError('Failed to load financial data');
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (amount) => {
    if (Math.abs(amount) >= 1000000) {
      return `$${(amount / 1000000).toFixed(2)}M`;
    }
    return `$${amount.toLocaleString()}`;
  };

  if (loading) {
    return (
      <div className="app">
        <div className="container">
          <div className="header">
            <h1>Aviation Empire</h1>
            <p className="subtitle">Loading finances...</p>
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
          <p className="subtitle">{airline.name} - Financial Dashboard</p>
        </div>

        <button onClick={onBack} className="btn-secondary" style={{ marginBottom: '1rem' }}>
          Back to Dashboard
        </button>

        {error && <div className="error-message" style={{ marginBottom: '1rem' }}>{error}</div>}

        {/* Key Metrics */}
        {overview && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: '1rem',
            marginBottom: '1.5rem'
          }}>
            <div style={{
              padding: '1rem',
              background: 'linear-gradient(135deg, #1976d2, #1565c0)',
              borderRadius: '8px',
              color: 'white',
              textAlign: 'center'
            }}>
              <div style={{ fontSize: '0.85rem', opacity: 0.9 }}>Current Balance</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{formatCurrency(overview.balance)}</div>
            </div>

            <div style={{
              padding: '1rem',
              background: 'linear-gradient(135deg, #4caf50, #388e3c)',
              borderRadius: '8px',
              color: 'white',
              textAlign: 'center'
            }}>
              <div style={{ fontSize: '0.85rem', opacity: 0.9 }}>Total Revenue</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{formatCurrency(overview.totalRevenue)}</div>
            </div>

            <div style={{
              padding: '1rem',
              background: 'linear-gradient(135deg, #f44336, #d32f2f)',
              borderRadius: '8px',
              color: 'white',
              textAlign: 'center'
            }}>
              <div style={{ fontSize: '0.85rem', opacity: 0.9 }}>Aircraft Costs</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{formatCurrency(overview.totalAircraftCost)}</div>
            </div>

            <div style={{
              padding: '1rem',
              background: overview.netProfit >= 0
                ? 'linear-gradient(135deg, #8bc34a, #689f38)'
                : 'linear-gradient(135deg, #ff5722, #e64a19)',
              borderRadius: '8px',
              color: 'white',
              textAlign: 'center'
            }}>
              <div style={{ fontSize: '0.85rem', opacity: 0.9 }}>Net Profit/Loss</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>
                {overview.netProfit >= 0 ? '+' : ''}{formatCurrency(overview.netProfit)}
              </div>
            </div>
          </div>
        )}

        {/* Stats Row */}
        {overview && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
            gap: '0.75rem',
            marginBottom: '1.5rem',
            padding: '1rem',
            background: '#f5f5f5',
            borderRadius: '8px'
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#333' }}>{overview.totalFlights}</div>
              <div style={{ fontSize: '0.75rem', color: '#666' }}>Flights Completed</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#333' }}>{overview.totalPassengers.toLocaleString()}</div>
              <div style={{ fontSize: '0.75rem', color: '#666' }}>Total Passengers</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#333' }}>{overview.fleetSize}</div>
              <div style={{ fontSize: '0.75rem', color: '#666' }}>Aircraft Owned</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#333' }}>{routeRevenue.length}</div>
              <div style={{ fontSize: '0.75rem', color: '#666' }}>Active Routes</div>
            </div>
          </div>
        )}

        {/* Profit/Loss Over Time Chart */}
        <div className="info-card" style={{ marginBottom: '1.5rem' }}>
          <h3>Profit/Loss Over Time</h3>
          <div style={{ marginTop: '1rem' }}>
            {profitHistory.length > 0 ? (
              <LineChart data={profitHistory} height={200} />
            ) : (
              <p style={{ color: '#666' }}>Complete flights to see your profit history.</p>
            )}
          </div>
        </div>

        {/* Revenue by Route */}
        <div className="info-card" style={{ marginBottom: '1.5rem' }}>
          <h3>Revenue by Route</h3>
          <div style={{ marginTop: '1rem' }}>
            {routeRevenue.length > 0 ? (
              <>
                <BarChart
                  data={routeRevenue.map(r => ({
                    label: `${r.departure_airport}-${r.arrival_airport}`,
                    value: r.total_revenue
                  }))}
                  valueKey="value"
                  labelKey="label"
                  color="#4caf50"
                  maxBars={8}
                />
                <div style={{ marginTop: '1rem', overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                    <thead>
                      <tr style={{ background: '#f5f5f5' }}>
                        <th style={{ padding: '0.5rem', textAlign: 'left', borderBottom: '1px solid #ddd' }}>Route</th>
                        <th style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #ddd' }}>Flights</th>
                        <th style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #ddd' }}>Passengers</th>
                        <th style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #ddd' }}>Avg Price</th>
                        <th style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #ddd' }}>Load %</th>
                        <th style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #ddd' }}>Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {routeRevenue.slice(0, 10).map(route => (
                        <tr key={route.id}>
                          <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>
                            <strong>{route.flight_number}</strong>: {route.departure_airport} → {route.arrival_airport}
                          </td>
                          <td style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #eee' }}>{route.flight_count}</td>
                          <td style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #eee' }}>{route.total_passengers.toLocaleString()}</td>
                          <td style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #eee' }}>${route.avg_ticket_price}</td>
                          <td style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #eee' }}>
                            <span style={{ color: route.avg_load_factor >= 70 ? '#4caf50' : route.avg_load_factor >= 50 ? '#ff9800' : '#f44336' }}>
                              {route.avg_load_factor}%
                            </span>
                          </td>
                          <td style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #eee', fontWeight: 'bold', color: '#4caf50' }}>
                            ${route.total_revenue.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p style={{ color: '#666' }}>Create routes and complete flights to see revenue data.</p>
            )}
          </div>
        </div>

        {/* Aircraft Performance */}
        <div className="info-card" style={{ marginBottom: '1.5rem' }}>
          <h3>Aircraft Performance & ROI</h3>
          <div style={{ marginTop: '1rem' }}>
            {aircraftCosts.length > 0 ? (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ background: '#f5f5f5' }}>
                      <th style={{ padding: '0.5rem', textAlign: 'left', borderBottom: '1px solid #ddd' }}>Aircraft</th>
                      <th style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #ddd' }}>Purchase</th>
                      <th style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #ddd' }}>Flights</th>
                      <th style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #ddd' }}>Revenue</th>
                      <th style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #ddd' }}>ROI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aircraftCosts.map(aircraft => (
                      <tr key={aircraft.id}>
                        <td style={{ padding: '0.5rem', borderBottom: '1px solid #eee' }}>
                          <strong>{aircraft.registration}</strong>
                          <br />
                          <span style={{ fontSize: '0.8rem', color: '#666' }}>{aircraft.aircraft_type}</span>
                        </td>
                        <td style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #eee', color: '#f44336' }}>
                          {formatCurrency(aircraft.purchase_price)}
                        </td>
                        <td style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #eee' }}>{aircraft.flights_completed}</td>
                        <td style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #eee', color: '#4caf50' }}>
                          {formatCurrency(aircraft.total_revenue)}
                        </td>
                        <td style={{ padding: '0.5rem', textAlign: 'right', borderBottom: '1px solid #eee' }}>
                          <span style={{
                            padding: '0.2rem 0.5rem',
                            borderRadius: '4px',
                            background: aircraft.roi >= 100 ? '#4caf50' : aircraft.roi >= 50 ? '#ff9800' : '#f5f5f5',
                            color: aircraft.roi >= 50 ? 'white' : '#333',
                            fontWeight: 'bold'
                          }}>
                            {aircraft.roi}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={{ color: '#666' }}>Purchase aircraft to see performance data.</p>
            )}
          </div>
        </div>

        {/* Recent Transactions */}
        <div className="info-card">
          <h3>Recent Transactions</h3>
          <div style={{ marginTop: '1rem' }}>
            {transactions.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {transactions.slice(0, 15).map(trans => (
                  <div key={trans.id} style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.5rem 0.75rem',
                    background: trans.amount >= 0 ? '#e8f5e9' : '#ffebee',
                    borderRadius: '4px',
                    borderLeft: `3px solid ${trans.amount >= 0 ? '#4caf50' : '#f44336'}`
                  }}>
                    <div>
                      <div style={{ fontSize: '0.9rem' }}>
                        {trans.type === 'flight_revenue' ? 'Flight Revenue' : 'Aircraft Purchase'}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: '#666' }}>{trans.description}</div>
                    </div>
                    <div style={{
                      fontWeight: 'bold',
                      color: trans.amount >= 0 ? '#4caf50' : '#f44336'
                    }}>
                      {trans.amount >= 0 ? '+' : ''}{formatCurrency(trans.amount)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ color: '#666' }}>No transactions yet. Complete flights or purchase aircraft to see transaction history.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Finances;
