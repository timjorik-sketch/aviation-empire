import { useState, useEffect } from 'react';
import TopBar from '../components/TopBar.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';

export default function Personnel({ airline, onBack }) {
  const [data, setData] = useState({ ground: [], cabin: [], cockpit: [], undeployed_ground: 0, undeployed_cabin: 0, undeployed_cockpit: 0 });
  const [loading, setLoading] = useState(true);
  const [dismissing, setDismissing] = useState(null);

  useEffect(() => { fetchPersonnel(); }, []);

  const fetchPersonnel = async () => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/personnel`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const d = await res.json();
      setData({
        ground: d.ground || [], cabin: d.cabin || [], cockpit: d.cockpit || [],
        undeployed_ground: d.undeployed_ground || 0,
        undeployed_cabin: d.undeployed_cabin || 0,
        undeployed_cockpit: d.undeployed_cockpit || 0,
      });
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const dismissUndeployed = async (type) => {
    setDismissing(type);
    const token = localStorage.getItem('token');
    try {
      await fetch(`${API_URL}/api/personnel/dismiss-undeployed/${type}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      await fetchPersonnel();
    } catch (e) { console.error(e); }
    finally { setDismissing(null); }
  };

  const totalGround  = data.ground.reduce((s, r) => s + r.count, 0);
  const groundWage   = data.ground.reduce((s, r) => s + r.count * r.weekly_wage_per_person, 0);
  const totalCabin   = data.cabin.reduce((s, r) => s + r.count, 0);
  const cabinWage    = data.cabin.reduce((s, r) => s + r.count * r.weekly_wage_per_person, 0);
  const totalCockpit = data.cockpit.reduce((s, r) => s + r.count, 0);
  const cockpitWage  = data.cockpit.reduce((s, r) => s + r.count * r.weekly_wage_per_person, 0);
  const totalWage    = groundWage + cabinWage + cockpitWage;

  return (
    <div className="app">
      <div className="page-hero" style={{ backgroundImage: "linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.6)), url('/header-images/Headerimage_crew.png')" }}>
        <div className="page-hero-overlay">
          <h1>Personnel</h1>
          <p>{airline?.name}</p>
        </div>
      </div>

      <div className="container" style={{ paddingTop: '24px' }}>
        <TopBar onBack={onBack} balance={airline?.balance} airline={airline} />

        <div className="info-card" style={{ marginTop: '1.5rem' }}>
          <div className="card-header-bar">
            <span className="card-header-bar-title">Employed People</span>
          </div>

          {loading ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#999' }}>Loading…</div>
          ) : (
            <table className="per-table">
              <thead>
                <tr>
                  <th>Position</th>
                  <th className="per-th-r">Headcount</th>
                  <th className="per-th-r">Not Deployed</th>
                  <th className="per-th-r">Wage / Person</th>
                  <th className="per-th-r">Weekly Cost</th>
                </tr>
              </thead>
              <tbody>
                {/* Ground Staff */}
                <tr className="per-section-row"><td colSpan={5} className="per-section-label">Ground Staff</td></tr>
                <tr>
                  <td className="per-label">Airport Ground Staff</td>
                  <td className="per-val-r">{totalGround.toLocaleString()}</td>
                  <td className="per-val-r">
                    {data.undeployed_ground > 0 ? (
                      <span className="per-undeployed-cell">
                        <span className="per-undeployed-count">{data.undeployed_ground}</span>
                        <button className="per-dismiss-btn" disabled={dismissing === 'ground'} onClick={() => dismissUndeployed('ground')}>
                          {dismissing === 'ground' ? '…' : 'Dismiss'}
                        </button>
                      </span>
                    ) : <span className="per-muted">—</span>}
                  </td>
                  <td className="per-val-r per-muted">$950 / wk</td>
                  <td className="per-val-r per-cost">${groundWage.toLocaleString()}</td>
                </tr>

                {/* Cabin Crew */}
                <tr className="per-section-row"><td colSpan={5} className="per-section-label">Cabin Crew</td></tr>
                <tr>
                  <td className="per-label">Flight Attendants</td>
                  <td className="per-val-r">{totalCabin.toLocaleString()}</td>
                  <td className="per-val-r">
                    {data.undeployed_cabin > 0 ? (
                      <span className="per-undeployed-cell">
                        <span className="per-undeployed-count">{data.undeployed_cabin}</span>
                        <button className="per-dismiss-btn" disabled={dismissing === 'cabin'} onClick={() => dismissUndeployed('cabin')}>
                          {dismissing === 'cabin' ? '…' : 'Dismiss'}
                        </button>
                      </span>
                    ) : <span className="per-muted">—</span>}
                  </td>
                  <td className="per-val-r per-muted">$1,200 / wk</td>
                  <td className="per-val-r per-cost">${cabinWage.toLocaleString()}</td>
                </tr>

                {/* Cockpit Crew */}
                <tr className="per-section-row"><td colSpan={5} className="per-section-label">Cockpit Crew</td></tr>
                {data.cockpit.length === 0 ? (
                  <tr><td colSpan={5} className="per-empty">No cockpit crew hired yet</td></tr>
                ) : (
                  <>
                    {data.cockpit.map(g => (
                      <tr key={g.type_rating}>
                        <td className="per-label">{g.type_rating}</td>
                        <td className="per-val-r">{g.count.toLocaleString()}</td>
                        <td className="per-val-r"><span className="per-muted">—</span></td>
                        <td className="per-val-r per-muted">$3,500 / wk</td>
                        <td className="per-val-r per-cost">${(g.count * g.weekly_wage_per_person).toLocaleString()}</td>
                      </tr>
                    ))}
                    {data.undeployed_cockpit > 0 && (
                      <tr>
                        <td className="per-label per-muted">Not Deployed</td>
                        <td className="per-val-r per-undeployed-count">{data.undeployed_cockpit.toLocaleString()}</td>
                        <td className="per-val-r">
                          <button className="per-dismiss-btn" disabled={dismissing === 'cockpit'} onClick={() => dismissUndeployed('cockpit')}>
                            {dismissing === 'cockpit' ? '…' : 'Dismiss'}
                          </button>
                        </td>
                        <td className="per-val-r per-muted">$3,500 / wk</td>
                        <td className="per-val-r per-cost">${(data.undeployed_cockpit * 3500).toLocaleString()}</td>
                      </tr>
                    )}
                  </>
                )}

                {/* Total */}
                <tr className="per-total-row">
                  <td colSpan={3} className="per-total-label">Total Weekly Payroll</td>
                  <td className="per-val-r per-muted">{(totalGround + totalCabin + totalCockpit).toLocaleString()} employees</td>
                  <td className="per-val-r per-total-val">${totalWage.toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      </div>

      <style>{`
        .per-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
        .per-table thead tr { background: #FAFAFA; border-bottom: 2px solid #E8E8E8; }
        .per-table th { padding: 0.6rem 1.25rem; text-align: left; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #999; }
        .per-th-r { text-align: right !important; }
        .per-table td { padding: 0.65rem 1.25rem; border-bottom: 1px solid #F2F2F2; color: #2C2C2C; vertical-align: middle; }
        .per-section-row td { background: #F5F5F5; border-top: 1px solid #E8E8E8; border-bottom: 1px solid #E8E8E8; padding: 0.3rem 1.25rem; }
        .per-section-label { font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #999; }
        .per-label { font-weight: 500; color: #2C2C2C; }
        .per-val-r { text-align: right; font-family: monospace; font-weight: 600; }
        .per-muted { color: #888 !important; font-weight: 400 !important; }
        .per-cost { color: #2C2C2C; }
        .per-empty { color: #AAAAAA; font-style: italic; padding: 0.75rem 1.25rem !important; }
        .per-total-row td { border-top: 2px solid #E8E8E8; border-bottom: none; background: #FAFAFA; padding: 0.85rem 1.25rem; }
        .per-total-label { font-weight: 700; font-size: 0.88rem; }
        .per-total-val { font-weight: 800; font-size: 1rem; font-family: monospace; color: #2C2C2C; }
        .per-undeployed-cell { display: inline-flex; align-items: center; gap: 6px; justify-content: flex-end; }
        .per-undeployed-count { font-family: monospace; font-weight: 600; color: #ea580c; }
        .per-dismiss-btn {
          font-size: 0.7rem; padding: 2px 8px; border-radius: 4px; cursor: pointer;
          border: 1px solid #E0E0E0; background: white; color: #666; font-weight: 500;
          white-space: nowrap;
        }
        .per-dismiss-btn:hover:not(:disabled) { background: #F5F5F5; border-color: #ccc; color: #2C2C2C; }
        .per-dismiss-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      `}</style>
    </div>
  );
}
