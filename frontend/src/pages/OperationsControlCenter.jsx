import { useState, useEffect, useCallback, useMemo } from 'react';
import TopBar from '../components/TopBar.jsx';
import Toast from '../components/Toast.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

const fmtMoney = (n) => '$' + Math.round(n || 0).toLocaleString();

const PROGRAM_LABEL = {
  basic: 'Basic',
  enhanced: 'Enhanced',
  premium: 'Premium',
};
const GH_LABEL = {
  standard: 'Standard',
  priority: 'Priority',
  premium: 'Premium',
};
const WL_LABEL = {
  none: 'No Contract',
  basic: 'Basic',
  premium: 'Premium',
  unlimited: 'Unlimited',
};
const HP_LABEL = {
  none: 'No Partnership',
  basic: 'Basic',
  premium: 'Premium',
  exclusive: 'Exclusive',
};

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
  const [tab, setTab] = useState('config'); // 'config' | 'report'
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
      await fetchConfig();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  if (loading) {
    return (
      <div className="app">
        <TopBar onBack={onBack} balance={airline?.balance} backLabel={backLabel} />
        <div style={{ padding: 24, textAlign: 'center', color: '#666' }}>Loading…</div>
      </div>
    );
  }

  // ── Aggregate weekly cost preview ────────────────────────────────────────
  const cat = data?.catalog || {};
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

  return (
    <div className="app">
      <TopBar onBack={onBack} balance={airline?.balance} backLabel={backLabel} />
      <Toast error={error} success={success} onClearError={() => setError('')} onClearSuccess={() => setSuccess('')} />

      <div className="page-container" style={{ padding: '24px', maxWidth: 1200, margin: '0 auto' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: '1.6rem' }}>Operations Control Center</h1>
        <p style={{ margin: '0 0 18px', color: '#666', fontSize: '0.9rem' }}>
          Configure disruption protection. Settings affect delay rates, cancellation costs, and wet-lease coverage.
        </p>

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid #e0e0e0' }}>
          <TabBtn active={tab === 'config'} onClick={() => setTab('config')}>Configuration</TabBtn>
          <TabBtn active={tab === 'report'}  onClick={() => setTab('report')}>Weekly Report</TabBtn>
        </div>

        {tab === 'config' && (
          <>
            {/* Weekly cost summary */}
            <div className="info-card" style={{ marginBottom: 20, padding: 18, display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16 }}>
              <SummaryCell label="Maintenance"      value={fmtMoney(weeklyMaint)} />
              <SummaryCell label="Ground Handling"  value={fmtMoney(weeklyGh)} />
              <SummaryCell label="Wet Lease"        value={fmtMoney(weeklyWl)} />
              <SummaryCell label="Hotel"            value={fmtMoney(weeklyHp)} />
              <SummaryCell label="Total / Week"     value={fmtMoney(weeklyTotal)} highlight />
            </div>

            {/* Wet Lease */}
            <Section
              title="Wet Lease Contract"
              subtitle="Covers cancellations from weather, technical-air, medical, and cascade events. Wet-lease operator takes a % of ticket revenue."
              image="/occ/occ_wetlease.png"
            >
              <OptionGrid>
                {Object.entries(cat.wet_lease_contracts || {}).map(([k, cfg]) => (
                  <OptionCard
                    key={k}
                    selected={data.wet_lease_contract === k}
                    label={WL_LABEL[k] || k}
                    cost={cfg.weeklyCost}
                    detail={cfg.revenueShare != null ? `${Math.round(cfg.revenueShare * 100)}% rev share` : 'No coverage — disruptions cancel'}
                    disabled={saving}
                    onClick={() => patch('/api/occ/wet-lease', { contract: k }, `Wet lease set to ${WL_LABEL[k]}`)}
                  />
                ))}
              </OptionGrid>
            </Section>

            {/* Hotel Partnership */}
            <Section
              title="Hotel Partnership"
              subtitle="Reduces hotel cost-per-passenger when flights are cancelled without wet-lease coverage."
              image="/occ/occ_hotel.png"
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
            </Section>

            {/* Maintenance Programs (per aircraft) */}
            <Section
              title="Maintenance Programs"
              subtitle="Per aircraft. Reduces Technical (Ground) and Technical (Air) delay rates."
              image="/occ/occ_maintenance.png"
            >
              {(data?.aircraft || []).length === 0 ? (
                <EmptyState>No aircraft yet.</EmptyState>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {data.aircraft.map(ac => (
                    <AircraftRow
                      key={ac.id}
                      aircraft={ac}
                      catalog={cat.maintenance_programs}
                      disabled={saving}
                      onChange={(program) => patch(`/api/occ/aircraft/${ac.id}/maintenance`, { program },
                        `${ac.registration}: ${PROGRAM_LABEL[program]}`)}
                    />
                  ))}
                </div>
              )}
            </Section>

            {/* Ground Handling (per hub) */}
            <Section
              title="Ground Handling Levels"
              subtitle="Per hub (home base, primary hub, secondary hubs). Reduces Ground Ops delay rate at that airport."
              image="/occ/occ_ground.png"
            >
              {(data?.hubs || []).length === 0 ? (
                <EmptyState>No hubs yet — open a primary hub or add a secondary hub.</EmptyState>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {data.hubs.map(h => (
                    <HubRow
                      key={h.iata_code}
                      hub={h}
                      catalog={cat.ground_handling_levels}
                      disabled={saving}
                      onChange={(level) => patch(`/api/occ/hub/${h.iata_code}/ground-handling`, { level },
                        `${h.iata_code}: ${GH_LABEL[level]}`)}
                    />
                  ))}
                </div>
              )}
            </Section>
          </>
        )}

        {tab === 'report' && report && (
          <ReportView report={report} />
        )}
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────
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

function Section({ title, subtitle, image, children }) {
  return (
    <section style={{ marginBottom: 26, background: '#fff', borderRadius: 8, overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
      {image && (
        <div style={{
          height: 120,
          backgroundImage: `linear-gradient(180deg, rgba(0,0,0,0) 40%, rgba(0,0,0,0.55) 100%), url('${image}')`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          display: 'flex',
          alignItems: 'flex-end',
          padding: '0 20px 14px',
        }}>
          <div>
            <h2 style={{ fontSize: '1.1rem', margin: 0, color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,0.6)' }}>{title}</h2>
            {subtitle && <p style={{ margin: '4px 0 0', color: 'rgba(255,255,255,0.9)', fontSize: '0.8rem', textShadow: '0 1px 3px rgba(0,0,0,0.6)' }}>{subtitle}</p>}
          </div>
        </div>
      )}
      <div style={{ padding: image ? '16px 20px 20px' : 0 }}>
        {!image && (
          <>
            <h2 style={{ fontSize: '1.05rem', margin: '0 0 4px' }}>{title}</h2>
            {subtitle && <p style={{ margin: '0 0 12px', color: '#666', fontSize: '0.85rem' }}>{subtitle}</p>}
          </>
        )}
        {children}
      </div>
    </section>
  );
}

function SummaryCell({ label, value, highlight }) {
  return (
    <div style={{ textAlign: 'left' }}>
      <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', color: '#666', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: '1.2rem', fontWeight: 700, marginTop: 2, color: highlight ? '#2C2C2C' : '#444' }}>{value}</div>
    </div>
  );
}

function OptionGrid({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>{children}</div>;
}

function OptionCard({ selected, label, cost, detail, disabled, onClick }) {
  return (
    <button onClick={onClick} disabled={disabled || selected} style={{
      textAlign: 'left', padding: '14px 16px',
      background: selected ? '#2C2C2C' : '#fff',
      color: selected ? '#fff' : '#2C2C2C',
      border: selected ? '2px solid #2C2C2C' : '2px solid #E0E0E0',
      borderRadius: 8, cursor: selected ? 'default' : 'pointer',
      opacity: disabled && !selected ? 0.6 : 1,
    }}>
      <div style={{ fontSize: '0.95rem', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: '0.78rem', marginTop: 4, opacity: 0.85 }}>{cost > 0 ? `${fmtMoney(cost)} / week` : 'Free'}</div>
      <div style={{ fontSize: '0.75rem', marginTop: 6, opacity: 0.75 }}>{detail}</div>
    </button>
  );
}

function AircraftRow({ aircraft, catalog, disabled, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: '#fff', border: '1px solid #E0E0E0', borderRadius: 6 }}>
      <div style={{ flex: '0 0 200px' }}>
        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{aircraft.registration}</div>
        <div style={{ fontSize: '0.75rem', color: '#666' }}>{aircraft.type_name} · {aircraft.home_airport || '—'}</div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {Object.entries(catalog || {}).map(([k, cfg]) => (
          <button
            key={k}
            disabled={disabled || aircraft.maintenance_program === k}
            onClick={() => onChange(k)}
            style={{
              padding: '6px 14px', borderRadius: 4, fontSize: '0.82rem', cursor: aircraft.maintenance_program === k ? 'default' : 'pointer',
              background: aircraft.maintenance_program === k ? '#2C2C2C' : '#fff',
              color: aircraft.maintenance_program === k ? '#fff' : '#2C2C2C',
              border: '1px solid #2C2C2C',
              opacity: disabled && aircraft.maintenance_program !== k ? 0.6 : 1,
            }}
          >
            {PROGRAM_LABEL[k]} {cfg.weeklyCost > 0 ? `($${cfg.weeklyCost})` : ''}
          </button>
        ))}
      </div>
    </div>
  );
}

function HubRow({ hub, catalog, disabled, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: '#fff', border: '1px solid #E0E0E0', borderRadius: 6 }}>
      <div style={{ flex: '0 0 200px' }}>
        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{hub.iata_code} · {hub.name}</div>
        <div style={{ fontSize: '0.75rem', color: '#666' }}>{hub.country} · Cat {hub.category}</div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {Object.entries(catalog || {}).map(([k, cfg]) => (
          <button
            key={k}
            disabled={disabled || hub.ground_handling_level === k}
            onClick={() => onChange(k)}
            style={{
              padding: '6px 14px', borderRadius: 4, fontSize: '0.82rem', cursor: hub.ground_handling_level === k ? 'default' : 'pointer',
              background: hub.ground_handling_level === k ? '#2C2C2C' : '#fff',
              color: hub.ground_handling_level === k ? '#fff' : '#2C2C2C',
              border: '1px solid #2C2C2C',
              opacity: disabled && hub.ground_handling_level !== k ? 0.6 : 1,
            }}
          >
            {GH_LABEL[k]} {cfg.weeklyCost > 0 ? `($${cfg.weeklyCost.toLocaleString()})` : ''}
          </button>
        ))}
      </div>
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

  return (
    <div>
      {/* Stats grid */}
      <div className="info-card" style={{ padding: 20, marginBottom: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 }}>
        <Stat label="Flights Finalized" value={f.finalized} />
        <Stat label="On-Time Rate" value={otRate != null ? (otRate * 100).toFixed(1) + '%' : '—'} highlight />
        <Stat label="Delayed (completed)" value={f.delayed_completed} />
        <Stat label="Cancelled" value={f.cancelled} />
        <Stat label="Disruption Cost" value={fmtMoney(t.disruption_cost)} />
        <Stat label="Wet Lease Activations" value={t.wet_lease_activations} />
        <Stat label="Wet Lease Cost" value={fmtMoney(t.wet_lease_cost)} />
        <Stat label="Satisfaction Malus" value={'-' + (t.satisfaction_malus || 0)} />
      </div>

      <Section title="Events Breakdown" subtitle="Last 7 days, grouped by event type and outcome.">
        {(report.events || []).length === 0 ? (
          <EmptyState>No disruption events in the last 7 days.</EmptyState>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', border: '1px solid #E0E0E0', borderRadius: 6, overflow: 'hidden' }}>
            <thead>
              <tr style={{ background: '#F5F5F5' }}>
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
                <tr key={i} style={{ borderTop: '1px solid #F0F0F0' }}>
                  <td style={td}>{EVENT_LABEL[e.event_type] || e.event_type}</td>
                  <td style={td}>
                    {OUTCOME_LABEL[e.outcome] || e.outcome}
                    {e.wet_leased && <span style={{ marginLeft: 6, fontSize: '0.7rem', color: '#666' }}>(wet-leased)</span>}
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
      </Section>
    </div>
  );
}

const th = { padding: '10px 14px', textAlign: 'left', fontSize: '0.78rem', fontWeight: 600, color: '#666', textTransform: 'uppercase', letterSpacing: '0.04em' };
const td = { padding: '10px 14px', fontSize: '0.88rem', color: '#2C2C2C' };

function Stat({ label, value, highlight }) {
  return (
    <div>
      <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', color: '#666', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: '1.4rem', fontWeight: 700, marginTop: 2, color: highlight ? '#22c55e' : '#2C2C2C' }}>{value ?? '—'}</div>
    </div>
  );
}
