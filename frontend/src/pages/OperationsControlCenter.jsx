import { useState, useEffect, useCallback, useMemo } from 'react';
import TopBar from '../components/TopBar.jsx';
import Toast from '../components/Toast.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

const fmtMoney = (n) => '$' + Math.round(n || 0).toLocaleString();

const PROGRAM_LABEL = { basic: 'Basic', enhanced: 'Enhanced', premium: 'Premium' };
const GH_LABEL      = { standard: 'Standard', priority: 'Priority', premium: 'Premium' };
const WL_LABEL      = { none: 'No Contract', basic: 'Basic', premium: 'Premium', unlimited: 'Unlimited' };
const HP_LABEL      = { none: 'No Partnership', basic: 'Basic', premium: 'Premium', exclusive: 'Exclusive' };

const EVENT_LABEL = {
  technical_ground: 'Technical (Ground)',
  ground_ops:       'Ground Ops',
  atc:              'ATC',
  weather:          'Weather',
  technical_air:    'Technical (Air)',
  medical:          'Medical',
  cascade:          'Cascade',
  medical_cascade:  'Medical Cascade',
};
const OUTCOME_LABEL = {
  minor_delay: 'Minor Delay',
  cancelled:   'Cancelled',
  wet_leased:  'Wet-Leased',
  diverted:    'Diverted',
};

