import { useState, useEffect } from 'react';
import TopBar from '../components/TopBar.jsx';

const API_URL = '';

// ── helpers ─────────────────────────────────────────────────────────────────
const fmt = (n) => {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${n < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)     return `${n < 0 ? '-' : ''}$${Math.round(abs).toLocaleString()}`;
  return `${n < 0 ? '-' : ''}$${Math.round(abs).toLocaleString()}`;
};

function pctChange(curr, prev) {
  if (!prev) return null;
  return ((curr - prev) / Math.abs(prev) * 100);
}

function PctBadge({ curr, prev, inverse = false }) {
  const pct = pctChange(curr, prev);
  if (pct == null) return null;
  const positive = inverse ? pct < 0 : pct > 0;
  const color  = pct === 0 ? '#888' : positive ? '#16a34a' : '#dc2626';
  const bg     = pct === 0 ? 'rgba(0,0,0,0.06)' : positive ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)';
  const sign   = pct > 0 ? '+' : '';
  return (
    <span style={{ fontSize: '0.72rem', fontWeight: 700, color, background: bg, borderRadius: '4px', padding: '2px 6px', marginLeft: '6px' }}>
      {sign}{pct.toFixed(1)}%
    </span>
  );
}

// ── P&L Bar Chart (daily net profit) ─────────────────────────────────────────
function PLChart({ data }) {
  if (!data || data.length === 0) {
    return <div style={{ color: '#999', padding: '2rem', textAlign: 'center', fontSize: '0.85rem' }}>No data yet — complete flights to see your P&L history.</div>;
  }

  const DAYS_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

  const fmtDate = (s) => {
    const d = new Date(s);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Berlin' });
  };
  const fmtVal = (v) => {
    const abs = Math.abs(v), sign = v < 0 ? '-' : '+';
    if (abs >= 1_000_000) return `${sign}$${(abs/1_000_000).toFixed(2)}M`;
    if (abs >= 1_000)     return `${sign}$${Math.round(abs).toLocaleString()}`;
    return `${sign}$${Math.round(abs)}`;
  };

  return (
    <div style={{ padding: '8px 0' }}>
      {data.map((d, i) => {
        const profit = d.profit;
        const isPos = profit >= 0;
        const color = isPos ? '#16a34a' : '#dc2626';
        const bg    = isPos ? 'rgba(22,163,74,0.07)' : 'rgba(220,38,38,0.07)';
        const dayName = DAYS_DE[new Date(d.date).getDay()];
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '9px 16px',
            borderBottom: i < data.length - 1 ? '1px solid #F2F2F2' : 'none',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
              <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#2C2C2C', minWidth: '22px' }}>{dayName}</span>
              <span style={{ fontSize: '0.78rem', color: '#999' }}>{fmtDate(d.date)}</span>
            </div>
            <span style={{
              fontSize: '0.88rem', fontWeight: 700, color,
              background: bg, borderRadius: '5px', padding: '3px 10px',
            }}>
              {fmtVal(profit)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Fuel Price Chart ──────────────────────────────────────────────────────────
function FuelChart({ prices, currentPrice }) {
  const hasPrices = prices && prices.length > 0;

  const PAD = { top: 20, right: 20, bottom: 28, left: 58 };
  const H = 220;
  const W = 500;
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const priceColor = '#2C2C2C';

  // Parse SQLite UTC strings correctly
  const toUtc = (s) => new Date(s.includes('Z') || s.includes('+') ? s : s.replace(' ', 'T') + 'Z');

  // Fixed 72h window ending now
  const tMax = Date.now();
  const tMin = tMax - 72 * 60 * 60 * 1000;

  // X position by timestamp
  const xT = (ms) => PAD.left + ((ms - tMin) / (tMax - tMin)) * chartW;
  const xP = (p) => xT(toUtc(p.created_at).getTime());

  // Y axis
  const allVals = hasPrices ? prices.map(p => p.price_per_liter) : [currentPrice || 0.8];
  const dataMin = Math.min(...allVals);
  const dataMax = Math.max(...allVals);
  const pad = Math.max(0.05, (dataMax - dataMin) * 0.3);
  const minV = Math.max(0, Math.floor((dataMin - pad) * 10) / 10);
  const maxV = Math.ceil((dataMax + pad) * 10) / 10;
  const range = Math.max(0.01, maxV - minV);
  const y = (v) => PAD.top + chartH - ((v - minV) / range) * chartH;

  const yTickCount = 4;
  const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) => minV + (range / yTickCount) * i);

  // Midnight boundaries (Berlin) within the 72h window
  const midnights = (() => {
    const result = [];
    // Walk back from now finding each Berlin midnight
    for (let d = 0; d <= 3; d++) {
      const t = tMax - d * 24 * 60 * 60 * 1000;
      const berlinDate = new Date(t).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
      const [yr, mo, dy] = berlinDate.split('-').map(Number);
      // Midnight Berlin = find UTC ms for that Berlin date 00:00
      // Approximation: format as ISO and adjust by offset
      const approx = Date.UTC(yr, mo - 1, dy, 0, 0, 0);
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      });
      // Use the offset from a nearby known time
      const offsetMs = (() => {
        const probe = new Date(approx);
        const localStr = probe.toLocaleString('sv', { timeZone: 'Europe/Berlin' }); // "YYYY-MM-DD HH:MM:SS"
        const localDate = new Date(localStr.replace(' ', 'T') + 'Z');
        return probe.getTime() - localDate.getTime();
      })();
      const midnight = approx - offsetMs;
      if (midnight > tMin && midnight < tMax) result.push(midnight);
    }
    return [...new Set(result)].sort((a, b) => a - b);
  })();

  // Day bands between midnights
  const bandEdges = [tMin, ...midnights, tMax];
  const dayBands = bandEdges.slice(0, -1).map((start, i) => ({
    x1: xT(start), x2: xT(bandEdges[i + 1]), odd: i % 2 === 0,
  }));

  // X-axis labels: center of each band, day name
  const dayLabels = dayBands.map((b) => {
    const midMs = tMin + ((b.x1 - PAD.left + (b.x2 - b.x1) / 2) / chartW) * (tMax - tMin);
    const label = new Date(midMs).toLocaleDateString('de-DE', {
      timeZone: 'Europe/Berlin', weekday: 'short', day: 'numeric', month: 'numeric',
    });
    return { x: (b.x1 + b.x2) / 2, label };
  });

  // Line path
  const pathD = hasPrices
    ? prices.map((p, i) => `${i === 0 ? 'M' : 'L'}${xP(p).toFixed(1)},${y(p.price_per_liter).toFixed(1)}`).join(' ')
    : '';

  const lastPt = hasPrices ? prices[prices.length - 1] : null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px 4px' }}>
        <span style={{ fontSize: '2rem', fontWeight: 700, color: priceColor, lineHeight: 1 }}>
          ${currentPrice > 0 ? currentPrice.toFixed(2) : '—'}
        </span>
        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '0.06em' }}>per kg</div>
      </div>
      {hasPrices ? (
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
          {/* Day bands */}
          {dayBands.map((b, i) => b.odd ? (
            <rect key={i} x={b.x1} y={PAD.top} width={Math.max(0, b.x2 - b.x1)} height={chartH} fill="#F7F7F7" />
          ) : null)}
          {/* Midnight dividers */}
          {midnights.map((ms, i) => (
            <line key={i} x1={xT(ms)} x2={xT(ms)} y1={PAD.top} y2={PAD.top + chartH} stroke="#E0E0E0" strokeWidth="1" strokeDasharray="3,3" />
          ))}
          {/* Y grid + labels */}
          {yTicks.map((v, i) => (
            <g key={i}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="#EFEFEF" strokeWidth="1" />
              <text x={PAD.left - 6} y={y(v)} textAnchor="end" dominantBaseline="middle" fontSize="15" fill="#999">${v.toFixed(2)}</text>
            </g>
          ))}
          {/* X-axis day labels */}
          {dayLabels.map((dl, i) => (
            <text key={i} x={Math.max(PAD.left + 2, Math.min(W - PAD.right - 2, dl.x))} y={PAD.top + chartH + 16} textAnchor="middle" fontSize="11" fill="#AAA">{dl.label}</text>
          ))}
          {/* Price line */}
          <path d={pathD} fill="none" stroke={priceColor} strokeWidth="2" />
          {/* Dot per data point */}
          {prices.map((p, i) => (
            <circle key={i} cx={xP(p)} cy={y(p.price_per_liter)} r="3" fill="white" stroke={priceColor} strokeWidth="1.5" />
          ))}
          {/* Current price dot */}
          {lastPt && <circle cx={xP(lastPt)} cy={y(lastPt.price_per_liter)} r="5" fill={priceColor} />}
        </svg>
      ) : (
        <div style={{ textAlign: 'center', padding: '1.5rem', color: '#BBB', fontSize: '0.8rem' }}>
          No history yet — chart will populate over time.
        </div>
      )}
    </div>
  );
}

