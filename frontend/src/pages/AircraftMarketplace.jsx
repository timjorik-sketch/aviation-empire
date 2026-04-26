import { useState, useEffect, useMemo, useCallback } from 'react';
import TopBar from '../components/TopBar.jsx';
import Toast from '../components/Toast.jsx';
import AirlineProfilePopup from '../components/AirlineProfilePopup.jsx';
// aircraftValue utils used via local fmt() helper below

const API_URL = import.meta.env.VITE_API_URL || '';

const WAKE_LABELS = { L: 'Light', M: 'Medium', H: 'Heavy' };


function fmt(price) {
  if (!price) return '—';
  if (price >= 1e9) return `$${(price / 1e9).toFixed(2)}B`;
  if (price >= 1e6) return `$${(price / 1e6).toFixed(1)}M`;
  return `$${Math.round(price).toLocaleString()}`;
}
function fmtFH(h) { return Math.round(h).toLocaleString() + ' h'; }
function fmtAge(manufacturedYear) {
  const mfr = new Date(manufacturedYear, 6, 1); // assume July 1
  const now = new Date();
  let y = now.getFullYear() - mfr.getFullYear();
  let m = now.getMonth() - mfr.getMonth();
  if (m < 0) { y--; m += 12; }
  return m > 0 ? `${y} J. ${m} M.` : `${y} J.`;
}

function getCategory(ac) {
  if (ac.max_passengers < 50)  return 'Turboprop';
  if (ac.max_passengers < 100) return 'Regional Jet';
  if (ac.max_passengers < 250) return 'Narrow-body';
  if (ac.max_passengers < 500) return 'Wide-body';
  return 'Very Large';
}

function regToFlag(reg) {
  if (!reg) return '';
  const r = reg.toUpperCase();
  if (r.startsWith('N'))   return '🇺🇸';
  if (r.startsWith('D-'))  return '🇩🇪';
  if (r.startsWith('F-'))  return '🇫🇷';
  if (r.startsWith('G-'))  return '🇬🇧';
  if (r.startsWith('HB-')) return '🇨🇭';
  if (r.startsWith('PH-')) return '🇳🇱';
  if (r.startsWith('EC-')) return '🇪🇸';
  if (r.startsWith('I-'))  return '🇮🇹';
  if (r.startsWith('VH-')) return '🇦🇺';
  if (r.startsWith('C-'))  return '🇨🇦';
  if (r.startsWith('PP-')) return '🇧🇷';
  if (r.startsWith('JA'))  return '🇯🇵';
  if (r.startsWith('9V-')) return '🇸🇬';
  if (r.startsWith('A6-')) return '🇦🇪';
  if (r.startsWith('B-'))  return '🇨🇳';
  return '🌍';
}

