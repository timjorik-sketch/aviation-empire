import { useNav } from './NavContext.jsx';

const NAV_ITEMS = [
  { key: 'dashboard',  label: 'Dashboard',  section: 'dashboard',  target: 'dashboard' },
  { key: 'fleet',      label: 'Fleet',      section: 'fleet',      target: 'fleet' },
  { key: 'operations', label: 'Operations', section: 'operations', target: 'flights' },
  { key: 'network',    label: 'Network',    section: 'network',    target: 'hubs' },
  { key: 'finances',   label: 'Finances',   section: 'finances',   target: 'finances' },
  { key: 'staff',      label: 'Staff',      section: 'staff',      target: 'personnel' },
];

const SECTION_PAGES = {
  dashboard:  ['dashboard'],
  fleet:      ['fleet', 'cabin-profiles', 'marketplace', 'aircraft-detail'],
  operations: ['flights', 'flight-schedule', 'service-profiles', 'ops-control'],
  network:    ['hubs', 'routes', 'airport-overview', 'airport', 'route-map'],
  finances:   ['finances'],
  staff:      ['personnel'],
};

const SUB_TABS = {
  fleet: [
    { page: 'fleet',          label: 'Overview' },
    { page: 'cabin-profiles', label: 'Cabin Profiles' },
    { page: 'marketplace',    label: 'Marketplace' },
  ],
  operations: [
    { page: 'flights',          label: 'Live Operations' },
    { page: 'flight-schedule',  label: 'Schedule' },
    { page: 'service-profiles', label: 'Service Profiles' },
    { page: 'ops-control',      label: 'OCC' },
  ],
  network: [
    { page: 'hubs',              label: 'Hubs & Destinations' },
    { page: 'routes',            label: 'Routes' },
    { page: 'airport-overview',  label: 'Airport Overview' },
  ],
};

function sectionFor(page) {
  for (const [sec, pages] of Object.entries(SECTION_PAGES)) {
    if (pages.includes(page)) return sec;
  }
  return null;
}

export default function TopBar({ onBack, backLabel = 'Back', balance: balanceProp }) {
  const nav = useNav();

  const currentPage   = nav?.currentPage;
  const navigate      = nav?.navigate || (() => {});
  const airline       = nav?.activeAirline;
  const balance       = balanceProp ?? airline?.balance;
  const activeSection = sectionFor(currentPage);
  const subTabs       = SUB_TABS[activeSection];

  return (
    <div className="topnav-shell">
      <div className="topnav">
        {nav && (
          <nav className="topnav-items">
            {NAV_ITEMS.map(item => {
              const isActive = item.section === activeSection;
              return (
                <button
                  key={item.key}
                  className={`topnav-item${isActive ? ' topnav-item--active' : ''}`}
                  onClick={() => navigate(item.target)}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>
        )}

        <div className="topnav-right">
          {onBack && (
            <button className="topnav-back" onClick={onBack} title={backLabel} aria-label={backLabel}>
              ←
            </button>
          )}
          {balance != null && (
            <div className="topnav-balance">
              <span className="topnav-balance-label">Balance</span>
              <span className="topnav-balance-amount">${balance.toLocaleString()}</span>
            </div>
          )}
        </div>
      </div>

      {subTabs && (
        <div className="topnav-subtabs">
          {subTabs.map(tab => {
            const isActive = currentPage === tab.page;
            return (
              <button
                key={tab.page}
                className={`topnav-subtab${isActive ? ' topnav-subtab--active' : ''}`}
                onClick={() => navigate(tab.page)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      )}

      <style>{`
        .topnav-shell {
          background: #fff;
          border-radius: 8px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.08);
          margin-bottom: 1.5rem;
          overflow: hidden;
        }
        .topnav {
          display: flex;
          align-items: center;
          gap: 1rem;
          padding: 0.6rem 1rem;
        }
        .topnav-right {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 0.6rem;
        }
        .topnav-items {
          flex: 1 1 auto;
          display: flex;
          align-items: center;
          gap: 0.15rem;
          justify-content: flex-start;
          flex-wrap: wrap;
        }

        .topnav-back {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          padding: 0;
          background: transparent;
          border: 1px solid #E0E0E0;
          border-radius: 6px;
          color: #2C2C2C;
          cursor: pointer;
          font-weight: 600;
          font-size: 1.05rem;
          line-height: 1;
          transition: background 0.15s, border-color 0.15s;
        }
        .topnav-back:hover { background: #F5F5F5; border-color: #C8C8C8; }

        .topnav-item {
          background: transparent;
          border: none;
          padding: 0.55rem 0.9rem;
          border-radius: 6px;
          color: #666;
          font-weight: 600;
          font-size: 0.92rem;
          cursor: pointer;
          transition: background 0.15s, color 0.15s;
          white-space: nowrap;
        }
        .topnav-item:hover { background: #F5F5F5; color: #2C2C2C; }
        .topnav-item--active { background: #2C2C2C; color: #fff; }
        .topnav-item--active:hover { background: #2C2C2C; color: #fff; }

        .topnav-balance {
          display: inline-flex;
          align-items: baseline;
          gap: 0.4rem;
          padding: 0.4rem 0.75rem;
          background: #F5F5F5;
          border-radius: 6px;
          font-variant-numeric: tabular-nums;
        }
        .topnav-balance-label { color: #888; font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
        .topnav-balance-amount { color: #2C2C2C; font-size: 0.92rem; font-weight: 700; }

        .topnav-subtabs {
          display: flex;
          gap: 0;
          padding: 0 0.6rem;
          background: #FAFAFA;
          border-top: 1px solid #F0F0F0;
          flex-wrap: wrap;
        }
        .topnav-subtab {
          background: transparent;
          border: none;
          padding: 0.7rem 0.95rem;
          color: #777;
          font-weight: 600;
          font-size: 0.85rem;
          cursor: pointer;
          border-bottom: 2px solid transparent;
          margin-bottom: -1px;
          transition: color 0.15s, border-color 0.15s;
          white-space: nowrap;
        }
        .topnav-subtab:hover { color: #2C2C2C; }
        .topnav-subtab--active {
          color: #2C2C2C;
          border-bottom-color: #2C2C2C;
        }

        @media (max-width: 720px) {
          .topnav { flex-wrap: wrap; gap: 0.5rem; padding: 0.5rem 0.6rem; }
          .topnav-items { gap: 0.1rem; }
          .topnav-item { padding: 0.4rem 0.55rem; font-size: 0.85rem; }
          .topnav-balance { padding: 0.3rem 0.55rem; }
          .topnav-balance-label { display: none; }
        }
      `}</style>
    </div>
  );
}