// ── Breakdown row ────────────────────────────────────────────────────────────
function BRow({ label, value, sub, bold, divider }) {
  if (divider) return <tr><td colSpan={2} style={{ borderTop: '1px solid #E0E0E0', padding: '4px 0' }} /></tr>;
  return (
    <tr>
      <td style={{ padding: '0.35rem 0', fontSize: bold ? '0.82rem' : '0.8rem', color: bold ? '#2C2C2C' : '#555', fontWeight: bold ? 700 : 400, borderTop: bold ? '1px solid #E8E8E8' : 'none' }}>
        {label}
        {sub && <span style={{ fontSize: '0.72rem', color: '#AAA', marginLeft: '4px' }}>{sub}</span>}
      </td>
      <td style={{ padding: '0.35rem 0', textAlign: 'right', fontSize: bold ? '0.82rem' : '0.8rem', fontWeight: bold ? 700 : 500, color: bold ? '#2C2C2C' : '#444', borderTop: bold ? '1px solid #E8E8E8' : 'none' }}>
        {value}
      </td>
    </tr>
  );
}

// ── Main component ───────────────────────────────────────────────────────────
export default function Finances({ airline, onBack, onNavigateToAirport }) {
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [fuelHistory, setFuelHistory] = useState({ prices: [], currentPrice: 0 });

  useEffect(() => {
    fetchDashboard();
    fetchFuelHistory();
  }, []);

  const fetchDashboard = async () => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/finances/dashboard`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setData(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchFuelHistory = async () => {
    try {
      const res = await fetch(`${API_URL}/api/finances/fuel-price-history`);
      const json = await res.json();
      if (res.ok) {
        // Convert stored price to $/kg for display (stored as $/kg already after migration)
        const prices = (json.prices || []).map(p => ({ ...p, price_per_kg: p.price_per_liter }));
        setFuelHistory({ prices, currentPrice: json.currentPrice });
      }
    } catch { /* ignore */ }
  };

  if (loading) return (
    <div className="app"><div className="page-hero" style={{ backgroundImage: "linear-gradient(rgba(0,0,0,0.4),rgba(0,0,0,0.6)),url('/header-images/Headerimage_Finance.png')" }}><div className="page-hero-overlay"><h1>Finances</h1></div></div><div className="container" style={{ paddingTop: 24 }}><TopBar onBack={onBack} balance={airline.balance} airline={airline} /><p style={{ color: '#666', marginTop: '2rem' }}>Loading…</p></div></div>
  );

  const w = data?.weekly || {};
  const cb = data?.cost_breakdown || {};
  const rb = data?.revenue_breakdown || {};
  const ops = data?.ops_stats || {};
  const txs = data?.transactions || [];

  // KPI card helper
  const KpiCard = ({ label, value, prev, inverse, note }) => (
    <div style={{ background: '#fff', borderRadius: '8px', padding: '20px 24px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', flex: '1 1 0' }}>
      <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#999', marginBottom: '6px' }}>{label}</div>
      <div style={{ fontSize: '1.55rem', fontWeight: 700, color: '#2C2C2C', lineHeight: 1.1 }}>{value}</div>
      <div style={{ marginTop: '6px', fontSize: '0.75rem', color: '#888', display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
        <span>vs last week</span>
        <PctBadge curr={typeof value === 'string' ? 0 : 0} prev={prev != null ? 1 : null} />
        {prev != null && (() => {
          const pct = pctChange(
            typeof w.revenue !== 'undefined' ? (label.includes('Revenue') ? w.revenue : label.includes('Cost') ? w.costs : label.includes('Profit') ? w.profit : data?.balance) : 0,
            prev
          );
          const positive = inverse ? (pct < 0) : (pct > 0);
          const color = pct == null ? '#888' : pct === 0 ? '#888' : positive ? '#16a34a' : '#dc2626';
          const bg = pct == null ? 'transparent' : pct === 0 ? 'rgba(0,0,0,0.06)' : positive ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)';
          const sign = pct > 0 ? '+' : '';
          return pct != null ? (
            <span style={{ fontSize: '0.72rem', fontWeight: 700, color, background: bg, borderRadius: '4px', padding: '2px 6px' }}>
              {sign}{pct.toFixed(1)}%
            </span>
          ) : null;
        })()}
        {note && <span style={{ marginLeft: 2 }}>{note}</span>}
      </div>
    </div>
  );

  const fuelLabelL = fuelHistory.currentPrice > 0 ? `at $${fuelHistory.currentPrice.toFixed(2)}/kg` : (cb.fuel_price_per_liter ? `at $${cb.fuel_price_per_liter.toFixed(2)}/kg` : '');

  return (
    <div className="app">
      {/* Hero */}
      <div className="page-hero" style={{ backgroundImage: "linear-gradient(rgba(0,0,0,0.4),rgba(0,0,0,0.6)),url('/header-images/Headerimage_Finance.png')" }}>
        <div className="page-hero-overlay">
          <h1>Finances</h1>
          <p>{airline.name}</p>
        </div>
      </div>

      <div className="container" style={{ paddingTop: 24 }}>
        <TopBar onBack={onBack} balance={airline.balance} airline={airline} />
        {error && <div className="error-message" style={{ marginBottom: '1rem' }}>{error}</div>}

        {/* ── 4 KPI Cards ── */}
        <div style={{ display: 'flex', gap: '16px', marginBottom: '20px', flexWrap: 'wrap' }}>
          {/* Balance */}
          <div style={{ background: '#fff', borderRadius: '8px', padding: '20px 24px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', flex: '1 1 0', minWidth: '160px' }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#999', marginBottom: '6px' }}>Current Balance</div>
            <div style={{ fontSize: '1.55rem', fontWeight: 700, color: '#2C2C2C', lineHeight: 1.1 }}>{fmt(data?.balance)}</div>
            {data?.balance_prev_week != null && (() => {
              const pct = pctChange(data.balance, data.balance_prev_week);
              const pos = pct >= 0;
              return (
                <div style={{ marginTop: '6px', fontSize: '0.75rem', color: '#888', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span>vs last week</span>
                  {pct != null && <span style={{ fontSize: '0.72rem', fontWeight: 700, color: pos ? '#16a34a' : '#dc2626', background: pos ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)', borderRadius: '4px', padding: '2px 6px' }}>{pct >= 0 ? '+' : ''}{pct.toFixed(1)}%</span>}
                </div>
              );
            })()}
          </div>

          {/* Weekly Revenue */}
          {[
            { label: 'Weekly Revenue', curr: w.revenue, prev: w.revenue_prev, inverse: false },
            { label: 'Weekly Costs',   curr: w.costs,   prev: w.costs_prev,   inverse: true },
            { label: 'Weekly Profit',  curr: w.profit,  prev: w.profit_prev,  inverse: false, isProfit: true },
          ].map(({ label, curr, prev, inverse, isProfit }) => {
            const pct = pctChange(curr, prev);
            const positive = inverse ? (pct < 0) : (pct > 0);
            const valColor = isProfit ? (curr >= 0 ? '#16a34a' : '#dc2626') : '#2C2C2C';
            return (
              <div key={label} style={{ background: '#fff', borderRadius: '8px', padding: '20px 24px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', flex: '1 1 0', minWidth: '160px' }}>
                <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#999', marginBottom: '6px' }}>{label}</div>
                <div style={{ fontSize: '1.55rem', fontWeight: 700, color: valColor, lineHeight: 1.1 }}>
                  {isProfit && curr > 0 ? '+' : ''}{fmt(curr)}
                </div>
                <div style={{ marginTop: '6px', fontSize: '0.75rem', color: '#888', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span>vs last week</span>
                  {pct != null && (() => {
                    const color = pct === 0 ? '#888' : positive ? '#16a34a' : '#dc2626';
                    const bg    = pct === 0 ? 'rgba(0,0,0,0.06)' : positive ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)';
                    return <span style={{ fontSize: '0.72rem', fontWeight: 700, color, background: bg, borderRadius: '4px', padding: '2px 6px' }}>{pct > 0 ? '+' : ''}{pct.toFixed(1)}%</span>;
                  })()}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── P&L Chart + Fuel Price ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px', alignItems: 'start' }}>
          <div className="info-card" style={{ marginBottom: 0 }}>
            <div className="card-header-bar">
              <span className="card-header-bar-title">Profit & Loss — Last 7 Days</span>
            </div>
            <PLChart data={data?.daily_history || []} />
          </div>

          <div className="info-card" style={{ marginBottom: 0 }}>
            <div className="card-header-bar">
              <span className="card-header-bar-title">Jet Fuel Price — Last 3 Days</span>
            </div>
            <FuelChart prices={fuelHistory.prices} currentPrice={fuelHistory.currentPrice} />
          </div>
        </div>

        {/* ── 3-column breakdown ── */}
        <div className="fn-3col" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '16px', marginBottom: '20px' }}>

          {/* Left — Revenue Breakdown */}
          <div className="info-card" style={{ marginBottom: 0 }}>
            <div className="card-header-bar">
              <span className="card-header-bar-title">Revenue — This Week</span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                <BRow label="Flight Tickets"  value={fmt(rb.tickets)} />
                <BRow label="Aircraft Sales"  value={fmt(rb.aircraft_sales)} />
                {rb.other > 0 && <BRow label="Other" value={fmt(rb.other)} />}
                <BRow label="Total Revenue" value={fmt(rb.total)} bold />
              </tbody>
            </table>
          </div>

          {/* Middle — Cost Breakdown */}
          <div className="info-card" style={{ marginBottom: 0 }}>
            <div className="card-header-bar">
              <span className="card-header-bar-title">Costs — This Week</span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                <BRow label="Fuel" value={fmt(cb.fuel)} sub={fuelLabelL} />
                <BRow label="ATC / Navigation" value={fmt(cb.atc)} />
                <BRow label="Airport Fees & Catering" value={fmt(cb.airport_fees_catering)} />
                <BRow label="Maintenance" value={fmt(cb.maintenance)} />
                <BRow label="Cancellation Penalties" value={fmt(cb.cancellations)} />
                <BRow label="Aircraft Purchases" value={fmt(cb.aircraft_purchases)} />
                {cb.other > 0 && <BRow label="Other" value={fmt(cb.other)} />}
                <BRow label="Total Costs" value={fmt(cb.total)} bold />
              </tbody>
            </table>
          </div>

          {/* Right — Operations Stats */}
          <div className="info-card" style={{ marginBottom: 0 }}>
            <div className="card-header-bar">
              <span className="card-header-bar-title">Operations — This Week</span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                <BRow label="Flights Completed"   value={(ops.flights_completed ?? 0).toLocaleString()} />
                <BRow label="Total Passengers"    value={(ops.total_passengers ?? 0).toLocaleString()} />
                <BRow label="Avg Load Factor"     value={`${ops.avg_load_factor ?? 0}%`} />
                <BRow divider />
                <BRow label="Active Aircraft"  value={(ops.active_aircraft ?? 0).toLocaleString()} />
                <BRow label="Active Routes"    value={(ops.active_routes ?? 0).toLocaleString()} />
                <BRow label="Destinations"     value={(ops.destinations ?? 0).toLocaleString()} />
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Transactions Table ── */}
        <div className="info-card" style={{ marginBottom: '20px' }}>
          <div className="card-header-bar">
            <span className="card-header-bar-title">Recent Transactions</span>
            <span style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.55)' }}>Last 50</span>
          </div>
          {txs.length === 0 ? (
            <p style={{ color: '#999', fontSize: '0.85rem' }}>No transactions yet.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                <thead>
                  <tr style={{ background: '#F5F5F5' }}>
                    <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#999', borderBottom: '1px solid #E8E8E8' }}>Date / Time</th>
                    <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#999', borderBottom: '1px solid #E8E8E8' }}>Description</th>
                    <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#999', borderBottom: '1px solid #E8E8E8' }}>Amount</th>
                    <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#999', borderBottom: '1px solid #E8E8E8' }}>Balance After</th>
                  </tr>
                </thead>
                <tbody>
                  {txs.map((tx, i) => {
                    const isCredit = tx.amount > 0;
                    const dt = new Date(tx.created_at);
                    const dateStr = dt.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
                    const timeStr = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
                    return (
                      <tr key={tx.id} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                        <td style={{ padding: '0.45rem 0.75rem', borderBottom: '1px solid #F2F2F2', color: '#666', whiteSpace: 'nowrap' }}>
                          {dateStr} <span style={{ color: '#AAA' }}>{timeStr}</span>
                        </td>
                        <td style={{ padding: '0.45rem 0.75rem', borderBottom: '1px solid #F2F2F2', color: '#2C2C2C' }}>{tx.description}</td>
                        <td style={{ padding: '0.45rem 0.75rem', borderBottom: '1px solid #F2F2F2', textAlign: 'right', fontWeight: 600, color: isCredit ? '#16a34a' : '#dc2626', whiteSpace: 'nowrap' }}>
                          {isCredit ? '+' : ''}{fmt(tx.amount)}
                        </td>
                        <td style={{ padding: '0.45rem 0.75rem', borderBottom: '1px solid #F2F2F2', textAlign: 'right', color: '#555', whiteSpace: 'nowrap' }}>
                          {fmt(tx.balance_after)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <style>{`
          @media (max-width: 900px) {
            .fn-3col { grid-template-columns: 1fr !important; }
          }
          @media (max-width: 700px) {
            .fn-kpi-row { flex-direction: column !important; }
          }
        `}</style>
      </div>
    </div>
  );
}