export default function OperationsControlCenter({ airline, onBack, backLabel = 'Flight Operations' }) {
  const [tab, setTab] = useState('config');
  const [data, setData] = useState(null);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const token = localStorage.getItem('token');
  const auth = useMemo(() => ({ 'Authorization': `Bearer ${token}` }), [token]);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/occ`, { headers: auth });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to load configuration');
      setData(d);
    } catch (e) { setError(e.message); }
  }, [auth]);

  const fetchReport = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/occ/weekly-report`, { headers: auth });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to load weekly report');
      setReport(d);
    } catch (e) { setError(e.message); }
  }, [auth]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([fetchConfig(), fetchReport()]);
      setLoading(false);
    })();
  }, [fetchConfig, fetchReport]);

  const patch = async (url, body, successMsg) => {
    setSaving(true); setError(''); setSuccess('');
    try {
      const res = await fetch(`${API_URL}${url}`, {
        method: 'PATCH',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Update failed');
      setSuccess(successMsg);
      await Promise.all([fetchConfig(), fetchReport()]);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  if (loading) {
    return (
      <div className="app">
        <div className="page-hero" style={{ backgroundImage: "url('/header-images/Headerimage_opertaions.png')" }}>
          <div className="page-hero-overlay">
            <h1>Operations Control Center</h1>
            <p>{airline?.name}</p>
          </div>
        </div>
        <div className="container" style={{ paddingTop: 24 }}>
          <TopBar onBack={onBack} balance={airline?.balance} airline={airline} backLabel={backLabel} />
          <p style={{ color: '#666', marginTop: '2rem' }}>Loading…</p>
        </div>
      </div>
    );
  }

  const cat = data?.catalog || {};

  // Weekly subscription cost preview
  let weeklyMaint = 0;
  for (const ac of (data?.aircraft || [])) {
    weeklyMaint += cat.maintenance_programs?.[ac.maintenance_program]?.weeklyCost || 0;
  }
  let weeklyGh = 0;
  for (const h of (data?.hubs || [])) {
    weeklyGh += cat.ground_handling_levels?.[h.ground_handling_level]?.weeklyCost || 0;
  }
  const weeklyWl = cat.wet_lease_contracts?.[data?.wet_lease_contract]?.weeklyCost || 0;
  const weeklyHp = cat.hotel_partnerships?.[data?.hotel_partnership]?.weeklyCost || 0;
  const weeklyTotal = weeklyMaint + weeklyGh + weeklyWl + weeklyHp;

  // KPI values from report
  const f = report?.flights || {};
  const t = report?.totals || {};
  const otRate = f.on_time_rate;
  const otPct = otRate != null ? (otRate * 100).toFixed(1) + '%' : '—';
  const otColor = otRate == null ? '#2C2C2C' : otRate >= 0.95 ? '#16a34a' : otRate >= 0.85 ? '#eab308' : '#dc2626';

  return (
    <div className="app">
      <div className="page-hero" style={{ backgroundImage: "url('/header-images/Headerimage_opertaions.png')" }}>
        <div className="page-hero-overlay">
          <h1>Operations Control Center</h1>
          <p>{airline?.name}</p>
        </div>
      </div>

      <div className="container" style={{ paddingTop: 24 }}>
        <TopBar onBack={onBack} balance={airline?.balance} airline={airline} backLabel={backLabel} />
        <Toast error={error} success={success} onClearError={() => setError('')} onClearSuccess={() => setSuccess('')} />

        {/* ── 4 KPI Cards ── */}
        <div style={{ display: 'flex', gap: '16px', marginBottom: '20px', flexWrap: 'wrap' }}>
          <KPI label="Weekly OCC Cost" value={fmtMoney(weeklyTotal)} sub={`Maint ${fmtMoney(weeklyMaint)} · GH ${fmtMoney(weeklyGh)} · WL ${fmtMoney(weeklyWl)} · HP ${fmtMoney(weeklyHp)}`} />
          <KPI label="On-Time Rate" value={otPct} valColor={otColor} sub={`${f.finalized || 0} flights finalized`} />
          <KPI label="Disruption Cost" value={fmtMoney(t.disruption_cost)} sub={`Last 7 days`} />
          <KPI label="Wet Lease Used" value={`${t.wet_lease_activations || 0}×`} sub={`${fmtMoney(t.wet_lease_cost)} paid`} />
        </div>

        {/* ── Tab bar ── */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid #E0E0E0' }}>
          <TabBtn active={tab === 'config'} onClick={() => setTab('config')}>Configuration</TabBtn>
          <TabBtn active={tab === 'report'} onClick={() => setTab('report')}>Weekly Report</TabBtn>
        </div>

        {tab === 'config' && (
          <>
            {/* Two-column row: Wet Lease + Hotel Partnership */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', marginBottom: '20px' }}>
              <ConfigCard
                title="Wet Lease Contract"
                image="/occ/occ_wetlease.png"
                subtitle="Covers cancellations from weather, technical-air, and cascade events. Operator takes a % of ticket revenue."
              >
                <OptionGrid>
                  {Object.entries(cat.wet_lease_contracts || {}).map(([k, cfg]) => (
                    <OptionCard
                      key={k}
                      selected={data.wet_lease_contract === k}
                      label={WL_LABEL[k] || k}
                      cost={cfg.weeklyCost}
                      detail={cfg.revenueShare != null ? `${Math.round(cfg.revenueShare * 100)}% rev share on use` : 'No coverage — disruptions cancel'}
                      disabled={saving}
                      onClick={() => patch('/api/occ/wet-lease', { contract: k }, `Wet lease set to ${WL_LABEL[k]}`)}
                    />
                  ))}
                </OptionGrid>
              </ConfigCard>

              <ConfigCard
                title="Hotel Partnership"
                image="/occ/occ_hotel.png"
                subtitle="Reduces hotel cost per passenger when flights are cancelled without wet-lease coverage."
              >
                <OptionGrid>
                  {Object.entries(cat.hotel_partnerships || {}).map(([k, cfg]) => (
                    <OptionCard
                      key={k}
                      selected={data.hotel_partnership === k}
                      label={HP_LABEL[k] || k}
                      cost={cfg.weeklyCost}
                      detail={`$${cfg.hotelCostPerPax}/pax on cancel`}
                      disabled={saving}
                      onClick={() => patch('/api/occ/hotel-partnership', { partnership: k }, `Hotel partnership set to ${HP_LABEL[k]}`)}
                    />
                  ))}
                </OptionGrid>
              </ConfigCard>
            </div>

            {/* Maintenance Programs */}
            <ConfigCard
              title="Maintenance Programs"
              image="/occ/occ_maintenance.png"
              subtitle="Per aircraft. Reduces Technical (Ground) and Technical (Air) delay rates."
            >
              {(data?.aircraft || []).length === 0 ? (
                <EmptyState>No aircraft yet.</EmptyState>
              ) : (
                <table className="occ-table" style={tblStyle}>
                  <thead>
                    <tr>
                      <th style={th}>Aircraft</th>
                      <th style={{ ...th, textAlign: 'right' }}>Program</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.aircraft.map(ac => (
                      <tr key={ac.id} style={trStyle}>
                        <td style={td}>
                          <div style={{ fontWeight: 600, color: '#2C2C2C' }}>{ac.registration}</div>
                          <div style={subTextStyle}>{ac.type_name} · {ac.home_airport || '—'}</div>
                        </td>
                        <td style={{ ...td, textAlign: 'right' }}>
                          <PillGroup
                            options={cat.maintenance_programs}
                            current={ac.maintenance_program}
                            labels={PROGRAM_LABEL}
                            disabled={saving}
                            onChange={(program) => patch(`/api/occ/aircraft/${ac.id}/maintenance`, { program }, `${ac.registration}: ${PROGRAM_LABEL[program]}`)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </ConfigCard>

            {/* Ground Handling */}
            <ConfigCard
              title="Ground Handling Levels"
              image="/occ/occ_ground.png"
              subtitle="Per hub (home base, primary hub, secondary hubs). Reduces Ground Ops delay rate at that airport."
            >
              {(data?.hubs || []).length === 0 ? (
                <EmptyState>No hubs yet — open a primary hub or add a secondary hub.</EmptyState>
              ) : (
                <table className="occ-table" style={tblStyle}>
                  <thead>
                    <tr>
                      <th style={th}>Hub</th>
                      <th style={{ ...th, textAlign: 'right' }}>Level</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.hubs.map(h => (
                      <tr key={h.iata_code} style={trStyle}>
                        <td style={td}>
                          <div style={{ fontWeight: 600, color: '#2C2C2C' }}>{h.iata_code} · {h.name}</div>
                          <div style={subTextStyle}>{h.country} · Cat {h.category}</div>
                        </td>
                        <td style={{ ...td, textAlign: 'right' }}>
                          <PillGroup
                            options={cat.ground_handling_levels}
                            current={h.ground_handling_level}
                            labels={GH_LABEL}
                            disabled={saving}
                            onChange={(level) => patch(`/api/occ/hub/${h.iata_code}/ground-handling`, { level }, `${h.iata_code}: ${GH_LABEL[level]}`)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </ConfigCard>
          </>
        )}

        {tab === 'report' && report && <ReportView report={report} />}
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function KPI({ label, value, valColor = '#2C2C2C', sub }) {
  return (
    <div style={{ background: '#fff', borderRadius: '8px', padding: '20px 24px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', flex: '1 1 0', minWidth: '180px' }}>
      <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#999', marginBottom: '6px' }}>{label}</div>
      <div style={{ fontSize: '1.55rem', fontWeight: 700, color: valColor, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ marginTop: '6px', fontSize: '0.72rem', color: '#888', lineHeight: 1.3 }}>{sub}</div>}
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: 'transparent', border: 'none', cursor: 'pointer',
      padding: '10px 18px', fontSize: '0.95rem', fontWeight: 600,
      color: active ? '#2C2C2C' : '#888',
      borderBottom: active ? '2px solid #2C2C2C' : '2px solid transparent',
      marginBottom: -2,
    }}>{children}</button>
  );
}

// info-card with the standard dark header bar + an OCC banner image flush
// underneath, then the children below.
function ConfigCard({ title, image, subtitle, children }) {
  return (
    <div className="info-card" style={{ marginBottom: 20 }}>
      <div className="card-header-bar">
        <span className="card-header-bar-title">{title}</span>
      </div>
      {image && (
        <div style={{
          height: 110,
          margin: '-20px -28px 16px',
          backgroundImage: `linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.4) 100%), url('${image}')`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }} />
      )}
      {subtitle && <p style={{ margin: '0 0 16px', color: '#666', fontSize: '0.85rem', lineHeight: 1.4 }}>{subtitle}</p>}
      {children}
    </div>
  );
}

function OptionGrid({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>{children}</div>;
}

function OptionCard({ selected, label, cost, detail, disabled, onClick }) {
  return (
    <button onClick={onClick} disabled={disabled || selected} style={{
      textAlign: 'left', padding: '14px 16px',
      background: selected ? '#2C2C2C' : '#fff',
      color: selected ? '#fff' : '#2C2C2C',
      border: selected ? '2px solid #2C2C2C' : '2px solid #E0E0E0',
      borderRadius: 6, cursor: selected ? 'default' : 'pointer',
      opacity: disabled && !selected ? 0.5 : 1,
      transition: 'all 0.15s',
    }}>
      <div style={{ fontSize: '0.92rem', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: '0.78rem', marginTop: 4, opacity: 0.85 }}>{cost > 0 ? `${fmtMoney(cost)} / week` : 'Free'}</div>
      <div style={{ fontSize: '0.74rem', marginTop: 6, opacity: 0.75 }}>{detail}</div>
    </button>
  );
}

function PillGroup({ options, current, labels, disabled, onChange }) {
  return (
    <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {Object.entries(options || {}).map(([k, cfg]) => {
        const isCurrent = current === k;
        return (
          <button
            key={k}
            disabled={disabled || isCurrent}
            onClick={() => onChange(k)}
            style={{
              padding: '6px 12px', borderRadius: 4, fontSize: '0.78rem', fontWeight: 600,
              cursor: isCurrent ? 'default' : 'pointer',
              background: isCurrent ? '#2C2C2C' : '#fff',
              color: isCurrent ? '#fff' : '#2C2C2C',
              border: '1px solid #2C2C2C',
              opacity: disabled && !isCurrent ? 0.5 : 1,
              transition: 'all 0.15s',
            }}
          >
            {labels[k]}{cfg.weeklyCost > 0 ? ` · $${cfg.weeklyCost.toLocaleString()}` : ''}
          </button>
        );
      })}
    </div>
  );
}

function EmptyState({ children }) {
  return (
    <div style={{ background: '#F5F5F5', padding: 24, borderRadius: 6, textAlign: 'center', color: '#666', fontSize: '0.9rem' }}>
      {children}
    </div>
  );
}

function ReportView({ report }) {
  const f = report.flights || {};
  const t = report.totals || {};
  const otRate = f.on_time_rate;
  const otPct = otRate != null ? (otRate * 100).toFixed(1) + '%' : '—';

  return (
    <>
      {/* Two-column: Summary + Events */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', marginBottom: '20px' }}>
        <div className="info-card" style={{ marginBottom: 0 }}>
          <div className="card-header-bar">
            <span className="card-header-bar-title">Summary — Last 7 Days</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              <ReportRow label="Flights Finalized"   value={(f.finalized || 0).toLocaleString()} />
              <ReportRow label="On-Time Rate"        value={otPct} bold />
              <ReportRow label="Delayed (completed)" value={(f.delayed_completed || 0).toLocaleString()} />
              <ReportRow label="Cancelled"           value={(f.cancelled || 0).toLocaleString()} />
            </tbody>
          </table>
        </div>

        <div className="info-card" style={{ marginBottom: 0 }}>
          <div className="card-header-bar">
            <span className="card-header-bar-title">Cost & Impact</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              <ReportRow label="Disruption Cost"        value={fmtMoney(t.disruption_cost)} />
              <ReportRow label="Wet Lease Cost"        value={fmtMoney(t.wet_lease_cost)} />
              <ReportRow label="Wet Lease Activations" value={`${t.wet_lease_activations || 0}×`} />
              <ReportRow label="Total Satisfaction Malus" value={`-${t.satisfaction_malus || 0}`} bold />
            </tbody>
          </table>
        </div>
      </div>

      {/* Events breakdown */}
      <div className="info-card">
        <div className="card-header-bar">
          <span className="card-header-bar-title">Events Breakdown</span>
        </div>
        {(report.events || []).length === 0 ? (
          <EmptyState>No disruption events in the last 7 days.</EmptyState>
        ) : (
          <table style={tblStyle}>
            <thead>
              <tr>
                <th style={th}>Event</th>
                <th style={th}>Outcome</th>
                <th style={{ ...th, textAlign: 'right' }}>Count</th>
                <th style={{ ...th, textAlign: 'right' }}>Total Delay (min)</th>
                <th style={{ ...th, textAlign: 'right' }}>Cost</th>
                <th style={{ ...th, textAlign: 'right' }}>Sat. Malus</th>
              </tr>
            </thead>
            <tbody>
              {report.events.map((e, i) => (
                <tr key={i} style={trStyle}>
                  <td style={td}>{EVENT_LABEL[e.event_type] || e.event_type}</td>
                  <td style={td}>
                    {OUTCOME_LABEL[e.outcome] || e.outcome}
                    {e.wet_leased && <span style={{ marginLeft: 6, fontSize: '0.7rem', color: '#888' }}>(wet-leased)</span>}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>{e.count}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{e.total_delay_min || 0}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(e.total_cost)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>-{e.total_sat_malus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function ReportRow({ label, value, bold }) {
  return (
    <tr>
      <td style={{ padding: '0.45rem 0', fontSize: '0.85rem', color: bold ? '#2C2C2C' : '#555', fontWeight: bold ? 700 : 400, borderTop: bold ? '1px solid #E8E8E8' : 'none' }}>{label}</td>
      <td style={{ padding: '0.45rem 0', textAlign: 'right', fontSize: '0.88rem', fontWeight: bold ? 700 : 500, color: bold ? '#2C2C2C' : '#444', borderTop: bold ? '1px solid #E8E8E8' : 'none' }}>{value}</td>
    </tr>
  );
}

// ── shared table styles ─────────────────────────────────────────────────────
const tblStyle = { width: '100%', borderCollapse: 'collapse' };
const th = { padding: '8px 10px', textAlign: 'left', fontSize: '0.72rem', fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid #E0E0E0' };
const td = { padding: '12px 10px', fontSize: '0.88rem', color: '#2C2C2C', verticalAlign: 'middle' };
const trStyle = { borderTop: '1px solid #F0F0F0' };
const subTextStyle = { fontSize: '0.74rem', color: '#888', marginTop: 2 };