export default function AircraftMarketplace({ airline, onBack, onBalanceUpdate }) {
  // Sidebar filters
  const [selectedMfr, setSelectedMfr]       = useState(null);
  const [filterMinRange, setFilterMinRange] = useState(0);
  const [filterMaxRange, setFilterMaxRange] = useState(null); // null = no upper limit
  const [searchQuery, setSearchQuery]       = useState('');

  // Data
  const [allTypes, setAllTypes]     = useState([]);
  const [airports, setAirports]     = useState([]);
  const [usedListings, setUsedListings] = useState([]);
  const [loading, setLoading]       = useState(true);

  // Modal
  const [modal, setModal]                     = useState(null); // aircraft type object
  const [modalTab, setModalTab]               = useState('new'); // 'new' | 'used'
  const [selectedUsedListing, setSelectedUsedListing] = useState(null);
  const [quantity, setQuantity]               = useState(1);
  const [deliveryAirport, setDeliveryAirport] = useState('');
  const [cabinProfiles, setCabinProfiles]     = useState([]);
  const [selectedCabinProfileId, setSelectedCabinProfileId] = useState('');
  const [purchasing, setPurchasing]           = useState(false);
  const [error, setError]   = useState('');
  const [success, setSuccess] = useState('');
  const [profilePopupCode, setProfilePopupCode] = useState(null);

  // Load everything on mount
  useEffect(() => {
    const token = localStorage.getItem('token');
    Promise.all([
      fetch(`${API_URL}/api/aircraft-market`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      fetch(`${API_URL}/api/destinations/opened`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      fetch(`${API_URL}/api/aircraft/market/used`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
    ]).then(([mkt, apts, used]) => {
      setAllTypes(mkt.aircraft_types || []);
      setAirports(apts.airports || []);
      setDeliveryAirport(airline.home_airport_code || '');
      setUsedListings(used.listings || []);
    }).catch(() => setError('Failed to load market data'))
      .finally(() => setLoading(false));
  }, []);

  // Only purchasable types (locked aircraft hidden entirely)
  const purchasableTypes = useMemo(() => allTypes.filter(ac => ac.can_purchase), [allTypes]);

  // Max range across purchasable types (for slider)
  const maxRangeInData = useMemo(() => {
    if (!purchasableTypes.length) return 16000;
    return Math.max(...purchasableTypes.map(ac => ac.range_km));
  }, [purchasableTypes]);

  // All manufacturers (for sidebar — only purchasable)
  const allManufacturers = useMemo(() => {
    const counts = {};
    for (const ac of purchasableTypes) {
      if (!counts[ac.manufacturer]) counts[ac.manufacturer] = 0;
      counts[ac.manufacturer]++;
    }
    return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  }, [purchasableTypes]);

  // Filtered types
  const filteredTypes = useMemo(() => {
    const maxR = filterMaxRange ?? maxRangeInData;
    return purchasableTypes.filter(ac => {
      if (selectedMfr && ac.manufacturer !== selectedMfr) return false;
      if (ac.range_km < filterMinRange || ac.range_km > maxR) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (
          !ac.model.toLowerCase().includes(q) &&
          !ac.full_name.toLowerCase().includes(q) &&
          !ac.manufacturer.toLowerCase().includes(q)
        ) return false;
      }
      return true;
    });
  }, [allTypes, selectedMfr, filterMinRange, filterMaxRange, maxRangeInData, searchQuery]);

  // Group filtered types by manufacturer
  const mfrGroups = useMemo(() => {
    const map = {};
    for (const ac of filteredTypes) {
      if (!map[ac.manufacturer]) map[ac.manufacturer] = [];
      map[ac.manufacturer].push(ac);
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredTypes]);

  // Open modal for a given aircraft type
  const openModal = useCallback(async (aircraft) => {
    setModal(aircraft);
    setModalTab('new');
    setSelectedUsedListing(null);
    setQuantity(1);
    setDeliveryAirport(airline.home_airport_code || '');
    setSelectedCabinProfileId('');
    setCabinProfiles([]);
    setError('');
    const token = localStorage.getItem('token');
    try {
      const d = await fetch(`${API_URL}/api/cabin-profiles/for-type/${aircraft.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then(r => r.json());
      setCabinProfiles(d.profiles || []);
    } catch { setCabinProfiles([]); }
  }, [airline]);

  const closeModal = () => { setModal(null); setSelectedUsedListing(null); setError(''); setSuccess(''); };

  // Used listings for the aircraft type currently in the modal
  const modalUsedListings = useMemo(() => {
    if (!modal) return [];
    return usedListings.filter(l => l.type_id === modal.id);
  }, [modal, usedListings]);

  const handlePurchaseNew = async () => {
    if (!modal) return;
    const totalCost = modal.new_price_usd * quantity;
    if (airline.balance < totalCost) { setError('Insufficient funds'); return; }
    setSuccess('');
    setPurchasing(true);
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/aircraft/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          typeId: modal.id, quantity, deliveryAirport,
          cabin_profile_id: selectedCabinProfileId ? parseInt(selectedCabinProfileId) : undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Purchase failed');
      setSuccess(data.message);
      setError('');
      onBalanceUpdate(data.new_balance);
    } catch(e) { setError(e.message); }
    finally { setPurchasing(false); }
  };

  const handlePurchaseUsed = async () => {
    if (!selectedUsedListing) return;
    if (airline.balance < selectedUsedListing.current_value) { setError('Insufficient funds'); return; }
    setSuccess('');
    setPurchasing(true);
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/aircraft/market/used/${selectedUsedListing.id}/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          deliveryAirport,
          cabin_profile_id: selectedCabinProfileId ? parseInt(selectedCabinProfileId) : undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Purchase failed');
      setSuccess(data.message);
      setError('');
      onBalanceUpdate(data.new_balance);
      // Remove bought listing
      setUsedListings(prev => prev.filter(l => l.id !== selectedUsedListing.id));
      setSelectedUsedListing(null);
    } catch(e) { setError(e.message); }
    finally { setPurchasing(false); }
  };

  // Modal cost + affordability
  const modalCost = modalTab === 'new'
    ? (modal?.new_price_usd || 0) * quantity
    : (selectedUsedListing?.current_value || 0);
  const canAfford = airline.balance >= modalCost;
  const canConfirm = modalTab === 'new'
    ? canAfford
    : (canAfford && selectedUsedListing != null);

  if (loading) return (
    <div className="am-page">
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh', color:'#666' }}>
        Loading...
      </div>
    </div>
  );

  return (
    <div className="am-page">
      {/* Hero */}
      <div className="am-hero">
        <div className="am-hero-overlay">
          <h1>Airplane Market</h1>
          <p>{airline.name} — Expand Your Fleet</p>
        </div>
      </div>

      <div className="am-container">
        <TopBar onBack={onBack} balance={airline.balance} backLabel="Fleet" airline={airline} />

        <Toast error={error} onClearError={() => setError('')} success={success} onClearSuccess={() => setSuccess('')} />

        <div className="am-layout">
          {/* ── SIDEBAR ── */}
          <aside className="am-sidebar">
            {/* Search */}
            <div className="am-sb-section">
              <input
                className="am-sb-search"
                placeholder="Search aircraft…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>

            {/* Manufacturers */}
            <div className="am-sb-section">
              <div className="am-sb-label">Manufacturer</div>
              <button
                className={`am-sb-mfr-item${!selectedMfr ? ' am-sb-mfr-item--active' : ''}`}
                onClick={() => setSelectedMfr(null)}
              >
                <span>All Manufacturers</span>
                <span className="am-sb-mfr-count">{purchasableTypes.length}</span>
              </button>
              {allManufacturers.map(([mfr, count]) => (
                <button
                  key={mfr}
                  className={`am-sb-mfr-item${selectedMfr === mfr ? ' am-sb-mfr-item--active' : ''}`}
                  onClick={() => setSelectedMfr(selectedMfr === mfr ? null : mfr)}
                >
                  <span>{mfr}</span>
                  <span className="am-sb-mfr-count">{count}</span>
                </button>
              ))}
            </div>

            {/* Range filter */}
            <div className="am-sb-section">
              <div className="am-sb-label">Range</div>
              <div className="am-range-value">
                {filterMinRange.toLocaleString()} – {(filterMaxRange ?? maxRangeInData).toLocaleString()} km
              </div>
              <div className="am-range-row">
                <span className="am-range-sublabel">Min</span>
                <input
                  type="range"
                  min={0}
                  max={maxRangeInData}
                  step={100}
                  value={filterMinRange}
                  onChange={e => {
                    const v = Number(e.target.value);
                    setFilterMinRange(v);
                    if ((filterMaxRange ?? maxRangeInData) < v) setFilterMaxRange(v);
                  }}
                  className="am-range-slider"
                />
              </div>
              <div className="am-range-row">
                <span className="am-range-sublabel">Max</span>
                <input
                  type="range"
                  min={0}
                  max={maxRangeInData}
                  step={100}
                  value={filterMaxRange ?? maxRangeInData}
                  onChange={e => {
                    const v = Number(e.target.value);
                    setFilterMaxRange(v >= maxRangeInData ? null : v);
                    if (v < filterMinRange) setFilterMinRange(v);
                  }}
                  className="am-range-slider"
                />
              </div>
              <div className="am-range-labels">
                <span>0</span>
                <span>{maxRangeInData.toLocaleString()} km</span>
              </div>
            </div>

            {/* Reset filters */}
            {(selectedMfr || filterMinRange > 0 || filterMaxRange !== null || searchQuery) && (
              <div className="am-sb-section">
                <button
                  className="am-sb-reset"
                  onClick={() => { setSelectedMfr(null); setFilterMinRange(0); setFilterMaxRange(null); setSearchQuery(''); }}
                >
                  Reset Filters
                </button>
              </div>
            )}
          </aside>

          {/* ── MAIN CONTENT ── */}
          <div className="am-content">
            {filteredTypes.length === 0 ? (
              <div className="am-empty">No aircraft match your filters.</div>
            ) : (
              mfrGroups.map(([mfr, aircraft]) => (
                <div key={mfr} className="am-mfr-section">
                  <div className="am-mfr-header">
                    <span className="am-mfr-name">{mfr}</span>
                    <span className="am-mfr-count">{aircraft.length} type{aircraft.length !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="am-mfr-body">
                    <div className="am-grid">
                      {aircraft.map(ac => {
                        const canAffordAc = airline.balance >= ac.new_price_usd;
                        const usedForType = usedListings.filter(l => l.type_id === ac.id);
                        return (
                          <div key={ac.id} className="am-card">
                            {/* Image */}
                            <div className="am-card-img-wrap">
                              {ac.image_filename
                                ? <img src={`/aircraft-images/${ac.image_filename}`} alt={ac.full_name} className="am-card-img" />
                                : <div className="am-card-img-placeholder">✈</div>
                              }
                              {usedForType.length > 0 && (
                                <div className="am-used-badge">{usedForType.length} Used Aircraft</div>
                              )}
                            </div>

                            {/* Card body */}
                            <div className="am-card-body">
                              <div className="am-card-header-row">
                                <div className="am-card-model">{ac.model}</div>
                                <div className="am-card-fullname">{ac.full_name}</div>
                              </div>

                              <table className="am-spec-table">
                                <tbody>
                                  <tr><td>Passengers</td><td>{ac.max_passengers}</td></tr>
                                  <tr><td>Range</td><td>{ac.range_km.toLocaleString()} km</td></tr>
                                  <tr><td>Cruise Speed</td><td>{ac.cruise_speed_kmh} km/h</td></tr>
                                  <tr><td>Fuel Burn</td><td>{ac.fuel_consumption_per_km != null ? `${ac.fuel_consumption_per_km.toFixed(1)} kg/km` : '—'}</td></tr>
                                  <tr><td>Min. Runway</td><td>{ac.min_runway_landing_m.toLocaleString()} m</td></tr>
                                  <tr><td>Wake Turbulence</td><td>{ac.wake_turbulence_category} – {WAKE_LABELS[ac.wake_turbulence_category]}</td></tr>
                                  <tr><td>Category</td><td>{getCategory(ac)}</td></tr>
                                  <tr><td>Required Level</td><td>{ac.required_level}</td></tr>
                                </tbody>
                              </table>

                              <div className="am-card-footer">
                                <div>
                                  <div className="am-card-price-label">New from</div>
                                  <div className={`am-card-price${canAffordAc ? '' : ' am-price--no'}`}>
                                    {fmt(ac.new_price_usd)}
                                  </div>
                                </div>
                                <button
                                  className="am-btn-buy"
                                  disabled={!ac.can_purchase}
                                  onClick={() => openModal(ac)}
                                >
                                  {!ac.can_purchase ? `Locked` : 'Buy Aircraft'}
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* ── PURCHASE MODAL ── */}
      {modal && (
        <div className="am-modal-overlay" onClick={closeModal}>
          <div className="am-modal" onClick={e => e.stopPropagation()}>
            {/* Modal header */}
            <div className="am-modal-head">
              <div>
                <div className="am-modal-head-label">{modal.manufacturer}</div>
                <h2 className="am-modal-head-title">{modal.full_name}</h2>
              </div>
              <button className="am-modal-close" onClick={closeModal}>&times;</button>
            </div>

            {/* New / Used tabs */}
            <div className="am-modal-tabs">
              <button
                className={`am-modal-tab${modalTab === 'new' ? ' am-modal-tab--active' : ''}`}
                onClick={() => { setModalTab('new'); setSelectedUsedListing(null); setError(''); }}
              >
                New Aircraft
              </button>
              <button
                className={`am-modal-tab${modalTab === 'used' ? ' am-modal-tab--active' : ''}`}
                onClick={() => { setModalTab('used'); setError(''); }}
              >
                Used Market
                {modalUsedListings.length > 0 && (
                  <span className="am-modal-tab-badge">{modalUsedListings.length}</span>
                )}
              </button>
            </div>

            <div className="am-modal-body">
              {/* Image */}
              {modal.image_filename && (
                <img src={`/aircraft-images/${modal.image_filename}`} alt="" className="am-modal-img" />
              )}

              {/* ── NEW TAB ── */}
              {modalTab === 'new' && (
                <>
                  <div className="am-form-row">
                    <label>Quantity</label>
                    <input type="number" min="1" max="10" value={quantity}
                      onChange={e => setQuantity(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                      className="am-form-input" style={{ width: '80px' }} />
                  </div>
                  <div className="am-form-row">
                    <label>Delivery Airport</label>
                    <select value={deliveryAirport} onChange={e => setDeliveryAirport(e.target.value)} className="am-form-select">
                      {Object.entries(airports.reduce((acc, a) => { (acc[a.country] = acc[a.country] || []).push(a); return acc; }, {})).sort(([a],[b]) => a.localeCompare(b)).map(([country, list]) => (
                        <optgroup key={country} label={country}>
                          {list.map(a => (
                            <option key={a.iata_code} value={a.iata_code}>
                              {a.iata_code} – {a.name}{a.iata_code === airline.home_airport_code ? ' (Home)' : ''}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  {cabinProfiles.length > 0 && (
                    <div className="am-form-row">
                      <label>Cabin Profile <span style={{ color:'#999', fontWeight:400 }}>(optional)</span></label>
                      <select value={selectedCabinProfileId} onChange={e => setSelectedCabinProfileId(e.target.value)} className="am-form-select">
                        <option value="">None — assign later</option>
                        {cabinProfiles.map(p => <option key={p.id} value={p.id}>{p.name} ({p.total_capacity} seats)</option>)}
                      </select>
                    </div>
                  )}
                  <div className="am-price-summary">
                    {quantity > 1 && <div className="am-price-row"><span>Unit price</span><span>{fmt(modal.new_price_usd)}</span></div>}
                    {quantity > 1 && <div className="am-price-row"><span>Quantity</span><span>× {quantity}</span></div>}
                    <div className="am-price-row am-price-row--total">
                      <span>Total</span>
                      <span className={canAfford ? 'am-price--ok' : 'am-price--no'}>{fmt(modalCost)}</span>
                    </div>
                    {!canAfford && <p className="am-insufficient">Need {fmt(modalCost - airline.balance)} more.</p>}
                  </div>
                </>
              )}

              {/* ── USED TAB ── */}
              {modalTab === 'used' && (
                <>
                  {modalUsedListings.length === 0 ? (
                    <div className="am-used-empty">
                      <div className="am-used-empty-icon">✈</div>
                      <div>No used {modal.model} currently on the market.</div>
                      <div style={{ fontSize:'0.8rem', color:'#999', marginTop:'0.3rem' }}>
                        Used aircraft are restocked hourly when sold out.
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="am-used-list-label">Select a listing:</div>
                      <div className="am-used-list">
                        <div className="am-ul-header">
                          <span>Kennung</span>
                          <span>Alter</span>
                          <span>Standort</span>
                          <span>Verkäufer</span>
                          <span style={{textAlign:'right'}}>Preis</span>
                        </div>
                        {modalUsedListings.map(l => {
                          const isSelected = selectedUsedListing?.id === l.id;
                          return (
                            <button
                              key={l.id}
                              className={`am-used-listing${isSelected ? ' am-used-listing--selected' : ''}`}
                              onClick={() => setSelectedUsedListing(isSelected ? null : l)}
                            >
                              <span className="am-ul-reg">{l.registration}</span>
                              <span>{fmtAge(l.manufactured_year)}</span>
                              <span>{l.location || '—'}</span>
                              <span style={{ fontSize: '0.78rem', color: l.seller_type === 'player' ? '#2C2C2C' : '#888' }}>
                                {l.seller_type === 'player' && l.seller_airline_code
                                  ? <span style={{ textDecoration: 'underline', textDecorationColor: '#CCC', textUnderlineOffset: 2, cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); setProfilePopupCode(l.seller_airline_code); }}>{l.seller_name}</span>
                                  : l.seller_name}
                              </span>
                              <span className="am-ul-price">{fmt(l.current_value)}</span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}

                  {selectedUsedListing && (
                    <>
                      <div className="am-form-row">
                        <label>Delivery Airport</label>
                        <select value={deliveryAirport} onChange={e => setDeliveryAirport(e.target.value)} className="am-form-select">
                          {Object.entries(airports.reduce((acc, a) => { (acc[a.country] = acc[a.country] || []).push(a); return acc; }, {})).sort(([a],[b]) => a.localeCompare(b)).map(([country, list]) => (
                            <optgroup key={country} label={country}>
                              {list.map(a => (
                                <option key={a.iata_code} value={a.iata_code}>
                                  {a.iata_code} – {a.name}{a.iata_code === airline.home_airport_code ? ' (Home)' : ''}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </div>
                      {cabinProfiles.length > 0 && (
                        <div className="am-form-row">
                          <label>Cabin Profile <span style={{ color:'#999', fontWeight:400 }}>(optional)</span></label>
                          <select value={selectedCabinProfileId} onChange={e => setSelectedCabinProfileId(e.target.value)} className="am-form-select">
                            <option value="">None — assign later</option>
                            {cabinProfiles.map(p => <option key={p.id} value={p.id}>{p.name} ({p.total_capacity} seats)</option>)}
                          </select>
                        </div>
                      )}
                      <div className="am-price-summary">
                        <div className="am-price-row">
                          <span>New price</span>
                          <span style={{ color:'#999', textDecoration:'line-through' }}>{fmt(selectedUsedListing.new_price_usd)}</span>
                        </div>
                        <div className="am-price-row am-price-row--total">
                          <span>Total</span>
                          <span className={canAfford ? 'am-price--ok' : 'am-price--no'}>{fmt(modalCost)}</span>
                        </div>
                        {!canAfford && <p className="am-insufficient">Need {fmt(modalCost - airline.balance)} more.</p>}
                      </div>
                    </>
                  )}
                </>
              )}

              {error && <div className="am-msg am-msg--error" style={{ margin:'0.5rem 0 0' }}>{error}</div>}
              {success && <div className="am-msg am-msg--success" style={{ margin:'0.5rem 0 0' }}>{success}</div>}
            </div>

            <div className="am-modal-foot">
              <button className="am-btn-cancel" onClick={closeModal}>Close</button>
              <button
                className="am-btn-confirm"
                disabled={!canConfirm || purchasing}
                onClick={modalTab === 'new' ? handlePurchaseNew : handlePurchaseUsed}
              >
                {purchasing ? 'Purchasing…' : 'Confirm Purchase'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .am-page { min-height: 100vh; background: #F5F5F5; }

        /* Hero */
        .am-hero {
          width: 100%; height: 240px;
          background: url('/header-images/Headerimage_market.png') center 30% / cover no-repeat;
        }

        .am-container { max-width: 1400px; margin: 0 auto; padding: 2rem; }

        /* Messages */
        .am-msg { padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.9rem; }
        .am-msg--error   { background: #FEE2E2; color: #DC2626; border: 1px solid #FCA5A5; }
        .am-msg--success { background: #D1FAE5; color: #065F46; border: 1px solid #6EE7B7; }

        /* Two-column layout */
        .am-layout { display: grid; grid-template-columns: 230px 1fr; gap: 1.5rem; align-items: start; }

        /* Sidebar */
        .am-sidebar {
          background: white; border-radius: 8px; padding: 1rem;
          box-shadow: 0 2px 8px rgba(0,0,0,0.08); position: sticky; top: 1rem;
        }
        .am-sb-section { margin-bottom: 1.25rem; }
        .am-sb-section:last-child { margin-bottom: 0; }
        .am-sb-label {
          font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
          letter-spacing: 0.1em; color: #999; margin-bottom: 0.5rem;
        }
        .am-sb-search {
          width: 100%; padding: 0.5rem 0.7rem; border: 1px solid #E0E0E0;
          border-radius: 6px; font-size: 0.85rem; background: white; color: #2C2C2C;
          box-sizing: border-box;
        }
        .am-sb-search:focus { outline: none; border-color: #2C2C2C; }
        .am-sb-mfr-item {
          width: 100%; display: flex; justify-content: space-between; align-items: center;
          padding: 0.4rem 0.6rem; border: none; border-radius: 5px; cursor: pointer;
          font-size: 0.82rem; color: #444; background: transparent; text-align: left;
          transition: background 0.12s, color 0.12s;
        }
        .am-sb-mfr-item:hover { background: #F5F5F5; color: #2C2C2C; }
        .am-sb-mfr-item--active { background: #2C2C2C; color: white; font-weight: 600; }
        .am-sb-mfr-count {
          font-size: 0.72rem; opacity: 0.5; background: rgba(0,0,0,0.08);
          padding: 1px 5px; border-radius: 8px;
        }
        .am-sb-mfr-item--active .am-sb-mfr-count { background: rgba(255,255,255,0.2); opacity: 0.8; }
        .am-sb-filter-item {
          width: 100%; padding: 0.35rem 0.6rem; border: none; border-radius: 5px;
          cursor: pointer; font-size: 0.8rem; color: #555; background: transparent; text-align: left;
          transition: background 0.12s, color 0.12s;
        }
        .am-sb-filter-item:hover { background: #F5F5F5; color: #2C2C2C; }
        .am-sb-filter-item--active { background: #2C2C2C; color: white; font-weight: 600; }
        .am-sb-reset {
          width: 100%; padding: 0.45rem; background: #FEE2E2; color: #DC2626;
          border: none; border-radius: 6px; font-size: 0.8rem; font-weight: 600; cursor: pointer;
        }
        .am-sb-reset:hover { background: #FECACA; }

        /* Range slider */
        .am-range-value {
          font-size: 0.78rem; font-weight: 700; color: #2C2C2C;
          text-align: center; margin-bottom: 0.4rem;
        }
        .am-range-row {
          display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.25rem;
        }
        .am-range-sublabel {
          font-size: 0.65rem; color: #999; width: 22px; flex-shrink: 0;
        }
        .am-range-slider {
          flex: 1; accent-color: #2C2C2C; cursor: pointer;
        }
        .am-range-labels {
          display: flex; justify-content: space-between;
          font-size: 0.65rem; color: #BBB; margin-top: 0.1rem;
        }

        /* Manufacturer sections */
        .am-mfr-section { margin-bottom: 1.25rem; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .am-mfr-header {
          display: flex; justify-content: space-between; align-items: center;
          background: #2C2C2C; color: white; padding: 12px 18px;
        }
        .am-mfr-name { font-size: 0.82rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
        .am-mfr-count { font-size: 0.72rem; opacity: 0.55; }
        .am-mfr-body { background: white; padding: 1.25rem; }

        /* Grid */
        .am-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
        @media (max-width: 1300px) { .am-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 900px)  { .am-grid { grid-template-columns: 1fr; } }
        @media (max-width: 480px) {
          .am-hero { height: 160px; }
          .am-container { padding: 1rem 0.75rem; }
          .am-layout { grid-template-columns: 1fr; }
          .am-sidebar { position: static; }
          .am-mfr-body { padding: 0.75rem; }
          .am-card-body { padding: 0.7rem 0.8rem; }
          .am-modal { max-width: 100%; border-radius: 8px; max-height: 95vh; }
          .am-modal-head { padding: 1rem; border-radius: 8px 8px 0 0; }
          .am-modal-body { padding: 1rem; }
          .am-modal-foot { padding: 0.75rem 1rem; flex-direction: column; }
          .am-modal-foot .am-btn-cancel,
          .am-modal-foot .am-btn-confirm { width: 100%; text-align: center; }
          .am-ul-header { display: none; }
          .am-used-listing {
            grid-template-columns: 1fr 1fr;
            gap: 4px 8px; padding: 0.6rem;
          }
          .am-used-listing > *:nth-child(3) { grid-column: 1 / -1; }
          .am-used-listing > *:nth-child(4) { grid-column: 1 / -1; }
        }

        /* Empty state */
        .am-empty {
          background: white; border-radius: 8px; padding: 3rem; text-align: center;
          color: #999; font-size: 0.9rem; box-shadow: 0 2px 8px rgba(0,0,0,0.06);
        }

        /* Cards */
        .am-card {
          background: white; border-radius: 8px; overflow: hidden;
          border: 1px solid #F0F0F0; display: flex; flex-direction: column;
          transition: box-shadow 0.15s, transform 0.15s;
        }
        .am-card:hover { box-shadow: 0 6px 20px rgba(0,0,0,0.12); transform: translateY(-1px); }
        .am-card--locked { opacity: 0.6; }

        .am-card-img-wrap { position: relative; padding-top: 20px; background: white; overflow: hidden; }
        .am-card-img { width: 100%; aspect-ratio: 10/3; object-fit: cover; display: block; }
        .am-card-img-placeholder {
          width: 100%; height: 100%; display: flex; align-items: center;
          justify-content: center; font-size: 2.5rem; color: #CCC;
        }
        .am-lock-overlay {
          position: absolute; inset: 0; background: rgba(0,0,0,0.45);
          display: flex; align-items: center; justify-content: center;
        }
        .am-lock-badge {
          background: rgba(0,0,0,0.75); color: white; font-size: 0.75rem;
          font-weight: 700; padding: 5px 12px; border-radius: 4px;
        }
        .am-used-badge {
          position: absolute; top: 8px; right: 8px;
          background: rgba(100,100,100,0.75); color: #E0E0E0;
          font-size: 0.68rem; font-weight: 600; padding: 3px 8px; border-radius: 4px;
          letter-spacing: 0.03em;
        }


        .am-card-body { padding: 0.9rem 1rem; flex: 1; display: flex; flex-direction: column; gap: 0.6rem; }

        .am-card-header-row { margin-bottom: 2px; }
        .am-card-model    { font-size: 0.95rem; font-weight: 700; color: #1A1A1A; line-height: 1.2; }
        .am-card-fullname { font-size: 0.76rem; color: #888; margin-top: 2px; }

        /* Spec table */
        .am-spec-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
        .am-spec-table td { padding: 3px 0; border-bottom: 1px solid #F5F5F5; color: #555; vertical-align: top; }
        .am-spec-table tr:last-child td { border-bottom: none; }
        .am-spec-table td:first-child { color: #999; width: 48%; }
        .am-spec-table td:last-child  { font-weight: 600; color: #2C2C2C; }

        .am-card-footer {
          display: flex; justify-content: space-between; align-items: center;
          margin-top: auto; padding-top: 0.6rem; border-top: 1px solid #F0F0F0;
        }
        .am-card-price-label { font-size: 0.68rem; color: #999; margin-bottom: 1px; }
        .am-card-price { font-size: 1rem; font-weight: 700; color: #2C2C2C; }
        .am-price--no  { color: #DC2626; }
        .am-price--ok  { color: #16A34A; }
        .am-btn-buy {
          padding: 0.45rem 1rem; background: #2C2C2C; color: white; border: none;
          border-radius: 6px; font-size: 0.82rem; font-weight: 600; cursor: pointer;
          transition: background 0.15s; white-space: nowrap;
        }
        .am-btn-buy:hover:not(:disabled) { background: #1a1a1a; }
        .am-btn-buy:disabled { background: #E0E0E0; color: #999; cursor: not-allowed; }

        /* Modal */
        .am-modal-overlay {
          position: fixed; inset: 0; background: rgba(0,0,0,0.5);
          display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 1rem;
        }
        .am-modal {
          background: white; border-radius: 12px; width: 100%; max-width: 600px;
          max-height: 92vh; overflow-y: auto; display: flex; flex-direction: column;
        }
        .am-modal-head {
          background: #2C2C2C; color: white; padding: 1.25rem 1.5rem;
          display: flex; justify-content: space-between; align-items: flex-start;
          border-radius: 12px 12px 0 0; flex-shrink: 0;
        }
        .am-modal-head-label { font-size: 0.68rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; opacity: 0.55; margin-bottom: 4px; }
        .am-modal-head-title { font-size: 1.15rem; font-weight: 700; margin: 0; }
        .am-modal-close { background: none; border: none; color: white; font-size: 1.5rem; cursor: pointer; line-height: 1; opacity: 0.7; padding: 0; }
        .am-modal-close:hover { opacity: 1; }

        /* Modal tabs */
        .am-modal-tabs { display: flex; border-bottom: 1px solid #F0F0F0; flex-shrink: 0; }
        .am-modal-tab {
          flex: 1; padding: 0.75rem 1rem; background: none; border: none; cursor: pointer;
          font-size: 0.85rem; font-weight: 600; color: #999; border-bottom: 2px solid transparent;
          transition: color 0.15s; display: flex; align-items: center; justify-content: center; gap: 0.4rem;
        }
        .am-modal-tab:hover { color: #2C2C2C; }
        .am-modal-tab--active { color: #2C2C2C; border-bottom-color: #2C2C2C; }
        .am-modal-tab-badge {
          background: #999; color: white; font-size: 0.65rem;
          padding: 1px 5px; border-radius: 8px;
        }

        .am-modal-body { padding: 1.25rem 1.5rem; display: flex; flex-direction: column; gap: 0.9rem; overflow-y: auto; }
        .am-modal-img { width: 100%; aspect-ratio: 16/5; object-fit: cover; border-radius: 6px; }

        /* Used listings in modal */
        .am-used-empty {
          text-align: center; padding: 1.5rem; background: #F9F9F9; border-radius: 8px;
          color: #666; font-size: 0.88rem;
        }
        .am-used-empty-icon { font-size: 2rem; margin-bottom: 0.5rem; opacity: 0.4; }
        .am-used-list-label { font-size: 0.78rem; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.05em; }
        .am-used-list { display: flex; flex-direction: column; gap: 2px; }
        .am-ul-header {
          display: grid; grid-template-columns: 1fr 0.8fr 0.8fr 1.2fr 0.8fr;
          padding: 0.3rem 0.7rem; font-size: 0.68rem; font-weight: 700;
          color: #999; text-transform: uppercase; letter-spacing: 0.05em;
        }
        .am-used-listing {
          width: 100%; display: grid; grid-template-columns: 1fr 0.8fr 0.8fr 1.2fr 0.8fr;
          padding: 0.55rem 0.7rem; border: 1.5px solid transparent;
          border-radius: 6px; background: #F7F7F7; cursor: pointer; text-align: left;
          font-size: 0.82rem; color: #666; align-items: center;
          transition: border-color 0.12s, background 0.12s;
        }
        .am-used-listing:hover { border-color: #CCC; background: #F0F0F0; color: #444; }
        .am-used-listing--selected { border-color: #888; background: #EBEBEB; color: #333; }
        .am-ul-reg { font-weight: 700; color: #444; font-family: monospace; font-size: 0.85rem; }
        .am-ul-price { font-weight: 700; color: #555; text-align: right; }

        .am-form-row { display: flex; flex-direction: column; gap: 0.3rem; }
        .am-form-row label { font-size: 0.82rem; font-weight: 600; color: #444; }
        .am-form-input, .am-form-select {
          padding: 0.5rem 0.75rem; border: 1px solid #E0E0E0; border-radius: 6px;
          font-size: 0.9rem; background: white; color: #2C2C2C;
        }
        .am-form-input:focus, .am-form-select:focus { outline: none; border-color: #2C2C2C; }

        .am-price-summary { background: #F9F9F9; border-radius: 8px; padding: 0.9rem 1rem; }
        .am-price-row { display: flex; justify-content: space-between; font-size: 0.9rem; color: #555; padding: 0.2rem 0; }
        .am-price-row--total { font-size: 1.05rem; font-weight: 700; color: #2C2C2C; border-top: 1px solid #E0E0E0; margin-top: 0.4rem; padding-top: 0.5rem; }
        .am-insufficient { font-size: 0.82rem; color: #DC2626; margin: 0.4rem 0 0; }

        .am-modal-foot { padding: 1rem 1.5rem; display: flex; gap: 0.75rem; justify-content: flex-end; border-top: 1px solid #F0F0F0; flex-shrink: 0; }
        .am-btn-cancel { padding: 0.5rem 1.25rem; background: white; border: 1px solid #E0E0E0; border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
        .am-btn-cancel:hover { border-color: #2C2C2C; }
        .am-btn-confirm { padding: 0.5rem 1.5rem; background: #2C2C2C; color: white; border: none; border-radius: 6px; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
        .am-btn-confirm:hover:not(:disabled) { background: #1a1a1a; }
        .am-btn-confirm:disabled { background: #E0E0E0; color: #999; cursor: not-allowed; }
      `}</style>

      {profilePopupCode && (
        <AirlineProfilePopup airlineCode={profilePopupCode} onClose={() => setProfilePopupCode(null)} />
      )}
    </div>
  );
}
