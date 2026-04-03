import { useState, useEffect, useCallback, useMemo } from 'react';
import AirportLink from '../components/AirportLink.jsx';
import TopBar from '../components/TopBar.jsx';
import Toast from '../components/Toast.jsx';
import { calculateCurrentValue, formatAircraftValue } from '../utils/aircraftValue.js';
import SatisfactionRating, { getSatColor, scoreToRating } from '../components/SatisfactionRating.jsx';



const FEEDBACK_POOLS = {
  bev: {
    0: ["Not a single drink was offered. Truly unacceptable.","No beverages at all on this flight. Hard to believe.","I had nothing to drink the entire flight.","Zero drink options. Won't be flying this airline again."],
    1: ["Only one drink option on a flight this long — disappointing.","A bit more variety in drinks would go a long way.","One beverage choice felt very limited for this route.","Expected more drink options. Felt like a budget experience."],
    2: ["Decent selection, but still missing something for this distance.","Two drinks is okay, but a flight this long deserves more.","Could use one more beverage option on a route like this.","Almost there on drinks — just one option short."],
  },
  food: {
    0: ["Not a single thing to eat. Absolutely nothing.","No food whatsoever on this flight. Unbelievable.","I was starving the entire journey. No food at all.","Zero food offered. This is not okay."],
    1: ["One meal for this distance? Still hungry when we landed.","Expected a second meal on such a long flight.","A single snack doesn't cut it for a flight this long.","One meal is simply not enough. Left the plane hungry."],
    2: ["Two meals helped, but a flight this long really needs more.","Almost enough food — could use one more service.","Good effort on food, but we needed one more meal.","Third meal service would have made a real difference here."],
  },
  amenity: ["No amenity kit at all. Felt very bare-bones.","Would have appreciated at least a toothbrush on this flight.","No amenity kit in this cabin class? Feels cheap.","A small amenity kit would've made this flight much more comfortable."],
  sleep:   ["Couldn't sleep a minute — a blanket would've helped enormously.","10 hours with no pillow or blanket. My back is wrecked.","No sleep kit on an overnight flight. Truly a miss.","A pillow and blanket should be standard on a flight this long."],
  ent:     ["Hours with nothing to watch. Felt like forever.","No entertainment system on this route? Hard to believe.","Stared at the seat in front of me the whole flight.","No IFE on a long-haul is simply not acceptable anymore."],
  lug: {
    1: ["Only cabin baggage included on this distance? Ridiculous.","Had to pay extra just to bring a normal suitcase.","No checked luggage included — felt very restrictive.","Expected at least a checked bag to be included on this route."],
    2: ["The luggage allowance was too small for a trip this long.","Had to leave half my clothes at home due to luggage limits.","A larger bag allowance would be appreciated on this route.","Luggage restrictions made packing for this trip a nightmare."],
  },
  seat_eco: ["Sat upright for 10 hours. Never again.","An upright seat on this distance is genuinely painful.","My back is completely destroyed. Upgrade the seats.","Could not sleep at all in this seat. Far too uncomfortable."],
  seat_biz: ["Expected a lie-flat in business on this route. Very disappointing.","Business class should mean a proper flat bed on long haul.","Paid business class prices for what felt like a premium economy seat.","No lie-flat in business on this distance is hard to justify."],
  seat_fir: ["First class without a suite on this route felt underwhelming.","Expected full suite privacy in first class. Didn't get it.","A suite is the minimum expectation in first on this distance.","First class should mean a suite. This fell short."],
  maint:   ["The seat was broken the entire flight.","Everything felt worn out and poorly maintained.","Multiple things weren't working properly. Felt unsafe.","The cabin looked and felt like it hadn't been serviced in years."],
};

function seededRand(seed) {
  let s = seed >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
  s = (s ^ (s >>> 16)) >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0x100000000; };
}

const CABIN_SHORT = { economy: 'E', business: 'B', first: 'F', premium_economy: 'PE' };
const RULE_CABIN  = { seat_eco: ['economy'], seat_biz: ['business'], seat_fir: ['first'] };

/** Returns up to 3 feedback entries { msg, cabins } seeded by flightId. */
function getFeedbackMessages(violations, flightId) {
  if (!violations || violations.length === 0) return [];
  const rand = seededRand(flightId || 0);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const messages = [];
  for (const v of violations.slice(0, 3)) {
    const { rule, have, cabins } = v;
    let pool = null;
    if (rule === 'bev')  pool = FEEDBACK_POOLS.bev[Math.min(have ?? 0, 2)];
    else if (rule === 'food') pool = FEEDBACK_POOLS.food[Math.min(have ?? 0, 2)];
    else if (rule === 'lug')  pool = FEEDBACK_POOLS.lug[Math.min(Math.max(have ?? 1, 1), 2)];
    else if (FEEDBACK_POOLS[rule] && Array.isArray(FEEDBACK_POOLS[rule])) pool = FEEDBACK_POOLS[rule];
    if (pool && pool.length > 0) {
      const resolvedCabins = RULE_CABIN[rule] || cabins || [];
      messages.push({ msg: pick(pool), cabins: resolvedCabins });
    }
  }
  return messages;
}

const API_URL = import.meta.env.VITE_API_URL || '';

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_FULL  = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const HOUR_H    = 60;           // px per hour (1 px per minute)
const PX_PER_MIN = HOUR_H / 60; // 1.5 px per minute
const TOTAL_H   = 24 * HOUR_H;  // 2160 px
const GUTTER_W  = 38;
const WAKE_TURNAROUND = { L: 25, M: 40, H: 60 };
const COLORS = [
  '#4a6cf7','#e53e3e','#38a169','#d69e2e','#9f7aea',
  '#ed8936','#3182ce','#e53e8e','#319795','#805ad5',
];

// Parse "HH:MM" → total minutes since midnight
function parseHM(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

// Total minutes since midnight → "HH:MM"
function minsToHM(mins) {
  const total = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// Add minutes to "HH:MM" → "HH:MM"
function addMins(hm, add) {
  return minsToHM(parseHM(hm) + add);
}

function minutesToHM(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function clampHour(v) {
  const n = parseInt(String(v).replace(/\D/g, '').slice(0, 2));
  return isNaN(n) ? '00' : String(Math.min(23, Math.max(0, n))).padStart(2, '0');
}
function clampMinute(v) {
  const n = parseInt(String(v).replace(/\D/g, '').slice(0, 2));
  return isNaN(n) ? '00' : String(Math.min(59, Math.max(0, n))).padStart(2, '0');
}

const CLASS_SHORT = {
  economy: 'E',
  premium_economy: 'PE',
  business: 'B',
  first: 'F',
  first_suite: 'FS',
};

// ── Flight status computation (time-based) ───────────────────────────────────
function computeDepStatus(depISO, now) {
  const dep = new Date(depISO).getTime();
  const diffMin = (dep - now) / 60000;
  if (diffMin > 60)  return { label: 'Scheduled', cls: 'scheduled', color: '#9ca3af' };
  if (diffMin > 30)  return { label: 'On Time',   cls: 'ontime',    color: '#22c55e' };
  if (diffMin > 3)   return { label: 'Boarding',  cls: 'boarding',  color: '#eab308' };
  if (diffMin >= 0)  return { label: 'Taxiing',   cls: 'taxiing',   color: '#eab308' };
  if (diffMin >= -1) return { label: 'Departed',  cls: 'departed',  color: '#22c55e' };
  return { label: 'Departed', cls: 'departed', color: '#22c55e' };
}

function computeArrStatus(depISO, arrISO, now) {
  const dep = depISO ? new Date(depISO).getTime() : null;
  const arr = new Date(arrISO).getTime();
  const diffToArr = (arr - now) / 60000;
  if (dep && now < dep) return { label: 'On Ground', cls: 'ontime',    color: '#22c55e' };
  if (diffToArr > 5)    return { label: 'In Flight', cls: 'inflight',  color: '#9ca3af' };
  if (diffToArr >= 0)   return { label: 'Approach',  cls: 'boarding',  color: '#eab308' };
  return { label: 'Landed', cls: 'ontime', color: '#22c55e' };
}

function StatusDot({ cls, pulse }) {
  return <span className={`ad-status-dot ad-status-dot--${cls}${pulse ? ' ad-status-dot--pulse' : ''}`} />;
}

function FlightProgress({ flight, onNavigate }) {
  const now    = Date.now();
  const dep    = new Date(flight.departure_time).getTime();
  const arr    = new Date(flight.arrival_time).getTime();
  const total  = arr - dep;
  const pct    = total > 0 ? Math.max(0, Math.min(100, ((now - dep) / total) * 100)) : 0;
  const remMs  = Math.max(0, arr - now);
  const remH   = Math.floor(remMs / 3600000);
  const remM   = Math.floor((remMs % 3600000) / 60000);
  const timeStr = remMs > 0 ? `${remH}h ${String(remM).padStart(2,'0')}m remaining` : 'Landing';
  const arrSt = computeArrStatus(flight.departure_time, flight.arrival_time, now);
  return (
    <div className="ad-fp-wrap">
      <div className="ad-fp-route">
        <div className="ad-fp-apt">
          <button className="ad-apt-link ad-fp-code" onClick={() => onNavigate?.(flight.departure_airport)}>{flight.departure_airport}</button>
          <span className="ad-fp-apt-name">{flight.departure_name}</span>
        </div>
        <div className="ad-fp-apt ad-fp-apt-r">
          <button className="ad-apt-link ad-fp-code" onClick={() => onNavigate?.(flight.arrival_airport)}>{flight.arrival_airport}</button>
          <span className="ad-fp-apt-name">{flight.arrival_name}</span>
        </div>
      </div>
      <div className="ad-fp-bar">
        <div className="ad-fp-line" />
        <span className="ad-fp-plane" style={{ left: `calc(${pct}% - 9px)` }}>✈</span>
      </div>
      <div className="ad-fp-meta">
        <StatusDot cls={arrSt.cls} pulse={arrSt.cls === 'inflight'} />
        <span className="ad-fp-status-label" style={{ color: arrSt.color }}>{arrSt.label}</span>
        <span className="ad-fp-fn" style={{ marginLeft: 'auto' }}>{flight.flight_number}</span>
        <span className="ad-fp-time">{timeStr}</span>
      </div>
    </div>
  );
}

function AircraftDetail({ aircraftId, airline, onBack, onNavigateToAirport }) {
  // Aircraft metadata
  const [aircraft, setAircraft]         = useState(null);
  const [cabinProfile, setCabinProfile] = useState(null);
  const [cabinProfiles, setCabinProfiles] = useState([]);
  const [userCabinProfiles, setUserCabinProfiles] = useState([]);
  const [selectedCabinProfileId, setSelectedCabinProfileId] = useState(null);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState('');
  const [success, setSuccess]           = useState('');
  const [editName, setEditName]         = useState('');
  const [nameSaving, setNameSaving]     = useState(false);
  const [editHomebase, setEditHomebase] = useState('');
  const [homebaseSaving, setHomebaseSaving] = useState(false);
  const [airports, setAirports]         = useState([]);
  const [currentFlight, setCurrentFlight] = useState(null);
  const [currentLocation, setCurrentLocation] = useState(null);
  const [stats, setStats]               = useState({ total_flights: 0, total_profit: 0 });

  // Schedule template data
  const [routes, setRoutes]         = useState([]);
  const [schedule, setSchedule]     = useState([]);  // weekly_schedule entries
  const [maintenance, setMaintenance] = useState([]);
  const [isActive, setIsActive] = useState(0);
  // Cabin profile change warning modal state
  const [showCpChangeModal, setShowCpChangeModal] = useState(false);
  const [pendingCpChangeId, setPendingCpChangeId] = useState(null);
  // Slot capacity exceeded modal
  const [slotViolations, setSlotViolations] = useState(null); // null=hidden, array=shown
  const [scheduleLoading, setScheduleLoading] = useState(false);

  // Generated scheduled flights (upcoming instances)
  const [scheduledFlights, setScheduledFlights] = useState([]);

  // Show Flight modal
  const [showFlightModal, setShowFlightModal] = useState(false);
  const [selectedFlight, setSelectedFlight] = useState(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const [crewAssigned, setCrewAssigned] = useState(0);
  const [crewHiring, setCrewHiring] = useState(false);

  const [showScrapModal, setShowScrapModal] = useState(false);
  const [scrapping, setScrapping] = useState(false);
  const [sellingToMarket, setSellingToMarket] = useState(false);

  // Form
  const [scheduleTab, setScheduleTab] = useState('single');
  const [submitting, setSubmitting]   = useState(false);

  // Service profiles
  const [serviceProfiles, setServiceProfiles] = useState([]);

  // Single flight form
  const [sRouteId, setSRouteId]     = useState('');
  const [sDay, setSDay]             = useState('0');
  const [sDepHour, setSDepHour]     = useState('08');
  const [sDepMinute, setSDepMinute] = useState('00');
  const [sEcoPrice, setSEcoPrice]   = useState('');
  const [sBizPrice, setSBizPrice]   = useState('');
  const [sFirstPrice, setSFirstPrice] = useState('');
  const [sServiceProfileId, setSServiceProfileId] = useState('');

  // Series flight form
  const [outRouteId, setOutRouteId]   = useState('');
  const [inRouteId, setInRouteId]     = useState('');
  const [rDay, setRDay]               = useState('0');
  const [rDepHour, setRDepHour]       = useState('08');
  const [rDepMinute, setRDepMinute]   = useState('00');
  const [rEcoPrice, setREcoPrice]     = useState('');
  const [rBizPrice, setRBizPrice]     = useState('');
  const [rFirstPrice, setRFirstPrice] = useState('');
  const [rServiceProfileId, setRServiceProfileId] = useState('');
  const [turnaroundGap, setTurnaroundGap] = useState(0);
  const [repeatCount, setRepeatCount]     = useState(1);

  const groundMin = useMemo(
    () => WAKE_TURNAROUND[aircraft?.wake_turbulence_category] ?? 40,
    [aircraft?.wake_turbulence_category]
  );

  // Maintenance form
  const [mDay, setMDay]               = useState('0');
  const [mStartHour, setMStartHour]   = useState('08');
  const [mStartMinute, setMStartMinute] = useState('00');

  // Transfer flight modal
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [transferCountry, setTransferCountry]     = useState('');
  const [transferAirport, setTransferAirport]     = useState('');
  const [transferDate, setTransferDate]           = useState('');
  const [transferTimeH, setTransferTimeH]         = useState('08');
  const [transferTimeM, setTransferTimeM]         = useState('00');
  const [transferSubmitting, setTransferSubmitting] = useState(false);
  const [allAirports, setAllAirports]             = useState([]);

  // Edit modal
  const [editEntry, setEditEntry]       = useState(null);
  const [editDay, setEditDay]           = useState(0);
  const [editHour, setEditHour]         = useState('08');
  const [editMinute, setEditMinute]     = useState('00');
  const [editEcoPrice, setEditEcoPrice] = useState('');
  const [editBizPrice, setEditBizPrice] = useState('');
  const [editFirstPrice, setEditFirstPrice] = useState('');
  const [editServiceProfileId, setEditServiceProfileId] = useState('');
  const [editSubmitting, setEditSubmitting] = useState(false);

  const selectedProfile = userCabinProfiles.find(p => p.id === selectedCabinProfileId);
  const hasBusiness = selectedProfile?.classes?.some(c => c.class_type === 'business' && c.actual_capacity > 0) ?? false;
  const hasFirst    = selectedProfile?.classes?.some(c => c.class_type === 'first'    && c.actual_capacity > 0) ?? false;

  const CABIN_CREW_RATIOS = { economy: 30, premium_economy: 30, business: 12, first: 6, first_suite: 4 };
  const cabinCrewCount = useMemo(() => {
    if (!selectedProfile) return 5;
    let total = 0;
    for (const cls of (selectedProfile.classes || [])) {
      if (cls.actual_capacity > 0) {
        total += Math.ceil(cls.actual_capacity / (CABIN_CREW_RATIOS[cls.class_type] || 50));
      }
    }
    return Math.max(2, Math.min(25, total));
  }, [selectedProfile]);

  const token = localStorage.getItem('token');
  const headers     = { 'Authorization': `Bearer ${token}` };
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  // ─── Fetchers ───────────────────────────────────────────────────────────────

  const fetchDetail = useCallback(async () => {
    try {
      const res  = await fetch(`${API_URL}/api/aircraft/${aircraftId}/detail`, { headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setAircraft(data.aircraft);
      setCabinProfile(data.cabin_profile);
      setSelectedCabinProfileId(data.aircraft.airline_cabin_profile_id ?? null);
      setIsActive(data.aircraft.is_active ?? 0);
      setEditName(data.aircraft.name || '');
      setEditHomebase(data.aircraft.home_airport || '');
      setCurrentFlight(data.current_flight || null);
      setCurrentLocation(data.current_location || null);
      setStats(data.stats || { total_flights: 0, total_profit: 0 });
      setCrewAssigned(data.aircraft.crew_assigned ?? 0);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [aircraftId]);

  const fetchCabinProfiles = useCallback(async (typeId) => {
    if (!typeId) return;
    try {
      const res  = await fetch(`${API_URL}/api/cabin-profiles/for-type/${typeId}`, { headers });
      const data = await res.json();
      if (res.ok) setUserCabinProfiles(data.profiles || []);
    } catch {}
  }, []);

  const fetchAirports = useCallback(async () => {
    try {
      const res  = await fetch(`${API_URL}/api/destinations/opened`, { headers });
      const data = await res.json();
      if (res.ok) setAirports(data.airports || []);
    } catch {}
  }, []);

  const fetchAllAirports = useCallback(async () => {
    try {
      const res  = await fetch(`${API_URL}/api/airports`, { headers });
      const data = await res.json();
      if (res.ok) setAllAirports(data.airports || []);
    } catch {}
  }, []);

  const fetchSchedule = useCallback(async () => {
    setScheduleLoading(true);
    try {
      const res  = await fetch(`${API_URL}/api/aircraft/${aircraftId}/schedule`, { headers });
      const data = await res.json();
      if (res.ok) {
        setSchedule(data.schedule || []);
        setRoutes(data.routes || []);
        setMaintenance(data.maintenance || []);
        if (data.aircraft) setIsActive(data.aircraft.is_active ?? 0);
      }
    } catch {}
    finally { setScheduleLoading(false); }
  }, [aircraftId]);

  useEffect(() => {
    fetchDetail();
    fetchAirports();
    fetchAllAirports();
  }, [fetchDetail, fetchAirports, fetchAllAirports]);

  useEffect(() => {
    if (aircraft?.type_id) fetchCabinProfiles(aircraft.type_id);
  }, [aircraft?.type_id, fetchCabinProfiles]);

  useEffect(() => { fetchSchedule(); }, [fetchSchedule]);

  useEffect(() => {
    fetch(`${API_URL}/api/service-profiles`, { headers })
      .then(r => r.json())
      .then(d => setServiceProfiles(d.profiles || []))
      .catch(() => {});
  }, []);

  const fetchScheduledFlights = useCallback(async () => {
    try {
      const res  = await fetch(`${API_URL}/api/aircraft/${aircraftId}/flights`, { headers });
      const data = await res.json();
      if (res.ok) setScheduledFlights(data.flights || []);
    } catch {}
  }, [aircraftId]);

  useEffect(() => {
    fetchScheduledFlights();
    const iv = setInterval(fetchScheduledFlights, 30000);
    return () => clearInterval(iv);
  }, [fetchScheduledFlights]);

  // ─── Auto-suggest ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (outRouteId) {
      const out = routes.find(r => r.id === parseInt(outRouteId));
      if (out) {
        const reverse = routes.find(r =>
          r.departure_airport === out.arrival_airport && r.arrival_airport === out.departure_airport
        );
        if (reverse && !inRouteId) setInRouteId(String(reverse.id));
      }
    }
  }, [outRouteId]);

  useEffect(() => {
    if (sRouteId) {
      const r = routes.find(r => r.id === parseInt(sRouteId));
      if (r) {
        setSEcoPrice(r.economy_price ? String(r.economy_price) : '');
        if (hasBusiness) setSBizPrice(r.business_price ? String(r.business_price) : '');
        if (hasFirst)    setSFirstPrice(r.first_price   ? String(r.first_price)   : '');
      }
    }
  }, [sRouteId]);

  useEffect(() => {
    if (outRouteId) {
      const r = routes.find(r => r.id === parseInt(outRouteId));
      if (r) {
        setREcoPrice(r.economy_price ? String(r.economy_price) : '');
        if (hasBusiness) setRBizPrice(r.business_price ? String(r.business_price) : '');
        if (hasFirst)    setRFirstPrice(r.first_price   ? String(r.first_price)   : '');
      }
    }
  }, [outRouteId]);

  // ─── Computed: flight bars ────────────────────────────────────────────────

  const flightBars = useMemo(() => {
    const flightColor = isActive ? '#22c55e' : '#fca5a5';
    const flightTextColor = isActive ? '#fff' : '#7f1d1d';
    return schedule.map(entry => {
      const depMin = parseHM(entry.departure_time);
      const arrMin = parseHM(entry.arrival_time);
      const dur    = ((arrMin - depMin) + 1440) % 1440 || 1;
      const crossesMidnight = depMin + dur > 1440;
      const seg1H = crossesMidnight ? (1440 - depMin) * PX_PER_MIN : dur * PX_PER_MIN;
      return {
        ...entry,
        dayIndex: entry.day_of_week,
        top:      depMin * PX_PER_MIN,
        height:   Math.max(seg1H, 14),
        crossesMidnight,
        overflowDayIndex: crossesMidnight ? (entry.day_of_week + 1) % 7 : null,
        overflowHeight:   crossesMidnight ? Math.max(arrMin * PX_PER_MIN, 14) : 0,
        groundDayIndex:   crossesMidnight ? (entry.day_of_week + 1) % 7 : entry.day_of_week,
        groundTop: arrMin * PX_PER_MIN,
        color:    flightColor,
        textColor: flightTextColor,
      };
    });
  }, [schedule, isActive]);

  const conflictIds = useMemo(() => {
    const ids = new Set();
    for (let i = 0; i < flightBars.length; i++) {
      for (let j = i + 1; j < flightBars.length; j++) {
        const a = flightBars[i], b = flightBars[j];
        if (a.dayIndex !== b.dayIndex) continue;
        const aDepMin = parseHM(a.departure_time), aArrMin = parseHM(a.arrival_time);
        const bDepMin = parseHM(b.departure_time), bArrMin = parseHM(b.arrival_time);
        if (aDepMin < bArrMin + groundMin && bDepMin < aArrMin + groundMin) {
          ids.add(a.id); ids.add(b.id);
        }
      }
    }
    return ids;
  }, [flightBars]);

  const maintBars = useMemo(() => maintenance.map(m => {
    const crossesMidnight = m.start_minutes + m.duration_minutes > 1440;
    const seg1H = crossesMidnight ? (1440 - m.start_minutes) * PX_PER_MIN : m.duration_minutes * PX_PER_MIN;
    return {
      ...m,
      dayIndex: m.day_of_week,
      top:    m.start_minutes * PX_PER_MIN,
      height: Math.max(seg1H, 14),
      crossesMidnight,
      overflowDayIndex: crossesMidnight ? (m.day_of_week + 1) % 7 : null,
      overflowHeight:   crossesMidnight ? Math.max((m.start_minutes + m.duration_minutes - 1440) * PX_PER_MIN, 14) : 0,
    };
  }), [maintenance]);

  // ─── Series preview (pure time arithmetic — no Date objects) ─────────────

  const seriesPreview = useMemo(() => {
    if (scheduleTab !== 'series' || !outRouteId) return [];
    const outRoute = routes.find(r => r.id === parseInt(outRouteId));
    const inRoute  = inRouteId ? routes.find(r => r.id === parseInt(inRouteId)) : null;
    if (!outRoute) return [];

    const startDepMin = parseHM(`${rDepHour.padStart(2,'0')}:${rDepMinute.padStart(2,'0')}`);
    const preview = [];

    if (rDay === 'all') {
      // Every Day: chain repeatCount round trips per day, for all 7 days
      const reps = Math.max(1, Math.min(parseInt(repeatCount) || 1, 200));
      for (let d = 0; d < 7; d++) {
        let curAbs = startDepMin;
        for (let i = 0; i < reps; i++) {
          const outArrAbs = curAbs + outRoute.estimated_duration;
          preview.push({ type: 'out', route: outRoute, dep: minsToHM(curAbs), arr: minsToHM(outArrAbs), day: d });
          let nextAbs;
          if (inRoute) {
            const inDepAbs = turnaroundGap > 0
              ? Math.ceil((outArrAbs + groundMin) / turnaroundGap) * turnaroundGap
              : outArrAbs + groundMin;
            const inArrAbs = inDepAbs + inRoute.estimated_duration;
            preview.push({ type: 'in', route: inRoute, dep: minsToHM(inDepAbs), arr: minsToHM(inArrAbs), day: d });
            nextAbs = inArrAbs + groundMin;
          } else {
            nextAbs = outArrAbs + groundMin;
          }
          curAbs = turnaroundGap > 0
            ? Math.ceil(nextAbs / turnaroundGap) * turnaroundGap
            : nextAbs;
        }
      }
    } else {
      // Chain round trips consecutively; wrap to next day when midnight is crossed.
      // All arithmetic in absolute minutes (can exceed 1440) so day boundaries are detected correctly.
      const reps = Math.max(1, Math.min(parseInt(repeatCount) || 1, 200));
      const startDay = parseInt(rDay);
      let curAbs = startDepMin; // absolute minutes from start of the selected day

      for (let i = 0; i < reps; i++) {
        const outArrAbs = curAbs + outRoute.estimated_duration;
        // Day index: how many full days have elapsed since startDay
        const outDay = (startDay + Math.floor(curAbs / 1440)) % 7;
        preview.push({ type: 'out', route: outRoute, dep: minsToHM(curAbs), arr: minsToHM(outArrAbs), day: outDay });

        let nextAbs;
        if (inRoute) {
          const inDepAbs = turnaroundGap > 0
            ? Math.ceil((outArrAbs + groundMin) / turnaroundGap) * turnaroundGap
            : outArrAbs + groundMin;
          const inArrAbs = inDepAbs + inRoute.estimated_duration;
          const inDay = (startDay + Math.floor(inDepAbs / 1440)) % 7;
          preview.push({ type: 'in', route: inRoute, dep: minsToHM(inDepAbs), arr: minsToHM(inArrAbs), day: inDay });
          nextAbs = inArrAbs + groundMin;
        } else {
          nextAbs = outArrAbs + groundMin;
        }

        curAbs = turnaroundGap > 0
          ? Math.ceil(nextAbs / turnaroundGap) * turnaroundGap
          : nextAbs;
      }
    }

    return preview;
  }, [scheduleTab, outRouteId, inRouteId, rDay, rDepHour, rDepMinute, turnaroundGap, repeatCount, routes, groundMin]);

  const seriesHasConflict = useMemo(() => {
    return seriesPreview.some(pf => {
      const pfDep = parseHM(pf.dep), pfArr = parseHM(pf.arr);
      return schedule.some(ef => {
        if (ef.day_of_week !== pf.day) return false;
        const efDep = parseHM(ef.departure_time), efArr = parseHM(ef.arrival_time);
        return pfDep < efArr + groundMin && efDep < pfArr + groundMin;
      });
    });
  }, [seriesPreview, schedule]);

  // How many round trips fit in a full week (7 × 1440 min) with current settings.
  // Simulates the actual chain (same snap logic as seriesPreview) starting from 0
  // to get the exact count regardless of turnaroundGap alignment.
  const tripsPerWeek = useMemo(() => {
    if (!outRouteId) return null;
    const outRoute = routes.find(r => r.id === parseInt(outRouteId));
    if (!outRoute) return null;
    const inRoute = inRouteId ? routes.find(r => r.id === parseInt(inRouteId)) : null;
    const snap = (abs) => turnaroundGap > 0
      ? Math.ceil(abs / turnaroundGap) * turnaroundGap
      : abs;
    const startMin = parseHM(`${rDepHour.padStart(2,'0')}:${rDepMinute.padStart(2,'0')}`);
    const weekEnd = startMin + 7 * 1440;
    let cur = startMin;
    let count = 0;
    while (count < 10000) {
      if (cur >= weekEnd) break;
      const outArr = cur + outRoute.estimated_duration;
      let nextCur;
      if (inRoute) {
        const inDep = snap(outArr + groundMin);
        nextCur = snap(inDep + inRoute.estimated_duration + groundMin);
      } else {
        nextCur = snap(outArr + groundMin);
      }
      // Only count if the full trip (incl. turnaround) completes before the week repeats
      if (nextCur > weekEnd) break;
      cur = nextCur;
      count++;
    }
    return count;
  }, [outRouteId, inRouteId, routes, groundMin, turnaroundGap, rDepHour, rDepMinute]);

  const tripsPerDay = useMemo(() => {
    if (!outRouteId) return null;
    const outRoute = routes.find(r => r.id === parseInt(outRouteId));
    if (!outRoute) return null;
    const inRoute = inRouteId ? routes.find(r => r.id === parseInt(inRouteId)) : null;
    const snap = (abs) => turnaroundGap > 0
      ? Math.ceil(abs / turnaroundGap) * turnaroundGap
      : abs;
    const startMin = parseHM(`${rDepHour.padStart(2,'0')}:${rDepMinute.padStart(2,'0')}`);
    const dayEnd = startMin + 1440;
    let cur = startMin;
    let count = 0;
    while (count < 10000) {
      if (cur >= dayEnd) break;
      const outArr = cur + outRoute.estimated_duration;
      let nextCur;
      if (inRoute) {
        const inDep = snap(outArr + groundMin);
        nextCur = snap(inDep + inRoute.estimated_duration + groundMin);
      } else {
        nextCur = snap(outArr + groundMin);
      }
      // Only count if the full trip (incl. turnaround) completes before the day repeats
      if (nextCur > dayEnd) break;
      cur = nextCur;
      count++;
    }
    return count;
  }, [outRouteId, inRouteId, routes, groundMin, turnaroundGap, rDepHour, rDepMinute]);

  // Clamp repeatCount whenever the effective maximum changes
  useEffect(() => {
    const limit = rDay === 'all' ? tripsPerDay : tripsPerWeek;
    if (limit != null) setRepeatCount(c => Math.max(1, Math.min(limit, c)));
  }, [tripsPerWeek, tripsPerDay, rDay]);

  // ─── Handlers ────────────────────────────────────────────────────────────────

  const handleCabinProfileChange = (profileId) => {
    // Calculate what would be cancelled & penalty from current scheduled flights
    const profileIdValue = profileId ? parseInt(profileId) : null;
    const now = Date.now();
    const threeDaysFromNow = now + 3 * 24 * 3600 * 1000;
    const flightsToCancel = scheduledFlights.filter(f => {
      const dep = new Date(f.departure_time).getTime();
      return dep >= now && dep <= threeDaysFromNow &&
             f.status !== 'completed' && f.status !== 'cancelled';
    });
    const penalty = Math.round(flightsToCancel.reduce((sum, f) => {
      return sum +
        (f.booked_economy  || 0) * (f.economy_price  || 0) * 1.2 +
        (f.booked_business || 0) * (f.business_price || f.economy_price || 0) * 1.2 +
        (f.booked_first    || 0) * (f.first_price    || f.economy_price || 0) * 1.2;
    }, 0));

    // Find new profile capacity
    const newProfile = userCabinProfiles.find(p => p.id === profileIdValue);
    const currentProfile = userCabinProfiles.find(p => p.id === selectedCabinProfileId);
    const calcCap = (p) => p?.classes?.reduce((s, c) => s + (c.actual_capacity || 0), 0) ?? 0;
    const oldCap = calcCap(currentProfile);
    const newCap = calcCap(newProfile);

    setPendingCpChangeId(profileIdValue);
    setShowCpChangeModal({ flightsToCancel: flightsToCancel.length, penalty, oldCap, newCap });
  };

  const confirmCabinProfileChange = async () => {
    const profileIdValue = pendingCpChangeId;
    const previous = selectedCabinProfileId;
    setShowCpChangeModal(false);
    setSelectedCabinProfileId(profileIdValue);
    setAircraft(prev => ({ ...prev, airline_cabin_profile_id: profileIdValue }));
    setIsActive(0);
    setError('');
    try {
      const res = await fetch(`${API_URL}/api/aircraft/${aircraftId}/airline-cabin-profile`, {
        method: 'PATCH', headers: jsonHeaders,
        body: JSON.stringify({ profile_id: profileIdValue })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const msgs = ['Cabin profile updated. Aircraft deactivated.'];
      if (data.cancelled_flights > 0) msgs.push(`${data.cancelled_flights} flight(s) cancelled.`);
      if (data.penalty > 0) msgs.push(`Penalty: $${data.penalty.toLocaleString()}`);
      setSuccess(msgs.join(' '));
      fetchSchedule();
      setTimeout(() => setSuccess(''), 5000);
    } catch (err) {
      setSelectedCabinProfileId(previous);
      setAircraft(prev => ({ ...prev, airline_cabin_profile_id: previous }));
      setError(err.message);
    }
    setPendingCpChangeId(null);
  };

  const handleNameSave = async () => {
    if (editName === (aircraft?.name || '')) return;
    setNameSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/aircraft/${aircraftId}/name`, {
        method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ name: editName })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setAircraft(prev => ({ ...prev, name: editName }));
      setSuccess('Name gespeichert'); setTimeout(() => setSuccess(''), 3000);
    } catch (err) { setError(err.message); }
    finally { setNameSaving(false); }
  };

  const handleHomebaseSave = async (value) => {
    const v = value ?? editHomebase;
    if (v === (aircraft?.home_airport || '')) return;
    setHomebaseSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/aircraft/${aircraftId}/home-airport`, {
        method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ home_airport: v || null })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setAircraft(prev => ({ ...prev, home_airport: v }));
      setSuccess('Homebase gespeichert'); setTimeout(() => setSuccess(''), 3000);
    } catch (err) { setError(err.message); }
    finally { setHomebaseSaving(false); }
  };

  const resolveDays = (dayVal) => dayVal === 'all' ? [0,1,2,3,4,5,6] : [parseInt(dayVal)];

  const handleSingleSubmit = async () => {
    if (!sRouteId || !sEcoPrice) { setError('Please fill in route and economy price'); return; }
    const re = rangeError(sRouteId);
    if (re) { setError(re); return; }
    setSubmitting(true); setError(''); setSuccess('');
    try {
      const days    = resolveDays(sDay);
      const depTime = `${sDepHour.padStart(2,'0')}:${sDepMinute.padStart(2,'0')}`;
      const payload = days.map(d => ({
        route_id: parseInt(sRouteId), day_of_week: d, departure_time: depTime,
        economy_price: parseFloat(sEcoPrice),
        business_price: sBizPrice ? parseFloat(sBizPrice) : null,
        first_price: sFirstPrice ? parseFloat(sFirstPrice) : null,
        service_profile_id: sServiceProfileId ? parseInt(sServiceProfileId) : null
      }));
      const res  = await fetch(`${API_URL}/api/aircraft/${aircraftId}/schedule`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ flights: payload })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSuccess(data.message); fetchSchedule();
    } catch (err) { setError(err.message); }
    finally { setSubmitting(false); }
  };

  const handleSeriesSubmit = async () => {
    if (!outRouteId || !rEcoPrice) { setError('Please fill in outbound route and economy price'); return; }
    const reOut = rangeError(outRouteId);
    if (reOut) { setError(reOut); return; }
    const reIn = rangeError(inRouteId);
    if (reIn) { setError(reIn); return; }
    setSubmitting(true); setError(''); setSuccess('');
    try {
      const payload = seriesPreview.map(pf => ({
        route_id: pf.route.id, day_of_week: pf.day, departure_time: pf.dep,
        economy_price: parseFloat(rEcoPrice),
        business_price: rBizPrice ? parseFloat(rBizPrice) : null,
        first_price: rFirstPrice ? parseFloat(rFirstPrice) : null,
        service_profile_id: rServiceProfileId ? parseInt(rServiceProfileId) : null
      }));
      if (!payload.length) { setError('No flights to schedule'); setSubmitting(false); return; }
      const res  = await fetch(`${API_URL}/api/aircraft/${aircraftId}/schedule`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ flights: payload })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSuccess(data.message); fetchSchedule();
    } catch (err) { setError(err.message); }
    finally { setSubmitting(false); }
  };

  const handleMaintenanceSubmit = async () => {
    setSubmitting(true); setError(''); setSuccess('');
    try {
      const days      = resolveDays(mDay);
      const startTime = `${String(mStartHour).padStart(2,'0')}:${String(mStartMinute).padStart(2,'0')}`;
      for (const d of days) {
        const res  = await fetch(`${API_URL}/api/maintenance`, {
          method: 'POST', headers: jsonHeaders,
          body: JSON.stringify({ aircraft_id: aircraftId, day_of_week: d, start_time: startTime, type: 'routine' })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
      }
      setSuccess('Maintenance scheduled'); fetchSchedule();
    } catch (err) { setError(err.message); }
    finally { setSubmitting(false); }
  };

  const handleClearSchedule = async () => {
    if (!confirm('Clear entire weekly schedule including all flights and maintenance blocks?')) return;
    setError('');
    try {
      const res  = await fetch(`${API_URL}/api/aircraft/${aircraftId}/schedule`, { method: 'DELETE', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSuccess(data.message); fetchSchedule();
    } catch (err) { setError(err.message); }
  };

  const handleTransferSubmit = async () => {
    if (!transferAirport) { setError('Select a destination airport'); return; }
    if (!transferDate)    { setError('Select a departure date'); return; }
    const depISO = `${transferDate}T${transferTimeH.padStart(2,'0')}:${transferTimeM.padStart(2,'0')}:00`;
    setTransferSubmitting(true);
    setError('');
    try {
      const res  = await fetch(`${API_URL}/api/aircraft/${aircraftId}/transfer`, {
        method: 'POST', headers: jsonHeaders,
        body: JSON.stringify({ destination_airport: transferAirport, departure_time: depISO }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSuccess(data.message);
      if (data.new_balance != null) airline && (airline.balance = data.new_balance);
      setShowTransferModal(false);
      setTransferAirport('');
      fetchScheduledFlights();
    } catch (err) { setError(err.message); }
    finally { setTransferSubmitting(false); }
  };

  const handleToggleActive = async () => {
    setError('');
    try {
      const res  = await fetch(`${API_URL}/api/aircraft/${aircraftId}/active`, { method: 'PATCH', headers });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === 'slot_capacity_exceeded') {
          setSlotViolations(data.violations || []);
          return;
        }
        throw new Error(data.error);
      }
      setIsActive(data.is_active);
      setSuccess(data.message);
    } catch (err) { setError(err.message); }
  };

  const handleBuySlotAndActivate = async (airportCode) => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/expansions/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ airport_code: airportCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to purchase expansion level');
      setSlotViolations(null);
      // Retry activation
      await handleToggleActive();
    } catch (err) { setError(err.message); }
  };

  const handleHireCrew = async () => {
    setCrewHiring(true);
    try {
      const res = await fetch(`${API_URL}/api/personnel/hire/${aircraftId}`, {
        method: 'POST', headers: jsonHeaders
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setCrewAssigned(1);
      setSuccess('Crew hired and assigned');
    } catch (err) { setError(err.message); }
    finally { setCrewHiring(false); }
  };

  const handleDismissCrew = async () => {
    if (!confirm('Dismiss crew? The aircraft will be deactivated.')) return;
    try {
      const res = await fetch(`${API_URL}/api/personnel/dismiss/${aircraftId}`, {
        method: 'DELETE', headers: jsonHeaders
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setCrewAssigned(0);
      setIsActive(0);
      setSuccess('Crew dismissed');
    } catch (err) { setError(err.message); }
  };

  const handleScrap = async () => {
    setScrapping(true);
    try {
      const res = await fetch(`${API_URL}/api/aircraft/${aircraftId}/scrap`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Scrap failed');
      setShowScrapModal(false);
      onBack();
    } catch (err) {
      setError(err.message);
      setScrapping(false);
      setShowScrapModal(false);
    }
  };

  const handleCancelMaintenance = async (f) => {
    const maintId = f.id.split('_')[1]; // "maint_<id>_<weekOffset>"
    if (!confirm('Cancel this maintenance entry? It will be removed from the weekly schedule.')) return;
    try {
      const res = await fetch(`${API_URL}/api/maintenance/${maintId}`, { method: 'DELETE', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSuccess('Maintenance cancelled.');
      setTimeout(() => setSuccess(''), 4000);
      fetchScheduledFlights();
    } catch (err) { setError(err.message); }
  };

  const handleCancelFlight = async (flight) => {
    const totalPax = (flight.booked_economy || 0) + (flight.booked_business || 0) + (flight.booked_first || 0);
    const penalty = Math.round(
      (flight.booked_economy  || 0) * (flight.economy_price  || 0) * 1.2 +
      (flight.booked_business || 0) * (flight.business_price || flight.economy_price || 0) * 1.2 +
      (flight.booked_first    || 0) * (flight.first_price    || flight.economy_price || 0) * 1.2
    );
    const msg = totalPax > 0
      ? `Cancel flight ${flight.flight_number}?\n\n${totalPax} passenger(s) will be refunded at 120%.\nCancellation penalty: $${penalty.toLocaleString()}\n\nThis cannot be undone.`
      : `Cancel flight ${flight.flight_number}? No passengers booked — no penalty.`;
    if (!confirm(msg)) return;
    setError('');
    try {
      const res = await fetch(`${API_URL}/api/flights/${flight.id}/cancel`, {
        method: 'POST', headers
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const msgs = [`Flight ${flight.flight_number} cancelled.`];
      if (data.penalty > 0) msgs.push(`Penalty deducted: $${data.penalty.toLocaleString()}`);
      setSuccess(msgs.join(' '));
      setTimeout(() => setSuccess(''), 5000);
      // Refresh scheduled flights list
      const r2 = await fetch(`${API_URL}/api/aircraft/${aircraftId}/flights`, { headers });
      const d2 = await r2.json();
      if (r2.ok) setScheduledFlights(d2.flights || []);
    } catch (err) { setError(err.message); }
  };

  const handleDeleteCancelledFlight = async (flight) => {
    if (!confirm(`Delete cancelled flight ${flight.flight_number} from the list?`)) return;
    setError('');
    try {
      const res = await fetch(`${API_URL}/api/flights/${flight.id}`, {
        method: 'DELETE', headers
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setScheduledFlights(prev => prev.filter(f => f.id !== flight.id));
    } catch (err) { setError(err.message); }
  };

  const handleSellToMarket = async () => {
    setSellingToMarket(true);
    try {
      const res = await fetch(`${API_URL}/api/aircraft/${aircraftId}/sell-to-market`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setShowScrapModal(false);
      setSuccess(`${aircraft.registration} wurde auf dem Gebrauchtmarkt gelistet.`);
      setTimeout(() => onBack(), 2000);
    } catch (err) {
      setError(err.message);
      setSellingToMarket(false);
    }
  };

  const handleDeleteFlight = async (entryId) => {
    try {
      const res = await fetch(`${API_URL}/api/aircraft/${aircraftId}/weekly-schedule/${entryId}`, { method: 'DELETE', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      fetchSchedule();
    } catch (err) { setError(err.message); }
  };

  const handleDeleteMaint = async (maintId) => {
    try {
      const res = await fetch(`${API_URL}/api/maintenance/${maintId}`, { method: 'DELETE', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      fetchSchedule();
    } catch (err) { setError(err.message); }
  };

  const applyNextDep = (dayIndex, depMin) => {
    const h = String(Math.floor(depMin / 60)).padStart(2, '0');
    const m = String(depMin % 60).padStart(2, '0');
    const day = String(dayIndex);
    // Fill all three tabs so the user can switch to any of them
    setSDay(day); setSDepHour(h); setSDepMinute(m);
    setRDay(day); setRDepHour(h); setRDepMinute(m);
    setMDay(day); setMStartHour(h); setMStartMinute(m);
    document.querySelector('.ad-form-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const fillNextDepMaint = (m) => {
    const endMin = ((m.start_minutes ?? 0) + (m.duration_minutes ?? 0) + groundMin) % 1440;
    applyNextDep(m.dayIndex, endMin);
  };

  const fillNextDep = (f, overrideDay) => {
    const arrMin = parseHM(f.arrival_time);
    const nextMin = (arrMin + groundMin) % 1440;
    applyNextDep(overrideDay ?? f.dayIndex, nextMin);
  };

  const openEditModal = (entry) => {
    setEditEntry(entry);
    setEditDay(entry.day_of_week);
    setEditHour(entry.departure_time.split(':')[0]);
    setEditMinute(entry.departure_time.split(':')[1]);
    setEditEcoPrice(String(entry.economy_price ?? ''));
    setEditBizPrice(entry.business_price ? String(entry.business_price) : '');
    setEditFirstPrice(entry.first_price  ? String(entry.first_price)  : '');
    setEditServiceProfileId(entry.service_profile_id ? String(entry.service_profile_id) : '');
  };
  const closeEditModal = () => setEditEntry(null);

  const handleEditSave = async () => {
    if (!editEntry) return;
    setEditSubmitting(true); setError('');
    try {
      const depTime = `${editHour.padStart(2,'0')}:${editMinute.padStart(2,'0')}`;
      const res  = await fetch(`${API_URL}/api/aircraft/${aircraftId}/schedule/${editEntry.id}`, {
        method: 'PATCH', headers: jsonHeaders,
        body: JSON.stringify({
          day_of_week: editDay, departure_time: depTime,
          economy_price: parseFloat(editEcoPrice),
          business_price: editBizPrice  ? parseFloat(editBizPrice)  : null,
          first_price:    editFirstPrice ? parseFloat(editFirstPrice) : null,
          service_profile_id: editServiceProfileId ? parseInt(editServiceProfileId) : null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSuccess('Entry updated'); closeEditModal(); fetchSchedule();
    } catch (err) { setError(err.message); }
    finally { setEditSubmitting(false); }
  };

  const handleEditDelete = async () => {
    if (!editEntry || !confirm('Delete this schedule entry?')) return;
    setEditSubmitting(true); setError('');
    try {
      const res  = await fetch(`${API_URL}/api/aircraft/${aircraftId}/weekly-schedule/${editEntry.id}`, {
        method: 'DELETE', headers
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSuccess('Entry deleted'); closeEditModal(); fetchSchedule();
    } catch (err) { setError(err.message); }
    finally { setEditSubmitting(false); }
  };

  const dayOptions = [
    ...DAY_FULL.map((label, i) => <option key={i} value={String(i)}>{label}</option>),
    <option key="all" value="all">Every Day</option>
  ];

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  const aircraftRange = aircraft?.range_km ?? null;

  const routeInRange = (routeId) => {
    if (!routeId || !aircraftRange) return true;
    const r = routes.find(r => r.id === parseInt(routeId));
    return r ? r.distance_km <= aircraftRange : true;
  };

  const rangeError = (routeId) => {
    if (!routeId || !aircraftRange) return null;
    const r = routes.find(r => r.id === parseInt(routeId));
    if (!r || r.distance_km <= aircraftRange) return null;
    return `Route ${r.flight_number} exceeds aircraft range.\nRoute distance: ${(r.distance_km ?? '?').toLocaleString()} km\n${aircraft.full_name} max range: ${aircraftRange.toLocaleString()} km\n\nPlease select a different route or aircraft.`;
  };

  const formatFlightTime = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  };

  const formatFlightDayHeader = (iso) => {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'Europe/Berlin' });
  };

  const flightDateKey = (iso) => iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' }) : '';

  // ─── Render ───────────────────────────────────────────────────────────────────

  if (loading) return (
    <div className="ad-page">
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh', color:'#666' }}>Loading...</div>
      <style>{styles}</style>
    </div>
  );

  if (!aircraft) return (
    <div className="ad-page">
      <div className="ad-hero" />
      <div className="ad-container">
        <TopBar onBack={onBack} backLabel="Back to Fleet" balance={airline?.balance} airline={airline} />
        <div style={{ padding:'3rem', textAlign:'center', color:'#666' }}>Aircraft not found.</div>
      </div>
      <style>{styles}</style>
    </div>
  );

  return (
    <div className="ad-page">

      {/* ── Hero image banner ── */}
      <div className="ad-hero" />

      {/* ── Page container ── */}
      <div className="ad-container">

        <TopBar onBack={onBack} backLabel="Back to Fleet" balance={airline?.balance} airline={airline} />

        <Toast error={error} onClearError={() => setError('')} success={success} onClearSuccess={() => setSuccess('')} />

        {/* ── Info strip ── */}
        <div className="ad-info-strip">
          <div className="ad-identity">
            <span className="ad-reg">{aircraft.registration}</span>
            <div className="ad-id-text">
              <div className="ad-aircraft-name">{aircraft.full_name}</div>
              <div className="ad-aircraft-mfr">{aircraft.manufacturer}</div>
            </div>
          </div>
          <button className="ad-btn-decommission" onClick={() => setShowScrapModal(true)}>
            Decommission
          </button>
        </div>

        {/* ── Two-column layout ── */}
        <div className="ad-two-col">

          {/* ═══ LEFT COLUMN ═══ */}
          <div className="ad-left-col">

            {/* Aircraft image */}
            <div className="ad-image-col">
              {aircraft.image_filename ? (
                <img src={`/aircraft-images/${aircraft.image_filename}`} alt={aircraft.full_name} className="ad-aircraft-img" />
              ) : (
                <div className="ad-img-placeholder">
                  <svg viewBox="0 0 300 90" style={{ width:'80%', maxWidth:260 }}>
                    <path d="M15 45 L90 42 L120 15 L128 15 L112 42 L225 39 L255 22 L263 22 L248 39 L285 37 L285 45 L248 51 L263 68 L255 68 L225 51 L112 58 L128 75 L120 75 L90 52 L15 45 Z" fill="#2C2C2C" opacity="0.12"/>
                  </svg>
                  <span style={{ color:'#999', fontSize:13, marginTop:8 }}>{aircraft.manufacturer} {aircraft.model}</span>
                </div>
              )}
            </div>

            {/* Airplane Status card */}
            <div className="ad-sidebar-card" style={{ marginTop: '1.5rem' }}>
              <div className="ad-sidebar-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>
                  Airplane Status
                  <span className={`ad-op-badge ${isActive ? 'ad-op-badge--active' : 'ad-op-badge--inactive'}`}>
                    {isActive ? 'Active' : 'Inactive'}
                  </span>
                </span>
                {isActive ? (
                  <button className="ad-btn-clear-sched" onClick={handleToggleActive}
                    title="Deactivate aircraft — stops new flight generation">
                    Deactivate
                  </button>
                ) : (
                  <button
                    className="ad-btn-clear-sched"
                    onClick={() => {
                      if (!selectedCabinProfileId) { setError('Kein Kabinenprofil zugewiesen'); return; }
                      if (!crewAssigned)           { setError('Kein Personal zugewiesen'); return; }
                      if (schedule.length === 0)   { setError('Kein Flug geplant'); return; }
                      handleToggleActive();
                    }}>
                    Activate
                  </button>
                )}
              </div>
              {currentFlight ? (
                <FlightProgress flight={currentFlight} onNavigate={onNavigateToAirport} />
              ) : (() => {
                const nowMs = Date.now();
                // Active maintenance takes priority — no Boarding/Taxiing for maintenance blocks
                const activeMaint = scheduledFlights.find(f => f._type === 'maintenance' && f.status === 'in-progress');
                if (activeMaint) {
                  return (
                    <div className="ad-on-ground">
                      <StatusDot cls="in-maintenance" pulse={true} />
                      <div>
                        <div className="ad-on-ground-label" style={{ color: '#9ca3af' }}>In Maintenance</div>
                        {currentLocation ? (
                          <button className="ad-apt-link ad-apt-link--location" onClick={() => onNavigateToAirport?.(currentLocation.code)}>
                            {currentLocation.name} ({currentLocation.code})
                          </button>
                        ) : (
                          <span style={{ color:'#999', fontSize:'0.85rem' }}>Location unknown</span>
                        )}
                      </div>
                    </div>
                  );
                }
                // Only use actual flights (not maintenance) for Boarding/Taxiing state
                const nextFlight = scheduledFlights.find(f => f._type !== 'maintenance' && f.status !== 'completed' && f.status !== 'in-flight');
                const depSt = nextFlight ? computeDepStatus(nextFlight.departure_time, nowMs) : null;
                const gst = (depSt && depSt.cls !== 'scheduled')
                  ? depSt
                  : { label: 'On Ground', cls: 'ontime', color: '#22c55e' };
                const dotCls = !isActive ? 'maintenance' : gst.cls;
                const displayLabel = !isActive ? 'Inactive' : gst.label;
                const displayColor = !isActive ? '#9ca3af' : gst.color;
                return (
                  <div className="ad-on-ground">
                    <StatusDot cls={dotCls} pulse={false} />
                    <div>
                      <div className="ad-on-ground-label" style={{ color: displayColor }}>{displayLabel}</div>
                      {currentLocation ? (
                        <button className="ad-apt-link ad-apt-link--location" onClick={() => onNavigateToAirport?.(currentLocation.code)}>
                          {currentLocation.name} ({currentLocation.code})
                        </button>
                      ) : (
                        <span style={{ color:'#999', fontSize:'0.85rem' }}>Location unknown</span>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>

          </div>{/* end left col */}

          {/* ═══ RIGHT COLUMN ═══ */}
          <div className="ad-right-col">

            {/* Aircraft Information card */}
            <div className="ad-sidebar-card">
              <div className="ad-sidebar-title">Aircraft Information</div>
              <table className="ad-it-table">
                <tbody>
                  <tr>
                    <td className="ad-it-label">Aircraft Name</td>
                    <td className="ad-it-val">
                      <input type="text" className="ad-name-inp" value={editName}
                        onChange={e => setEditName(e.target.value)}
                        onBlur={handleNameSave}
                        onKeyDown={e => e.key === 'Enter' && handleNameSave()}
                        placeholder="Set a name…" disabled={nameSaving} />
                    </td>
                  </tr>
                  <tr>
                    <td className="ad-it-label">Home Base</td>
                    <td className="ad-it-val">
                      <select className="ad-it-select" value={editHomebase}
                        onChange={e => { setEditHomebase(e.target.value); handleHomebaseSave(e.target.value); }}
                        disabled={homebaseSaving}>
                        <option value="">— None —</option>
                        {Object.entries(airports.reduce((acc, a) => { (acc[a.country] = acc[a.country] || []).push(a); return acc; }, {})).sort(([a],[b]) => a.localeCompare(b)).map(([country, list]) => (
                          <optgroup key={country} label={country}>
                            {list.map(ap => <option key={ap.iata_code} value={ap.iata_code}>{ap.iata_code} – {ap.name}</option>)}
                          </optgroup>
                        ))}
                      </select>
                    </td>
                  </tr>
                  <tr>
                    <td className="ad-it-label">Cabin Profile</td>
                    <td className="ad-it-val">
                      <select className="ad-it-select" value={selectedCabinProfileId || ''}
                        onChange={e => handleCabinProfileChange(e.target.value)}>
                        <option value="">— None —</option>
                        {userCabinProfiles.map(p => {
                          const ecoClass   = p.classes?.find(c => c.class_type === 'economy');
                          const bizClass   = p.classes?.find(c => c.class_type === 'business');
                          const firstClass = p.classes?.find(c => c.class_type === 'first');
                          const config = [
                            ecoClass   ? `E${ecoClass.actual_capacity}`   : null,
                            bizClass   ? `B${bizClass.actual_capacity}`   : null,
                            firstClass ? `F${firstClass.actual_capacity}` : null,
                          ].filter(Boolean).join('/');
                          return <option key={p.id} value={p.id}>{p.name}{config ? ` (${config})` : ''}</option>;
                        })}
                      </select>
                    </td>
                  </tr>
                  <tr>
                    <td className="ad-it-label">Condition</td>
                    <td className="ad-it-val">
                      {(() => {
                        const c = aircraft?.condition ?? 100;
                        const { label, color, bg } =
                          c >= 80 ? { label: 'Excellent', color: '#16a34a', bg: 'rgba(22,163,74,0.1)' } :
                          c >= 60 ? { label: 'Good',      color: '#4ade80', bg: 'rgba(74,222,128,0.12)' } :
                          c >= 40 ? { label: 'Fair',      color: '#ca8a04', bg: 'rgba(202,138,4,0.1)' } :
                          c >= 20 ? { label: 'Poor',      color: '#ea580c', bg: 'rgba(234,88,12,0.1)' } :
                                    { label: 'Critical',  color: '#dc2626', bg: 'rgba(220,38,38,0.1)' };
                        return (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontWeight: 600, color: '#2C2C2C' }}>{Math.round(c)}%</span>
                            <span style={{ fontSize: '0.72rem', fontWeight: 700, color, background: bg, borderRadius: '4px', padding: '2px 7px' }}>{label}</span>
                          </span>
                        );
                      })()}
                    </td>
                  </tr>
                  <tr>
                    <td className="ad-it-label">Total Flights</td>
                    <td className="ad-it-val ad-it-num">{stats.total_flights.toLocaleString()}</td>
                  </tr>
                  <tr>
                    <td className="ad-it-label">Total Passengers</td>
                    <td className="ad-it-val ad-it-num">{(stats.total_passengers || 0).toLocaleString()}</td>
                  </tr>
                  <tr className="ad-it-last">
                    <td className="ad-it-label">Total Profit</td>
                    <td className="ad-it-val ad-it-num" style={{ color: stats.total_profit >= 0 ? '#16a34a' : '#dc2626' }}>
                      {stats.total_profit >= 0 ? '+' : ''}${Math.round(stats.total_profit).toLocaleString()}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Crew card */}
            <div className="ad-sidebar-card" style={{ marginTop: '1rem' }}>
              <div className="ad-sidebar-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Crew</span>
                {crewAssigned ? (
                  <button className="ad-btn-clear-sched" onClick={handleDismissCrew}>Dismiss</button>
                ) : (
                  <button
                    className="ad-btn-clear-sched"
                    disabled={crewHiring}
                    onClick={() => {
                      if (!selectedCabinProfileId) { setError('Kein Kabinenprofil zugewiesen'); return; }
                      handleHireCrew();
                    }}
                  >
                    {crewHiring ? 'Hiring…' : 'Hire & Assign'}
                  </button>
                )}
              </div>
              <table className="ad-it-table">
                <tbody>
                  <tr>
                    <td className="ad-it-label">Cockpit Crew</td>
                    <td className="ad-it-val">
                      <span className="ad-crew-num">{crewAssigned ? 4 : 0}</span>
                      {selectedProfile && <span className="ad-crew-num-req"> (4)</span>}
                    </td>
                  </tr>
                  <tr className="ad-it-last">
                    <td className="ad-it-label">Cabin Crew</td>
                    <td className="ad-it-val">
                      <span className="ad-crew-num">{crewAssigned ? cabinCrewCount : 0}</span>
                      {selectedProfile && <span className="ad-crew-num-req"> ({cabinCrewCount})</span>}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

          </div>{/* end right col */}

        </div>{/* end two-col */}

        {/* ── Weekly Schedule + Form side by side ── */}
        <div className="ad-schedule-layout">
        <div className="ad-grid-card">
          <div className="ad-sidebar-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Weekly Schedule</span>
            <button className="ad-btn-clear-sched" onClick={handleClearSchedule}>Clear All</button>
          </div>
          <div className="ad-grid-header">
            <div className="ad-grid-gutter-hd" />
            {DAY_SHORT.map((d, i) => <div key={i} className="ad-grid-day-hd">{d}</div>)}
          </div>
          <div className="ad-grid-scroll">
            {scheduleLoading && <div className="ad-grid-overlay">Loading…</div>}
            <div className="ad-grid-inner">
              <div className="ad-grid-gutter">
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="ad-grid-hour-lbl" style={{ top: h * HOUR_H }}>
                    {String(h).padStart(2,'0')}:00
                  </div>
                ))}
              </div>
              {DAY_SHORT.map((_, di) => {
                const bars             = flightBars.filter(f => f.dayIndex === di);
                const overflowBars     = flightBars.filter(f => f.overflowDayIndex === di);
                const groundBars       = flightBars.filter(f => f.groundDayIndex === di);
                const mBars            = maintBars.filter(m => m.dayIndex === di);
                const mOverflowBars    = maintBars.filter(m => m.overflowDayIndex === di);
                return (
                  <div key={di} className="ad-grid-col">
                    {Array.from({ length: 24 }, (_, h) => (
                      <div key={`h-${h}`} className="ad-hour-line" style={{ top: h * HOUR_H }} />
                    ))}
                    {Array.from({ length: 24 }, (_, h) => (
                      <div key={`hh-${h}`} className="ad-halfhour-line" style={{ top: h * HOUR_H + HOUR_H / 2 }} />
                    ))}
                    {mBars.map(m => (
                      <div key={`m-${m.id}`} className="ad-grid-maint"
                        style={{ top: m.top, height: m.height }}>
                        <span className="ad-grid-fn">A-Check</span>
                        {m.height > 24 && <span className="ad-grid-rt">{minsToHM(m.start_minutes ?? 0)}</span>}
                        <button className="ad-grid-del ad-grid-del--maint"
                          title="Delete maintenance block"
                          onClick={e => { e.stopPropagation(); handleDeleteMaint(m.id); }}>
                          ×
                        </button>
                        {m.height > 18 && (
                          <button className="ad-grid-next-dep ad-grid-next-dep--maint"
                            title="Schedule departure after maintenance"
                            onClick={e => { e.stopPropagation(); fillNextDepMaint(m); }}>
                            <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor">
                              <path d="M1.5 1.5 L7.5 5 L1.5 8.5 Z"/>
                              <rect x="8.5" y="1.5" width="1.5" height="7" rx="0.5"/>
                            </svg>
                          </button>
                        )}
                      </div>
                    ))}
                    {mOverflowBars.map(m => (
                      <div key={`mov-${m.id}`} className="ad-grid-maint"
                        style={{ top: 0, height: m.overflowHeight, opacity: 0.85, borderTop: '2px dashed rgba(255,255,255,0.5)' }}>
                        <span className="ad-grid-fn">A-Check</span>
                        {m.overflowHeight > 24 && <span className="ad-grid-rt">until {minsToHM((m.start_minutes + m.duration_minutes) % 1440)}</span>}
                      </div>
                    ))}
                    {groundBars.map(f => (
                      <div key={`g-${f.id}`} className="ad-grid-ground"
                        style={{
                          top: f.groundTop,
                          height: groundMin * PX_PER_MIN,
                          backgroundImage: `repeating-linear-gradient(-45deg, ${f.color} 0px, ${f.color} 2px, transparent 2px, transparent 7px)`,
                          border: `1px solid ${f.color}`,
                          borderTop: 'none',
                          boxSizing: 'border-box',
                        }} />
                    ))}
                    {bars.map(f => (
                      <div key={f.id}
                        className={`ad-grid-flight clickable ${conflictIds.has(f.id) ? 'conflict' : ''}`}
                        style={{ top: f.top, height: f.height, background: f.color, color: f.textColor }}
                        title={`${f.flight_number}: ${f.departure_airport}→${f.arrival_airport}\n${f.departure_time}–${f.arrival_time}`}
                        onClick={() => openEditModal(f)}>
                        <span className="ad-grid-fn">{f.flight_number}</span>
                        {f.height > 24 && <span className="ad-grid-rt">{f.departure_airport}→{f.arrival_airport}</span>}
                        {f.height > 40 && <span className="ad-grid-tm">{f.departure_time}</span>}
                        <button className="ad-grid-del"
                          title="Delete flight"
                          onClick={e => { e.stopPropagation(); handleDeleteFlight(f.id); }}>
                          ×
                        </button>
                        {f.height > 18 && !f.overflowDayIndex && (
                          <button className="ad-grid-next-dep" title={`Schedule next from ${f.arrival_airport}`}
                            onClick={e => { e.stopPropagation(); fillNextDep(f); }}>
                            <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor">
                              <path d="M1.5 1.5 L7.5 5 L1.5 8.5 Z"/>
                              <rect x="8.5" y="1.5" width="1.5" height="7" rx="0.5"/>
                            </svg>
                          </button>
                        )}
                      </div>
                    ))}
                    {overflowBars.map(f => (
                      <div key={`ov-${f.id}`}
                        className={`ad-grid-flight clickable ${conflictIds.has(f.id) ? 'conflict' : ''}`}
                        style={{ top: 0, height: f.overflowHeight, background: f.color, color: f.textColor, opacity: 0.85, borderTop: `2px dashed ${f.textColor}` }}
                        title={`${f.flight_number}: ${f.departure_airport}→${f.arrival_airport}\n${f.departure_time}–${f.arrival_time} (cont.)`}
                        onClick={() => openEditModal(f)}>
                        <span className="ad-grid-fn">{f.flight_number}</span>
                        {f.overflowHeight > 24 && <span className="ad-grid-rt">→{f.arrival_airport}</span>}
                        {f.overflowHeight > 40 && <span className="ad-grid-tm">until {f.arrival_time}</span>}
                        <button className="ad-grid-next-dep" title={`Schedule next from ${f.arrival_airport}`}
                          onClick={e => { e.stopPropagation(); fillNextDep(f, f.overflowDayIndex); }}>
                          <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor">
                            <path d="M1.5 1.5 L7.5 5 L1.5 8.5 Z"/>
                            <rect x="8.5" y="1.5" width="1.5" height="7" rx="0.5"/>
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
          {!scheduleLoading && flightBars.length === 0 && maintenance.length === 0 && (
            <div className="ad-grid-empty">No flights scheduled — use the form on the right to add flights.</div>
          )}
        </div>

        {/* ── Scheduling forms ── */}
        <div className="ad-form-card">
          <div className="ad-sidebar-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Schedule Flight</span>
            <button className="ad-btn-clear-sched" onClick={() => { setShowTransferModal(true); setError(''); setSuccess(''); }}>
              Transfer Flight
            </button>
          </div>
          <div className="sched-tabs">
            {['single','series','maintenance'].map(tab => (
              <button key={tab} className={`sched-tab ${scheduleTab === tab ? 'active' : ''}`}
                onClick={() => { setScheduleTab(tab); setError(''); setSuccess(''); }}>
                {tab === 'single' ? 'Single Flight' : tab === 'series' ? 'Series Flight' : 'Maintenance'}
              </button>
            ))}
          </div>

          {/* No cabin profile warning — blocks single & series scheduling */}
          {!selectedCabinProfileId && scheduleTab !== 'maintenance' && (
            <div className="sched-no-cabin-warning">
              <div className="sched-no-cabin-icon">✈</div>
              <div className="sched-no-cabin-text">
                <strong>Kein Kabinenprofil zugewiesen</strong>
                <p>Flüge können erst geplant werden, wenn diesem Flugzeug ein Kabinenprofil zugewiesen wurde. Weise zuerst ein Kabinenprofil im Bereich <em>Flugzeugdetails → Kabinenausstattung</em> zu.</p>
              </div>
            </div>
          )}

          {/* Single Flight */}
          {scheduleTab === 'single' && selectedCabinProfileId && (
            <div className="sched-form-body">
              <div className="sched-section-hd">Route</div>
              <div className="sched-section-body">
                <div className="sched-form-row">
                  <label>
                    Route
                    {sRouteId && !routeInRange(sRouteId) && (
                      <span className="sched-range-warn"> ⚠ Exceeds aircraft range</span>
                    )}
                  </label>
                  <select value={sRouteId} onChange={e => { setSRouteId(e.target.value); setSEcoPrice(''); setSBizPrice(''); setSFirstPrice(''); }}>
                    <option value="">— select route —</option>
                    {routes.map(r => {
                      const outOfRange = aircraftRange && r.distance_km > aircraftRange;
                      return (
                        <option key={r.id} value={r.id} disabled={outOfRange}>
                          {outOfRange ? '⚠ ' : ''}{r.flight_number}: {r.departure_airport} → {r.arrival_airport} ({(r.distance_km ?? '?').toLocaleString()} km{outOfRange ? ' — exceeds range' : ''})
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>

              <div className="sched-section-hd">Timing</div>
              <div className="sched-section-body">
                <div className="sched-2col">
                  <div className="sched-form-row">
                    <label>Day</label>
                    <select value={sDay} onChange={e => setSDay(e.target.value)}>{dayOptions}</select>
                  </div>
                  <div className="sched-form-row">
                    <label>Departure</label>
                    <div className="sched-time-inputs">
                      <input type="number" className="sched-time-inp" min="0" max="23" placeholder="HH"
                        value={sDepHour} onChange={e => setSDepHour(e.target.value)}
                        onBlur={e => setSDepHour(clampHour(e.target.value))} />
                      <span className="sched-time-sep">:</span>
                      <input type="number" className="sched-time-inp" min="0" max="59" placeholder="MM"
                        value={sDepMinute} onChange={e => setSDepMinute(e.target.value)}
                        onBlur={e => setSDepMinute(clampMinute(e.target.value))} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="sched-section-hd">Pricing</div>
              <div className="sched-section-body">
                <div className="sched-3col">
                  <div className="sched-form-row">
                    <label>Economy</label>
                    <input type="number" min="1" placeholder="$" value={sEcoPrice} onChange={e => setSEcoPrice(e.target.value)} />
                  </div>
                  <div className={`sched-form-row ${!hasBusiness ? 'price-disabled' : ''}`}>
                    <label>Business</label>
                    <input type="number" min="1" placeholder={hasBusiness ? '$' : 'N/A'} value={sBizPrice}
                      onChange={e => setSBizPrice(e.target.value)} disabled={!hasBusiness} />
                  </div>
                  <div className={`sched-form-row ${!hasFirst ? 'price-disabled' : ''}`}>
                    <label>First</label>
                    <input type="number" min="1" placeholder={hasFirst ? '$' : 'N/A'} value={sFirstPrice}
                      onChange={e => setSFirstPrice(e.target.value)} disabled={!hasFirst} />
                  </div>
                </div>
              </div>

              <div className="sched-section-hd">Service</div>
              <div className="sched-section-body">
                <div className="sched-form-row">
                  <label>Service Profile</label>
                  <select value={sServiceProfileId} onChange={e => setSServiceProfileId(e.target.value)}>
                    <option value="">— None —</option>
                    {serviceProfiles.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name} (E${p.economy_cost}{p.business_cost ? ` / B$${p.business_cost}` : ''}{p.first_cost ? ` / F$${p.first_cost}` : ''}/pax)
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="sched-form-actions">
                <button className="sched-btn-submit" onClick={handleSingleSubmit}
                  disabled={submitting || !sRouteId || !sEcoPrice || !routeInRange(sRouteId)}>
                  {submitting ? 'Scheduling...' : 'Schedule Flight'}
                </button>
              </div>
            </div>
          )}

          {/* Series Flight */}
          {scheduleTab === 'series' && selectedCabinProfileId && (
            <div className="sched-form-body">
              <div className="sched-section-hd">Routes</div>
              <div className="sched-section-body">
                <div className="sched-form-row">
                  <label>Outbound</label>
                  <select value={outRouteId} onChange={e => { setOutRouteId(e.target.value); setInRouteId(''); setREcoPrice(''); setRBizPrice(''); setRFirstPrice(''); }}>
                    <option value="">— select —</option>
                    {routes.map(r => {
                      const outOfRange = aircraftRange && r.distance_km > aircraftRange;
                      return (
                        <option key={r.id} value={r.id} disabled={outOfRange}>
                          {outOfRange ? '⚠ ' : ''}{r.flight_number}: {r.departure_airport} → {r.arrival_airport} ({(r.distance_km ?? '?').toLocaleString()} km{outOfRange ? ' — exceeds range' : ''})
                        </option>
                      );
                    })}
                  </select>
                </div>
                <div className="sched-form-row">
                  <label>Inbound</label>
                  <select value={inRouteId} onChange={e => setInRouteId(e.target.value)}>
                    <option value="">— select —</option>
                    {routes.map(r => {
                      const outOfRange = aircraftRange && r.distance_km > aircraftRange;
                      return (
                        <option key={r.id} value={r.id} disabled={outOfRange}>
                          {outOfRange ? '⚠ ' : ''}{r.flight_number}: {r.departure_airport} → {r.arrival_airport} ({(r.distance_km ?? '?').toLocaleString()} km{outOfRange ? ' — exceeds range' : ''})
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>

              <div className="sched-section-hd">Timing</div>
              <div className="sched-section-body">
                <div className="sched-2col">
                  <div className="sched-form-row">
                    <label>Day</label>
                    <select value={rDay} onChange={e => setRDay(e.target.value)}>{dayOptions}</select>
                  </div>
                  <div className="sched-form-row">
                    <label>Departure</label>
                    <div className="sched-time-inputs">
                      <input type="number" className="sched-time-inp" min="0" max="23" placeholder="HH"
                        value={rDepHour} onChange={e => setRDepHour(e.target.value)}
                        onBlur={e => setRDepHour(clampHour(e.target.value))} />
                      <span className="sched-time-sep">:</span>
                      <input type="number" className="sched-time-inp" min="0" max="59" placeholder="MM"
                        value={rDepMinute} onChange={e => setRDepMinute(e.target.value)}
                        onBlur={e => setRDepMinute(clampMinute(e.target.value))} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="sched-section-hd">Options</div>
              <div className="sched-section-body">
                <div className="sched-form-row">
                  <label>Turnaround Gap</label>
                  <select value={turnaroundGap} onChange={e => setTurnaroundGap(parseInt(e.target.value))}>
                    <option value="0">Immediate</option>
                    <option value="5">Round to 5 Min</option>
                    <option value="10">Round to 10 Min</option>
                    <option value="15">Round to 15 Min</option>
                    <option value="30">Round to 30 Min</option>
                    <option value="60">Round to 1h</option>
                  </select>
                </div>
                <div className="sched-form-row">
                  <label>
                    Repetitions
                    {rDay === 'all' ? (
                      tripsPerDay != null && (
                        <span style={{ fontWeight: 400, color: '#888', fontSize: '0.75rem', marginLeft: '0.4rem' }}>
                          max {tripsPerDay}/day
                        </span>
                      )
                    ) : (
                      tripsPerWeek != null && (
                        <span style={{ fontWeight: 400, color: '#888', fontSize: '0.75rem', marginLeft: '0.4rem' }}>
                          max {tripsPerWeek}/week
                        </span>
                      )
                    )}
                  </label>
                  <input type="number" min="1"
                    max={rDay === 'all' ? (tripsPerDay ?? 200) : (tripsPerWeek ?? 200)}
                    value={repeatCount}
                    onChange={e => {
                      const limit = rDay === 'all' ? (tripsPerDay ?? 200) : (tripsPerWeek ?? 200);
                      setRepeatCount(Math.max(1, Math.min(limit, parseInt(e.target.value) || 1)));
                    }}
                    placeholder="1" />
                </div>
              </div>

              <div className="sched-section-hd">Pricing</div>
              <div className="sched-section-body">
                <div className="sched-3col">
                  <div className="sched-form-row">
                    <label>Economy</label>
                    <input type="number" min="1" placeholder="$" value={rEcoPrice} onChange={e => setREcoPrice(e.target.value)} />
                  </div>
                  <div className={`sched-form-row ${!hasBusiness ? 'price-disabled' : ''}`}>
                    <label>Business</label>
                    <input type="number" min="1" placeholder={hasBusiness ? '$' : 'N/A'} value={rBizPrice}
                      onChange={e => setRBizPrice(e.target.value)} disabled={!hasBusiness} />
                  </div>
                  <div className={`sched-form-row ${!hasFirst ? 'price-disabled' : ''}`}>
                    <label>First</label>
                    <input type="number" min="1" placeholder={hasFirst ? '$' : 'N/A'} value={rFirstPrice}
                      onChange={e => setRFirstPrice(e.target.value)} disabled={!hasFirst} />
                  </div>
                </div>
              </div>

              <div className="sched-section-hd">Service</div>
              <div className="sched-section-body">
                <div className="sched-form-row">
                  <label>Service Profile</label>
                  <select value={rServiceProfileId} onChange={e => setRServiceProfileId(e.target.value)}>
                    <option value="">— None —</option>
                    {serviceProfiles.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name} (E${p.economy_cost}{p.business_cost ? ` / B$${p.business_cost}` : ''}{p.first_cost ? ` / F$${p.first_cost}` : ''}/pax)
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="sched-form-actions">
                <button className="sched-btn-submit" onClick={handleSeriesSubmit}
                  disabled={submitting || !outRouteId || !rEcoPrice || seriesHasConflict || !routeInRange(outRouteId) || !routeInRange(inRouteId)}>
                  {submitting ? 'Scheduling...' : `Schedule ${seriesPreview.length || ''} Entries`}
                </button>
              </div>
            </div>
          )}

          {/* Maintenance */}
          {scheduleTab === 'maintenance' && (
            <div className="sched-form-body">
              <div className="sched-section-hd">Timing</div>
              <div className="sched-section-body">
                <div className="sched-2col">
                  <div className="sched-form-row">
                    <label>Day</label>
                    <select value={mDay} onChange={e => setMDay(e.target.value)}>{dayOptions}</select>
                  </div>
                  <div className="sched-form-row">
                    <label>Start Time</label>
                    <div className="sched-time-inputs">
                      <input type="number" className="sched-time-inp" min="0" max="23" placeholder="HH"
                        value={mStartHour} onChange={e => setMStartHour(e.target.value)}
                        onBlur={e => setMStartHour(clampHour(e.target.value))} />
                      <span className="sched-time-sep">:</span>
                      <input type="number" className="sched-time-inp" min="0" max="59" placeholder="MM"
                        value={mStartMinute} onChange={e => setMStartMinute(e.target.value)}
                        onBlur={e => setMStartMinute(clampMinute(e.target.value))} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="sched-form-actions">
                <button className="sched-btn-submit" onClick={handleMaintenanceSubmit} disabled={submitting}>
                  {submitting ? 'Scheduling...' : 'Schedule Maintenance'}
                </button>
              </div>
            </div>
          )}
        </div>
        </div>{/* end ad-schedule-layout */}

      {/* ── Scheduled Flights ── */}
      <div className="ad-grid-card" style={{ marginTop: '1rem' }}>
        <div className="ad-sidebar-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Scheduled Flights</span>
          <span style={{ fontSize: '0.68rem', fontWeight: 400, opacity: 0.65, letterSpacing: 0 }}>Next 72 h · auto-refresh</span>
        </div>
        {scheduledFlights.length === 0 ? (
          <div className="ad-grid-empty">
            {isActive
              ? 'No upcoming flights. Add routes to the weekly schedule to generate flights automatically.'
              : 'Aircraft is inactive — activate it to start generating flights from the weekly schedule.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="ad-sf-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Flight</th>
                  <th>Route</th>
                  <th>Status</th>
                  <th>Passengers</th>
                  <th>Profit</th>
                  <th></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const nowMs = Date.now();
                  const rows = [];
                  let lastDay = null;
                  for (const f of scheduledFlights) {
                    const dayKey = flightDateKey(f.departure_time);
                    if (dayKey !== lastDay) {
                      rows.push(
                        <tr key={`sep-${dayKey}`} className="ad-sf-day-sep-row">
                          <td colSpan={8} className="ad-sf-day-sep-cell">{formatFlightDayHeader(f.departure_time)}</td>
                        </tr>
                      );
                      lastDay = dayKey;
                    }
                    if (f._type === 'maintenance') {
                      const mSt = f.status === 'completed'
                        ? { label: 'Completed', cls: 'ontime', color: '#22c55e' }
                        : f.status === 'in-progress'
                        ? { label: 'In Progress', cls: 'boarding', color: '#eab308' }
                        : { label: 'Scheduled', cls: 'scheduled', color: '#9ca3af' };
                      const depEnd = new Date(f.arrival_time);
                      const durMs = depEnd - new Date(f.departure_time);
                      const durH = Math.floor(durMs / 3600000);
                      const durM = Math.round((durMs % 3600000) / 60000);
                      rows.push(
                        <tr key={f.id} className="ad-sf-maint-row">
                          <td className="ad-sf-dt">{formatFlightTime(f.departure_time)}</td>
                          <td className="ad-sf-fn" style={{ color: '#6b7280', fontFamily: 'inherit' }}>Maintenance</td>
                          <td className="ad-sf-route" style={{ color: '#6b7280' }}>
                            {f.maintenance_type ? f.maintenance_type.charAt(0).toUpperCase() + f.maintenance_type.slice(1) : 'Routine'}
                            {' · '}{durH > 0 ? `${durH}h ` : ''}{durM > 0 ? `${durM}m` : ''}
                          </td>
                          <td><span className={`ad-sf-badge ad-sf-badge--${mSt.cls}`} style={{ color: mSt.color }}>{mSt.label}</span></td>
                          <td className="ad-sf-pax" style={{ color: '#9ca3af' }}>—</td>
                          <td className="ad-sf-rev" style={{ color: '#9ca3af' }}>—</td>
                          <td className="ad-sf-show-cell"></td>
                          <td className="ad-sf-cancel-cell">
                            {f.status === 'scheduled' && (
                              <button className="ad-sf-cancel-btn" onClick={() => handleCancelMaintenance(f)}
                                title="Remove from weekly maintenance schedule">
                                Cancel
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    } else if (f._type === 'transfer') {
                      const trSt = f.status === 'completed'
                        ? { label: 'Completed', cls: 'ontime', color: '#22c55e' }
                        : f.status === 'in-progress'
                        ? { label: 'In Transit', cls: 'boarding', color: '#eab308' }
                        : { label: 'Scheduled', cls: 'scheduled', color: '#9ca3af' };
                      const durMs2 = new Date(f.arrival_time) - new Date(f.departure_time);
                      const durH2  = Math.floor(durMs2 / 3600000);
                      const durM2  = Math.round((durMs2 % 3600000) / 60000);
                      rows.push(
                        <tr key={f.id} className="ad-sf-maint-row">
                          <td className="ad-sf-dt">{formatFlightTime(f.departure_time)}</td>
                          <td className="ad-sf-fn" style={{ color: '#3b82f6', fontFamily: 'inherit', fontWeight: 700 }}>Transfer</td>
                          <td className="ad-sf-route" style={{ color: '#3b82f6' }}>
                            {f.departure_airport} → {f.arrival_airport}
                            {' · '}{durH2 > 0 ? `${durH2}h ` : ''}{durM2 > 0 ? `${durM2}m` : ''}
                          </td>
                          <td><span className={`ad-sf-badge ad-sf-badge--${trSt.cls}`} style={{ color: trSt.color }}>{trSt.label}</span></td>
                          <td className="ad-sf-pax" style={{ color: '#9ca3af' }}>—</td>
                          <td className="ad-sf-rev" style={{ color: '#dc2626', fontWeight: 600 }}>–$500K</td>
                          <td className="ad-sf-show-cell"></td>
                          <td className="ad-sf-cancel-cell"></td>
                        </tr>
                      );
                    } else {
                    const st = f.status === 'completed' ? { label: 'Completed', cls: 'ontime', color: '#22c55e' }
                      : f.status === 'cancelled' ? { label: 'Canceled', cls: 'cancelled', color: '#dc2626' }
                      : f.status === 'in-flight' ? computeArrStatus(f.departure_time, f.arrival_time, nowMs)
                      : computeDepStatus(f.departure_time, nowMs);
                    rows.push(
                      <tr key={f.id}>
                        <td className="ad-sf-dt">{formatFlightTime(f.departure_time)}</td>
                        <td className="ad-sf-fn">{f.flight_number}</td>
                        <td className="ad-sf-route">
                          {f.departure_airport && f.arrival_airport
                            ? `${f.departure_airport} → ${f.arrival_airport}`
                            : '—'}
                        </td>
                        <td><span className={`ad-sf-badge ad-sf-badge--${st.cls}`} style={{ color: st.color }}>{st.label}</span></td>
                        <td className="ad-sf-pax">
                          {(() => {
                            const ecoCap = f.eco_capacity || 0;
                            const bizCap = f.biz_capacity || 0;
                            const firCap = f.fir_capacity || 0;
                            const hasClasses = ecoCap + bizCap + firCap > 0;
                            if (f.status === 'completed') {
                              return (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                                  <span style={{ background: 'rgba(156,163,175,0.12)', color: '#9ca3af', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', borderRadius: '4px', padding: '0.15rem 0.55rem', whiteSpace: 'nowrap' }}>
                                    {f.seats_sold ?? 0}/{f.total_seats}
                                  </span>
                                  {f.satisfaction_score != null && scoreToRating(f.satisfaction_score) < 5.0 &&
                                    <span style={{ background: 'rgba(220,38,38,0.1)', color: '#b91c1c', fontSize: '0.68rem', fontWeight: 700, borderRadius: '4px', padding: '0.15rem 0.45rem', lineHeight: 1 }}>{scoreToRating(f.satisfaction_score).toFixed(1)}!</span>
                                  }
                                </span>
                              );
                            }
                            if (!hasClasses) {
                              const fillPct = f.total_seats > 0 ? Math.round((f.seats_sold ?? 0) / f.total_seats * 100) : 0;
                              const fc = fillPct >= 80 ? '#16a34a' : fillPct >= 50 ? '#ca8a04' : '#dc2626';
                              return <span style={{ color: fc, fontWeight: 600 }}>{f.seats_sold ?? 0}/{f.total_seats} ({fillPct}%)</span>;
                            }
                            // Per-class fill pills
                            const classes = [
                              { lbl: 'E', booked: f.booked_economy ?? 0, cap: ecoCap },
                              { lbl: 'B', booked: f.booked_business ?? 0, cap: bizCap },
                              { lbl: 'F', booked: f.booked_first ?? 0, cap: firCap },
                            ].filter(c => c.cap > 0);
                            return (
                              <span style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                                {classes.map(c => {
                                  const pct = c.cap > 0 ? Math.round(c.booked / c.cap * 100) : 0;
                                  const fc = pct >= 80 ? '#16a34a' : pct >= 50 ? '#ca8a04' : '#dc2626';
                                  return (
                                    <span key={c.lbl} style={{ fontSize: '0.72rem', fontWeight: 700, color: fc, background: `${fc}18`, borderRadius: '3px', padding: '1px 4px' }}>
                                      {c.lbl}: {c.booked}/{c.cap}
                                    </span>
                                  );
                                })}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="ad-sf-rev">
                          {f.status === 'completed'
                            ? (() => {
                                const profit = Math.round(
                                  (f.revenue ?? 0)
                                  - (f.fuel_cost ?? 0)
                                  - (f.catering_cost ?? 0)
                                  - (f.landing_fee_paid ?? 0)
                                  - (f.ground_handling_paid ?? 0)
                                  - (f.atc_fee ?? 0)
                                );
                                return <span style={{ color: profit >= 0 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
                                  {profit >= 0 ? '+' : ''}${profit.toLocaleString()}
                                </span>;
                              })()
                            : '—'}
                        </td>
                        <td className="ad-sf-show-cell">
                          <button className="ad-sf-show-btn" onClick={() => { setSelectedFlight(f); setShowFlightModal(true); setFeedbackOpen(false); }}>
                            Details
                          </button>
                        </td>
                        <td className="ad-sf-cancel-cell">
                          {(f.status === 'scheduled' || f.status === 'boarding') && (
                            <button className="ad-sf-cancel-btn" onClick={() => handleCancelFlight(f)}
                              title="Cancel flight and refund passengers at 120%">
                              Cancel
                            </button>
                          )}
                          {f.status === 'cancelled' && (
                            <button className="ad-sf-delete-btn" onClick={() => handleDeleteCancelledFlight(f)}
                              title="Remove this cancelled flight from the list">
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                    }
                  }
                  return rows;
                })()}
              </tbody>
            </table>
          </div>
        )}
      </div>

      </div>

      {/* ── Show Flight Modal ── */}
      {showFlightModal && selectedFlight && (() => {
        const f = selectedFlight;
        const depTime = new Date(f.departure_time);
        const arrTime = new Date(f.arrival_time);
        const durationMs = arrTime - depTime;
        const durationH = Math.floor(durationMs / 3_600_000);
        const durationM = Math.round((durationMs % 3_600_000) / 60_000);

        const fmt = (d) => d.toLocaleString('de-CH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });

        const ecoRev   = Math.round((f.booked_economy  ?? 0) * (f.economy_price  ?? 0));
        const bizRev   = Math.round((f.booked_business ?? 0) * (f.business_price ?? 0));
        const firstRev = Math.round((f.booked_first    ?? 0) * (f.first_price    ?? 0));
        const ticketRevenue = ecoRev + bizRev + firstRev;

        // For completed flights use stored actuals; for in-progress estimate
        const isCompleted = f.status === 'completed';
        const isCancelled = f.status === 'cancelled';
        const wt = aircraft?.wake_turbulence_category ?? 'M';
        const landingFeeEst = wt === 'L' ? (f.landing_fee_light ?? 0)
                            : wt === 'H' ? (f.landing_fee_heavy ?? 0)
                            : (f.landing_fee_medium ?? 0);
        const wt2 = aircraft?.wake_turbulence_category || 'M';
        const depGround = wt2 === 'L' ? (f.dep_gh_light ?? 0) : wt2 === 'H' ? (f.dep_gh_heavy ?? 0) : (f.dep_gh_medium ?? 0);
        const arrGround = wt2 === 'L' ? (f.arr_gh_light ?? 0) : wt2 === 'H' ? (f.arr_gh_heavy ?? 0) : (f.arr_gh_medium ?? 0);

        // Use stored actuals for completed flights
        const fuelCostDisplay     = isCompleted ? (f.fuel_cost ?? 0) : (f.fuel_cost ?? 0);
        const cateringDisplay     = isCompleted ? (f.catering_cost ?? 0) : null;
        const landingDisplay      = isCompleted ? (f.landing_fee_paid ?? 0) : landingFeeEst;
        const groundDisplay       = isCompleted ? (f.ground_handling_paid ?? 0) : (depGround + arrGround);
        const atcDisplay          = f.atc_fee ?? 0;
        const totalRevDisplay     = isCompleted ? (f.revenue ?? ticketRevenue) : ticketRevenue;
        const totalCostDisplay    = fuelCostDisplay + (cateringDisplay ?? 0) + landingDisplay + groundDisplay + atcDisplay;
        const netRevenue          = totalRevDisplay - totalCostDisplay;

        const classes = [
          { label: 'Economy',  seats: f.booked_economy  ?? 0, cap: f.eco_capacity ?? 0, price: f.economy_price  ?? 0, rev: ecoRev  },
          { label: 'Business', seats: f.booked_business ?? 0, cap: f.biz_capacity ?? 0, price: f.business_price ?? 0, rev: bizRev  },
          { label: 'First',    seats: f.booked_first    ?? 0, cap: f.fir_capacity ?? 0, price: f.first_price    ?? 0, rev: firstRev },
        ].filter(c => c.price > 0);

        const cancelPenalty = isCancelled ? Math.round(
          (f.booked_economy  ?? 0) * (f.economy_price  ?? 0) * 1.2 +
          (f.booked_business ?? 0) * (f.business_price ?? f.economy_price ?? 0) * 1.2 +
          (f.booked_first    ?? 0) * (f.first_price    ?? f.economy_price ?? 0) * 1.2
        ) : 0;

        const finRows = isCancelled ? [
          { label: 'Cancellation Penalty', value: cancelPenalty > 0 ? -cancelPenalty : null },
        ] : [
          { label: 'Revenue',             value: totalRevDisplay,                  positive: true },
          { label: 'Fuel',                value: fuelCostDisplay > 0 ? -fuelCostDisplay : null },
          { label: 'Catering',            value: cateringDisplay != null && cateringDisplay > 0 ? -cateringDisplay : null },
          { label: 'Landing Fee',         value: landingDisplay > 0 ? -landingDisplay : null },
          { label: 'Ground Handling',     value: groundDisplay > 0 ? -groundDisplay : null },
          { label: 'ATC / Navigation',    value: atcDisplay > 0 ? -atcDisplay : null },
        ];

        return (
          <div className="sched-modal-overlay" onClick={() => setShowFlightModal(false)}>
            <div className="sched-modal sf-modal" onClick={e => e.stopPropagation()}>
              {/* Header */}
              <div className="sched-modal-header">
                <div>
                  <div className="sf-modal-route">
                    <span className="sf-modal-apt">{f.departure_airport}</span>
                    <span className="sf-modal-arrow">→</span>
                    <span className="sf-modal-apt">{f.arrival_airport}</span>
                  </div>
                  <div className="sf-modal-aptnames">
                    {f.dep_airport_name ?? f.departure_airport} → {f.arr_airport_name ?? f.arrival_airport}
                  </div>
                  {isCancelled && (
                    <div style={{ marginTop: 4 }}>
                      <span style={{ display: 'inline-block', background: '#FEF2F2', color: '#b91c1c', border: '1px solid #FECACA', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700, padding: '2px 8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Cancelled
                      </span>
                    </div>
                  )}
                </div>
                <button className="sched-modal-close" onClick={() => setShowFlightModal(false)}>×</button>
              </div>

              <div className="sched-modal-body sf-modal-body">
                {/* Flight info table */}
                <div className="sf-section-hd">Flight</div>
                <table className="sf-table">
                  <tbody>
                    <tr><td style={{ color: '#444' }}>Flight</td><td style={{ textAlign: 'right', color: '#444' }}>{f.flight_number}</td></tr>
                    <tr><td style={{ color: '#444' }}>Departs</td><td style={{ textAlign: 'right', color: '#444' }}>{fmt(depTime)}</td></tr>
                    <tr><td style={{ color: '#444' }}>Arrives</td><td style={{ textAlign: 'right', color: '#444' }}>{fmt(arrTime)}</td></tr>
                    <tr><td style={{ color: '#444' }}>Duration</td><td style={{ textAlign: 'right', color: '#444' }}>{durationH}h {durationM}m</td></tr>
                    {isCompleted && (() => {
                      const distKm = f.distance_km || 0;
                      const loadFactor = f.total_seats > 0 ? (f.seats_sold ?? 0) / f.total_seats : 0;
                      const distMult = distKm >= 3000 ? 2.0 : distKm >= 1000 ? 1.5 : 1.0;
                      const loadMult = loadFactor >= 0.9 ? 1.2 : loadFactor >= 0.8 ? 1.1 : loadFactor >= 0.7 ? 1.0 : 0.8;
                      const xp = Math.round(50 * distMult * loadMult);
                      return (
                        <tr>
                          <td style={{ color: '#444' }}>Points</td>
                          <td style={{ textAlign: 'right', color: '#444' }}>+{xp} XP</td>
                        </tr>
                      );
                    })()}
                  </tbody>
                </table>

                {/* Bookings section */}
                <div className="sf-section-hd">Passengers</div>
                <table className="sf-table">
                  <thead>
                    <tr>
                      <th>Class</th>
                      <th>Booked</th>
                      <th>Fill</th>
                      <th>Price</th>
                      <th>Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {classes.length > 0 ? classes.map(c => {
                      const fillPct = c.cap > 0 ? Math.round(c.seats / c.cap * 100) : (f.total_seats > 0 ? Math.round(c.seats / f.total_seats * 100) : 0);
                      const fc = fillPct >= 80 ? '#16a34a' : fillPct >= 50 ? '#ca8a04' : '#dc2626';
                      return (
                        <tr key={c.label}>
                          <td>{c.label}</td>
                          <td className="sf-mono">{c.seats}{c.cap > 0 ? `/${c.cap}` : ''}</td>
                          <td><span style={{ fontWeight: 700, color: fc, fontSize: '0.78rem' }}>{fillPct}%</span></td>
                          <td className="sf-mono">${c.price.toLocaleString()}</td>
                          <td className="sf-mono sf-rev-pos">${c.rev.toLocaleString()}</td>
                        </tr>
                      );
                    }) : (
                      <tr><td colSpan={5} style={{ color: '#999', fontStyle: 'italic' }}>No cabin class pricing set</td></tr>
                    )}
                  </tbody>
                </table>
                {isCompleted && (
                  <table className="sf-table" style={{ marginTop: 6 }}>
                    <tbody>
                      <tr>
                        <td style={{ color: '#444' }}>Satisfaction</td>
                        <td style={{ textAlign: 'right' }}>
                          {f.satisfaction_score != null
                            ? <button
                                onClick={f.satisfaction_score < 100 ? () => setFeedbackOpen(o => !o) : undefined}
                                style={{ background: 'none', border: 'none', padding: 0, cursor: f.satisfaction_score < 100 ? 'pointer' : 'default', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                              >
                                <SatisfactionRating score={f.satisfaction_score} />
                                {f.satisfaction_score < 100 && <span style={{ fontSize: 9, color: '#aaa' }}>{feedbackOpen ? '▲' : '▼'}</span>}
                              </button>
                            : <span style={{ color: '#CCC' }}>—</span>
                          }
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
                {feedbackOpen && f.satisfaction_score != null && f.satisfaction_score < 100 && (() => {
                  const entries = getFeedbackMessages(f.violated_rules || [], f.id);
                  return entries.length > 0 ? (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {entries.map(({ msg, cabins }, i) => (
                        <div key={i} style={{
                          background: '#FEF3F2', border: '1px solid #FECACA', borderRadius: 5,
                          padding: '6px 10px', fontSize: '0.82rem', color: '#7F1D1D',
                          display: 'flex', alignItems: 'flex-start', gap: 7,
                        }}>
                          {cabins.length > 0 && (
                            <span style={{ display: 'flex', gap: 3, flexShrink: 0, paddingTop: 1 }}>
                              {cabins.map(c => {
                                const styles = {
                                  economy:         { background: '#E8F4FD', color: '#1565C0', border: '1px solid #BBDEFB' },
                                  business:        { background: '#1C3A6B', color: '#E3F2FD', border: '1px solid #1565C0' },
                                  first:           { background: '#FFF8E1', color: '#7B5E00', border: '1px solid #FFE082' },
                                  premium_economy: { background: '#EDE7F6', color: '#4527A0', border: '1px solid #D1C4E9' },
                                };
                                return (
                                  <span key={c} style={{
                                    ...( styles[c] || { background: '#F5F5F5', color: '#555', border: '1px solid #DDD' }),
                                    display: 'inline-block', fontSize: '0.6rem', fontWeight: 800,
                                    padding: '1px 4px', borderRadius: 3, letterSpacing: '0.04em',
                                    fontFamily: 'monospace', lineHeight: 1.5,
                                  }}>{CABIN_SHORT[c] ?? c}</span>
                                );
                              })}
                            </span>
                          )}
                          <span style={{ fontStyle: 'italic' }}>"{msg}"</span>
                        </div>
                      ))}
                    </div>
                  ) : null;
                })()}

                {/* Financials section */}
                <div className="sf-section-hd" style={{ marginTop: '0.75rem' }}>
                  Financials{!isCompleted && !isCancelled && <span style={{ fontSize: '0.7rem', fontWeight: 400, color: '#AAA', marginLeft: 6 }}>estimated</span>}
                </div>
                <table className="sf-table">
                  <tbody>
                    {finRows.map(row => row.value == null ? null : (
                      <tr key={row.label}>
                        <td style={{ color: '#444' }}>{row.label}</td>
                        <td className="sf-mono" style={{ textAlign: 'right', color: row.positive ? '#16a34a' : '#dc2626' }}>
                          {row.positive ? `+$${Math.abs(row.value).toLocaleString()}` : `-$${Math.abs(row.value).toLocaleString()}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="sf-total-row">
                      <td style={{ fontWeight: 700 }}>
                        {isCancelled ? 'Total Loss' : isCompleted ? 'Profit' : 'Est. Profit'}
                      </td>
                      <td className="sf-mono" style={{ textAlign: 'right', fontWeight: 700, color: isCancelled ? '#dc2626' : netRevenue >= 0 ? '#16a34a' : '#dc2626' }}>
                        {isCancelled
                          ? (cancelPenalty > 0 ? `−$${cancelPenalty.toLocaleString()}` : '$0')
                          : `${netRevenue >= 0 ? '+' : '−'}$${Math.abs(netRevenue).toLocaleString()}`
                        }
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="sched-modal-footer">
                <button className="sched-btn-cancel" onClick={() => setShowFlightModal(false)}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Edit Entry Modal ── */}
      {editEntry && (() => {
        const origDepMin = parseHM(editEntry.departure_time);
        const origArrMin = parseHM(editEntry.arrival_time);
        const durMin = ((origArrMin - origDepMin) + 1440) % 1440;
        const newDepMin = (parseInt(editHour) || 0) * 60 + (parseInt(editMinute) || 0);
        const newArrMin = (newDepMin + durMin) % 1440;
        const previewArr = `${String(Math.floor(newArrMin / 60)).padStart(2,'0')}:${String(newArrMin % 60).padStart(2,'0')}`;
        const readyMin = (newArrMin + groundMin) % 1440;
        const previewReady = `${String(Math.floor(readyMin / 60)).padStart(2,'0')}:${String(readyMin % 60).padStart(2,'0')}`;
        const inpStyle = { width: '100%', padding: '0.3rem 0.5rem', border: '1px solid #E0E0E0', borderRadius: '4px', fontSize: '0.85rem', background: '#fff' };
        const numStyle = { width: '6rem', padding: '0.3rem 0.5rem', border: '1px solid #E0E0E0', borderRadius: '4px', fontSize: '0.85rem', textAlign: 'right' };
        const timeInpStyle = { width: '2.8rem', padding: '0.3rem 0.4rem', border: '1px solid #E0E0E0', borderRadius: '4px', fontSize: '0.85rem', textAlign: 'center' };
        return (
          <div className="sched-modal-overlay" onClick={closeEditModal}>
            <div className="sched-modal sf-modal" onClick={e => e.stopPropagation()}>
              {/* Header — matches flight detail style */}
              <div className="sched-modal-header">
                <div>
                  <div className="sf-modal-route">
                    <span className="sf-modal-apt">{editEntry.departure_airport}</span>
                    <span className="sf-modal-arrow">→</span>
                    <span className="sf-modal-apt">{editEntry.arrival_airport}</span>
                  </div>
                  <div className="sf-modal-aptnames">{editEntry.flight_number}</div>
                </div>
                <button className="sched-modal-close" onClick={closeEditModal}>×</button>
              </div>

              <div className="sched-modal-body sf-modal-body">
                {/* Schedule section */}
                <div className="sf-section-hd">Schedule</div>
                <table className="sf-table">
                  <tbody>
                    <tr>
                      <td style={{ color: '#444' }}>Day</td>
                      <td style={{ textAlign: 'right' }}>
                        <select value={editDay} onChange={e => setEditDay(parseInt(e.target.value))} style={inpStyle}>
                          {DAY_FULL.map((label, i) => <option key={i} value={i}>{label}</option>)}
                        </select>
                      </td>
                    </tr>
                    <tr>
                      <td style={{ color: '#444' }}>Departure</td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.25rem' }}>
                          <input type="number" min="0" max="23" value={editHour}
                            onChange={e => setEditHour(e.target.value)}
                            onBlur={e => setEditHour(clampHour(e.target.value))}
                            style={timeInpStyle} />
                          <span style={{ color: '#444', fontWeight: 600 }}>:</span>
                          <input type="number" min="0" max="59" value={editMinute}
                            onChange={e => setEditMinute(e.target.value)}
                            onBlur={e => setEditMinute(clampMinute(e.target.value))}
                            style={timeInpStyle} />
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <td style={{ color: '#444' }}>Arrival</td>
                      <td style={{ textAlign: 'right', color: '#444' }}>{previewArr}</td>
                    </tr>
                    <tr>
                      <td style={{ color: '#444' }}>Duration</td>
                      <td style={{ textAlign: 'right', color: '#444' }}>{minsToHM(durMin)}</td>
                    </tr>
                    <tr>
                      <td style={{ color: '#444' }}>Bereit / Ready</td>
                      <td style={{ textAlign: 'right', color: '#888' }}>{previewReady} <span style={{ fontSize: '0.75rem', color: '#AAA' }}>(+{groundMin}min)</span></td>
                    </tr>
                  </tbody>
                </table>

                {/* Tickets section */}
                <div className="sf-section-hd">Tickets</div>
                <table className="sf-table">
                  <tbody>
                    <tr>
                      <td style={{ color: '#444' }}>Economy</td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.25rem' }}>
                          <span style={{ color: '#888', fontSize: '0.8rem' }}>$</span>
                          <input type="number" min="1" value={editEcoPrice}
                            onChange={e => setEditEcoPrice(e.target.value)}
                            style={numStyle} />
                        </div>
                      </td>
                    </tr>
                    {hasBusiness && (
                      <tr>
                        <td style={{ color: '#444' }}>Business</td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.25rem' }}>
                            <span style={{ color: '#888', fontSize: '0.8rem' }}>$</span>
                            <input type="number" min="1" value={editBizPrice}
                              onChange={e => setEditBizPrice(e.target.value)}
                              style={numStyle} />
                          </div>
                        </td>
                      </tr>
                    )}
                    {hasFirst && (
                      <tr>
                        <td style={{ color: '#444' }}>First</td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.25rem' }}>
                            <span style={{ color: '#888', fontSize: '0.8rem' }}>$</span>
                            <input type="number" min="1" value={editFirstPrice}
                              onChange={e => setEditFirstPrice(e.target.value)}
                              style={numStyle} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>

                {/* Service section */}
                <div className="sf-section-hd">Service</div>
                <table className="sf-table">
                  <tbody>
                    <tr>
                      <td style={{ color: '#444' }}>Service Profile</td>
                      <td style={{ textAlign: 'right' }}>
                        <select value={editServiceProfileId}
                          onChange={e => setEditServiceProfileId(e.target.value)}
                          style={inpStyle}>
                          <option value="">— None —</option>
                          {serviceProfiles.map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="sched-modal-footer">
                <button className="sched-btn-delete" onClick={handleEditDelete} disabled={editSubmitting}>Delete</button>
                <button className="sched-btn-cancel" onClick={closeEditModal}>Cancel</button>
                <button className="sched-btn-submit" onClick={handleEditSave} disabled={editSubmitting}>
                  {editSubmitting ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Cabin Profile Change Warning Modal ── */}
      {showCpChangeModal && (
        <div className="decomm-modal-overlay" onClick={() => { setShowCpChangeModal(false); setPendingCpChangeId(null); }}>
          <div className="decomm-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="decomm-modal-head">
              <h3>Confirm Cabin Profile Change</h3>
              <button className="decomm-modal-close" onClick={() => { setShowCpChangeModal(false); setPendingCpChangeId(null); }}>&times;</button>
            </div>
            <div className="decomm-modal-body">
              <p style={{ fontSize: '0.9rem', color: '#444', marginBottom: '1rem' }}>Changing the cabin profile will:</p>
              <ul style={{ fontSize: '0.85rem', color: '#555', lineHeight: 1.7, paddingLeft: '1.2rem', marginBottom: '1.2rem' }}>
                <li>Delete the entire weekly schedule template</li>
                <li>Cancel <strong>{showCpChangeModal.flightsToCancel}</strong> upcoming scheduled flight{showCpChangeModal.flightsToCancel !== 1 ? 's' : ''} (next 72 h)</li>
                {showCpChangeModal.penalty > 0 && (
                  <li>Charge a refund penalty of <strong>${showCpChangeModal.penalty.toLocaleString()}</strong> (1.2× ticket price per passenger)</li>
                )}
                <li>Deactivate the aircraft (requires re-activation after change)</li>
                {(showCpChangeModal.oldCap !== showCpChangeModal.newCap) && (
                  <li>Change capacity: <strong>{showCpChangeModal.oldCap}</strong> → <strong>{showCpChangeModal.newCap}</strong> seats</li>
                )}
              </ul>
              <p style={{ fontSize: '0.82rem', color: '#888', marginBottom: '1.2rem' }}>Are you sure you want to continue?</p>
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                <button className="sched-btn-cancel" onClick={() => { setShowCpChangeModal(false); setPendingCpChangeId(null); }}>Cancel</button>
                <button className="decomm-btn-scrap" onClick={confirmCabinProfileChange}>Confirm Change</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Expansion capacity exceeded modal ── */}
      {slotViolations && (
        <div className="decomm-modal-overlay" onClick={() => setSlotViolations(null)}>
          <div className="decomm-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="decomm-modal-head">
              <h3>Expansion Capacity Exceeded</h3>
              <button className="decomm-modal-close" onClick={() => setSlotViolations(null)}>&times;</button>
            </div>
            <div className="decomm-modal-body">
              <p style={{ fontSize: '0.9rem', color: '#444', marginBottom: '0.75rem' }}>
                This schedule exceeds expansion capacity at the following airports:
              </p>
              {slotViolations.map(v => (
                <div key={v.airport} style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 6, padding: '0.6rem 1rem', marginBottom: '0.5rem', fontSize: '0.875rem' }}>
                  <strong>{v.airport}</strong>: {v.current + v.adding}/{v.capacity} (+{v.current + v.adding - v.capacity} over limit)
                  <div style={{ marginTop: '0.4rem' }}>
                    <button
                      style={{ fontSize: '0.8rem', padding: '4px 10px', background: '#2C2C2C', color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer' }}
                      onClick={() => handleBuySlotAndActivate(v.airport)}
                    >
                      Purchase expansion level at {v.airport} (+100/week)
                    </button>
                  </div>
                </div>
              ))}
              <p style={{ fontSize: '0.8rem', color: '#888', marginTop: '0.75rem' }}>
                You can also reduce flights in the schedule or purchase expansion levels from the Network page.
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
                <button className="sched-btn-cancel" onClick={() => setSlotViolations(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Decommission modal ── */}
      {showScrapModal && aircraft && (() => {
        const scrapVal  = Math.round((aircraft.new_price_usd || 0) * 0.05);
        const marketVal = Math.round(calculateCurrentValue(aircraft));
        const canDecomm = !isActive;
        return (
          <div className="decomm-modal-overlay" onClick={() => setShowScrapModal(false)}>
            <div className="decomm-modal" onClick={e => e.stopPropagation()}>
              <div className="decomm-modal-head">
                <h3>Decommission {aircraft.registration}</h3>
                <button className="decomm-modal-close" onClick={() => setShowScrapModal(false)}>&times;</button>
              </div>
              <div className="decomm-modal-body">
                <p className="decomm-modal-sub">{aircraft.full_name}</p>
                {!canDecomm ? (
                  <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 6, padding: '0.75rem 1rem', color: '#dc2626', fontSize: '0.85rem', marginBottom: '1rem' }}>
                    ✖ Aircraft must be deactivated before decommissioning. Deactivate the aircraft and wait until all scheduled flights complete.
                  </div>
                ) : (
                  <p style={{fontSize:'0.85rem',color:'#666',margin:'0 0 1.25rem'}}>
                    Choose how to remove this aircraft from your fleet:
                  </p>
                )}
                <div className="decomm-options" style={{ opacity: canDecomm ? 1 : 0.4, pointerEvents: canDecomm ? 'auto' : 'none' }}>
                  <div className="decomm-option">
                    <div className="decomm-option-title">Scrap</div>
                    <div className="decomm-option-desc">Receive 5% of the original purchase price as scrap metal value.</div>
                    <div className="decomm-option-value">{formatAircraftValue(scrapVal)}</div>
                    <button className="decomm-btn-scrap" onClick={handleScrap} disabled={scrapping || !canDecomm}>
                      {scrapping ? 'Scrapping…' : 'Scrap Aircraft'}
                    </button>
                  </div>
                  <div className="decomm-option decomm-option--market">
                    <div className="decomm-option-title">Sell on Used Market</div>
                    <div className="decomm-option-desc">List on the used aircraft market at current market value. Buyers can purchase it.</div>
                    <div className="decomm-option-value">{formatAircraftValue(marketVal)}</div>
                    <button className="decomm-btn-market" onClick={handleSellToMarket} disabled={sellingToMarket || !canDecomm}>
                      {sellingToMarket ? 'Listing…' : 'Sell to Market'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Transfer Flight Modal ── */}
      {showTransferModal && (() => {
        const currentLoc = aircraft?.current_location || aircraft?.home_airport || '?';
        const today = new Date().toISOString().split('T')[0];
        return (
          <div className="sched-modal-overlay" onClick={() => setShowTransferModal(false)}>
            <div className="sched-modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
              <div className="sched-modal-header" style={{ background: '#2C2C2C', borderBottom: 'none' }}>
                <h2 style={{ color: 'white', fontSize: '1rem' }}>Transfer Flight</h2>
                <button className="sched-modal-close" style={{ color: 'rgba(255,255,255,0.6)' }} onClick={() => setShowTransferModal(false)}>×</button>
              </div>
              <div className="sched-modal-body">
                <div style={{ background: '#F5F5F5', border: '1px solid #E0E0E0', borderRadius: 6, padding: '10px 14px', marginBottom: '1rem', fontSize: '0.82rem', color: '#444' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: '#888', fontWeight: 600, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Current Location</span>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.95rem', color: '#2C2C2C' }}>{currentLoc}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#888', fontWeight: 600, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Cost</span>
                    <span style={{ fontWeight: 700, color: '#2C2C2C' }}>$500,000</span>
                  </div>
                </div>
                <div className="sched-form-row" style={{ marginBottom: '0.6rem' }}>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#666', marginBottom: 6 }}>Country</label>
                  <select
                    value={transferCountry}
                    onChange={e => { setTransferCountry(e.target.value); setTransferAirport(''); }}
                    style={{ width: '100%', padding: '0.5rem 0.6rem', border: '1px solid #E0E0E0', borderRadius: 6, fontSize: '0.88rem', color: '#2C2C2C', background: 'white' }}
                  >
                    <option value="">— select country —</option>
                    {[...new Set(allAirports.filter(ap => ap.iata_code !== currentLoc).map(a => a.country))].sort().map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div className="sched-form-row" style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#666', marginBottom: 6 }}>Destination Airport</label>
                  <select
                    value={transferAirport}
                    onChange={e => setTransferAirport(e.target.value)}
                    disabled={!transferCountry}
                    style={{ width: '100%', padding: '0.5rem 0.6rem', border: '1px solid #E0E0E0', borderRadius: 6, fontSize: '0.88rem', color: '#2C2C2C', background: 'white' }}
                  >
                    <option value="">{transferCountry ? '— select airport —' : '— select a country first —'}</option>
                    {allAirports.filter(ap => ap.iata_code !== currentLoc && ap.country === transferCountry).map(ap => (
                      <option key={ap.iata_code} value={ap.iata_code}>{ap.iata_code} – {ap.name}</option>
                    ))}
                  </select>
                </div>
                <div className="sched-form-row">
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#666', marginBottom: 6 }}>Departure Date &amp; Time</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="date" value={transferDate} min={today} onChange={e => setTransferDate(e.target.value)}
                      style={{ flex: 1, padding: '0.48rem 0.5rem', border: '1px solid #E0E0E0', borderRadius: 6, fontSize: '0.88rem', color: '#2C2C2C' }} />
                    <input type="number" className="sched-time-inp" value={transferTimeH} min={0} max={23}
                      onChange={e => setTransferTimeH(clampHour(e.target.value))} />
                    <span className="sched-time-sep">:</span>
                    <input type="number" className="sched-time-inp" value={transferTimeM} min={0} max={59} step={5}
                      onChange={e => setTransferTimeM(clampMinute(e.target.value))} />
                  </div>
                </div>
                <div style={{ fontSize: '0.76rem', color: '#888', marginTop: '1rem', lineHeight: 1.5 }}>
                  The transfer repositions the aircraft. It does not carry passengers and cannot be operated on the same schedule as regular flights. Duration is based on actual flight time.
                </div>
              </div>
              <div className="sched-modal-footer">
                <button className="sched-btn-cancel" onClick={() => setShowTransferModal(false)}>Cancel</button>
                <button
                  className="sched-btn-submit"
                  onClick={handleTransferSubmit}
                  disabled={transferSubmitting || !transferAirport || !transferDate}
                >
                  {transferSubmitting ? 'Scheduling…' : 'Schedule Transfer'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <style>{styles}</style>
    </div>
  );
}

const styles = `
  * { box-sizing: border-box; }

  /* ── Page shell ── */
  .ad-page { min-height: 100vh; background: #F5F5F5; }

  /* ── Hero ── */
  .ad-hero {
    width: 100%; height: 300px;
    background:
      linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.55)),
      url('/header-images/Headerimage_Airplane.png') center / cover;
  }
  @media (max-width: 768px) { .ad-hero { height: 220px; } }

  /* ── Container ── */
  .ad-container {
    max-width: 1100px;
    margin: 0 auto;
    padding: 24px 24px 48px;
  }

  /* ── Messages ── */
  .ad-msg { padding: 0.75rem 1rem; border-radius: 6px; margin: 1rem 0 0; display: flex; align-items: center; justify-content: space-between; }
  .ad-msg-error   { background: #fee2e2; color: #dc2626; }
  .ad-msg-success { background: #dcfce7; color: #16a34a; }
  .ad-msg-close   { background: none; border: none; font-size: 1.2rem; cursor: pointer; color: inherit; }

  /* ── Info strip — exact airport page ap-info-strip ── */
  .ad-info-strip {
    background: white;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    padding: 24px 28px;
    margin-top: 1.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    flex-wrap: wrap;
  }
  .ad-identity { display: flex; align-items: center; gap: 20px; }
  .ad-reg {
    font-size: 3.5rem; font-weight: 900; font-family: monospace;
    color: #2C2C2C; letter-spacing: 0.06em; line-height: 1;
  }
  .ad-id-text { display: flex; flex-direction: column; gap: 4px; }
  .ad-aircraft-name { font-size: 1.2rem; font-weight: 700; color: #2C2C2C; }
  .ad-aircraft-mfr  { font-size: 0.88rem; color: #666666; }

  /* ── Two-column layout ── */
  .ad-two-col {
    margin-top: 1.5rem;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
    align-items: start;
  }
  @media (max-width: 900px) { .ad-two-col { grid-template-columns: 1fr; } }

  .ad-left-col  { display: flex; flex-direction: column; min-width: 0; }
  .ad-right-col { display: flex; flex-direction: column; min-width: 0; }

  /* Aircraft image card */
  .ad-image-col {
    border-radius: 8px; overflow: hidden;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    background: #FFFFFF;
    display: flex; align-items: center; justify-content: center;
    padding: 1.5rem 0;
  }
  .ad-aircraft-img { width: 100%; aspect-ratio: 10 / 3; object-fit: cover; display: block; }
  .ad-img-placeholder {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; width: 100%; padding: 24px;
  }

  /* ── Sidebar card — exact airport page ap-sidebar-card / ap-sidebar-title ── */
  .ad-sidebar-card {
    background: white; border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden;
  }
  .ad-sidebar-title {
    padding: 0.8rem 1.1rem; background: #2C2C2C; color: white;
    font-size: 0.7rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;
  }

  /* ── Info table — matches ap-info-table ── */
  .ad-it-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .ad-it-table td { padding: 0.52rem 1rem; border-bottom: 1px solid #F0F0F0; vertical-align: middle; }
  .ad-it-table tr.ad-it-last td { border-bottom: none; }
  .ad-it-label { color: #666666; width: 42%; white-space: nowrap; }
  .ad-it-val { color: #2C2C2C; font-weight: 500; }
  .ad-it-num { font-family: monospace; font-weight: 700; }

  /* Section rows — matches ap-it-section-row */
  .ad-it-section-row td {
    background: #F9F9F9; border-bottom: 1px solid #E8E8E8;
    padding: 0.3rem 1rem;
  }
  .ad-it-section-label {
    font-size: 0.66rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.09em; color: #999999;
  }

  /* ── Flight progress ── */
  .ad-fp-wrap { padding: 12px 16px 14px; }
  .ad-fp-route { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 10px; }
  .ad-fp-apt { display: flex; flex-direction: column; gap: 5px; align-items: flex-start; }
  .ad-fp-apt-r { align-items: flex-end; text-align: right; }
  .ad-fp-code {
    font-family: monospace; font-size: 1.4rem; font-weight: 900; color: #2C2C2C;
    line-height: 1; background: none; border: none; padding: 0; cursor: pointer;
    text-decoration: underline; text-decoration-color: rgba(0,0,0,0.25);
    text-underline-offset: 2px;
  }
  .ad-fp-code:hover { color: #555; }
  .ad-fp-apt-name { font-size: 10px; color: #999; line-height: 1.2; max-width: 90px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ad-fp-apt-r .ad-fp-apt-name { text-align: right; }
  .ad-fp-bar { position: relative; height: 24px; display: flex; align-items: center; margin-bottom: 8px; }
  .ad-fp-line { position: absolute; left: 0; right: 0; height: 2px; background: #E0E0E0; }
  .ad-fp-line::before, .ad-fp-line::after {
    content: ''; position: absolute; top: 50%; transform: translateY(-50%);
    width: 5px; height: 5px; border-radius: 50%; background: #2C2C2C;
  }
  .ad-fp-line::before { left: 0; }
  .ad-fp-line::after  { right: 0; }
  .ad-fp-plane {
    position: absolute; font-size: 16px; line-height: 1;
    top: 50%; transform: translateY(-50%); z-index: 1;
  }
  .ad-fp-meta { display: flex; align-items: center; gap: 8px; }
  .ad-fp-fn {
    font-family: monospace; font-size: 0.72rem; font-weight: 700;
    background: #2C2C2C; color: white; padding: 0.15rem 0.5rem; border-radius: 4px;
  }
  .ad-fp-time { font-size: 0.78rem; color: #666; margin-left: auto; }

  /* ── Status dots ── */
  .ad-status-dot {
    display: inline-block; width: 10px; height: 10px; border-radius: 50%;
    flex-shrink: 0; position: relative;
  }
  .ad-status-dot--scheduled { background: #9ca3af; box-shadow: 0 0 0 3px rgba(156,163,175,0.25); }
  .ad-status-dot--ontime    { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,0.25); }
  .ad-status-dot--boarding  { background: #eab308; box-shadow: 0 0 0 3px rgba(234,179,8,0.25); }
  .ad-status-dot--taxiing   { background: #f97316; box-shadow: 0 0 0 3px rgba(249,115,22,0.25); }
  .ad-status-dot--departed  { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,0.25); }
  .ad-status-dot--inflight  { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,0.25); }
  .ad-status-dot--maintenance { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,0.25); }
  .ad-status-dot--in-maintenance { background: #9ca3af; box-shadow: 0 0 0 3px rgba(156,163,175,0.25); }
  .ad-status-dot--pulse { animation: ad-dot-pulse 1.6s ease-in-out infinite; }
  .ad-status-dot--in-maintenance.ad-status-dot--pulse { animation: ad-dot-pulse-gray 1.6s ease-in-out infinite; }
  @keyframes ad-dot-pulse {
    0%   { box-shadow: 0 0 0 3px rgba(34,197,94,0.4); }
    50%  { box-shadow: 0 0 0 6px rgba(34,197,94,0.08); }
    100% { box-shadow: 0 0 0 3px rgba(34,197,94,0.4); }
  }
  @keyframes ad-dot-pulse-gray {
    0%   { box-shadow: 0 0 0 3px rgba(156,163,175,0.5); }
    50%  { box-shadow: 0 0 0 7px rgba(156,163,175,0.08); }
    100% { box-shadow: 0 0 0 3px rgba(156,163,175,0.5); }
  }
  /* ── On ground ── */
  .ad-on-ground { display: flex; align-items: center; gap: 12px; padding: 12px 16px 14px; }
  .ad-on-ground-label { font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 2px; }
  /* Flight progress status row */
  .ad-fp-status-row { display: flex; align-items: center; gap: 8px; padding: 10px 14px 6px; border-bottom: 1px solid #F0F0F0; }
  .ad-fp-status-label { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
  .ad-apt-link {
    background: none; border: none; padding: 0; cursor: pointer;
    color: #2C2C2C; font-size: 0.85rem; font-weight: 600;
    text-decoration: underline; text-decoration-color: rgba(0,0,0,0.25);
    text-underline-offset: 2px; font-family: inherit;
  }
  .ad-apt-link:hover { color: #555; }
  .ad-apt-link--location { font-weight: 400; color: #666; font-size: 0.82rem; }

  /* ── Inline form controls ── */
  .ad-name-inp {
    width: 100%; padding: 0.3rem 0.5rem; border: 1px solid #E0E0E0;
    border-radius: 4px; font-size: 0.85rem; color: #2C2C2C; outline: none;
    font-family: inherit;
  }
  .ad-name-inp:focus { border-color: #2C2C2C; }
  .ad-it-select {
    width: 100%; padding: 0.3rem 0.5rem; border: 1px solid #E0E0E0;
    border-radius: 4px; font-size: 0.85rem; color: #2C2C2C; background: white;
    cursor: pointer; outline: none; font-family: inherit;
  }
  .ad-it-select:focus { border-color: #2C2C2C; }
  .ad-no-profile-warn {
    font-size: 0.72rem; color: #d97706; background: #fef3c7;
    border: 1px solid #fcd34d; padding: 3px 7px; border-radius: 4px; margin-top: 5px;
  }
  .ad-activate-warnings {
    display: flex; flex-direction: column; gap: 4px;
    padding: 8px 0 4px;
  }
  .ad-activate-warn-item {
    font-size: 0.75rem; color: #92400e; background: #fef3c7;
    border: 1px solid #fcd34d; padding: 4px 8px; border-radius: 4px;
  }
  .ad-cabin-badges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
  .ad-cabin-badge {
    background: #2C2C2C; color: white;
    font-size: 0.68rem; font-weight: 700;
    padding: 0.15rem 0.5rem; border-radius: 4px; white-space: nowrap;
  }

  /* ── Schedule section (inside left col) ── */
  .ad-section { margin-top: 1.5rem; }
  .ad-section-title { font-size: 1rem; color: #2C2C2C; margin: 0 0 0.75rem; font-weight: 700; }
  .ad-section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
  .ad-section-header .ad-section-title { margin-bottom: 0; }

  /* ── Status row ── */
  .ad-status-row { display: flex; align-items: center; gap: 8px; }
  .ad-op-badge { display: inline-block; margin-left: 0.5rem; font-size: 0.7rem; font-weight: 600; padding: 0.1rem 0.45rem; border-radius: 4px; vertical-align: middle; }
  .ad-op-badge--active   { background: #dcfce7; color: #16a34a; }
  .ad-op-badge--inactive { background: #f3f4f6; color: #9ca3af; }
  .ad-btn-activate {
    padding: 0.28rem 0.7rem; background: #16a34a; border: none;
    border-radius: 5px; font-size: 0.75rem; font-weight: 600;
    color: white; cursor: pointer; transition: background 0.15s;
  }
  .ad-btn-activate:hover:not(:disabled) { background: #15803d; }
  .ad-btn-activate:disabled { cursor: not-allowed; }
  .ad-btn-deactivate {
    padding: 0.28rem 0.7rem; background: white;
    border: 1px solid #9ca3af; border-radius: 5px; font-size: 0.75rem; font-weight: 600;
    color: #6b7280; cursor: pointer; transition: all 0.15s;
  }
  .ad-btn-deactivate:hover { background: #fee2e2; border-color: #ef4444; color: #dc2626; }

  /* Crew card */
  .ad-crew-num     { font-weight: 700; color: #2C2C2C; font-family: monospace; }
  .ad-crew-num-req { color: #999; font-size: 0.8rem; font-family: monospace; }
  .ad-btn-crew-hire {
    width: 100%; padding: 0.4rem 0.75rem;
    background: white; border: 1px solid #2C2C2C;
    border-radius: 5px; font-size: 0.78rem; font-weight: 600;
    color: #2C2C2C; cursor: pointer; transition: all 0.15s;
  }
  .ad-btn-crew-hire:hover:not(:disabled) { background: #2C2C2C; color: white; }
  .ad-btn-crew-hire:disabled { opacity: 0.4; cursor: not-allowed; }
  .ad-btn-crew-dismiss {
    width: 100%; padding: 0.4rem 0.75rem;
    background: white; border: 1px solid #9ca3af;
    border-radius: 5px; font-size: 0.78rem; font-weight: 600;
    color: #6b7280; cursor: pointer; transition: all 0.15s;
  }
  .ad-btn-crew-dismiss:hover { background: #fee2e2; border-color: #ef4444; color: #dc2626; }

  /* Clear button */
  .ad-btn-clear-sched {
    background: transparent; border: 1px solid rgba(255,255,255,0.3); color: rgba(255,255,255,0.7);
    padding: 0.22rem 0.65rem; border-radius: 4px; font-size: 0.7rem; font-weight: 600;
    cursor: pointer; letter-spacing: 0.03em; transition: all 0.15s;
  }
  .ad-btn-clear-sched:hover { background: rgba(239,68,68,0.25); border-color: rgba(239,68,68,0.6); color: #fca5a5; }
  .sched-btn-clear {
    background: transparent; color: #dc2626; border: 1px solid #fca5a5;
    padding: 0.38rem 0.8rem; border-radius: 6px; font-weight: 600;
    cursor: pointer; font-size: 0.8rem; transition: all 0.15s;
  }
  .sched-btn-clear:hover { background: #fee2e2; }

  /* Flight grid card */
  .ad-schedule-layout { display: flex; flex-direction: column; gap: 1rem; margin-top: 1.5rem; }
  .ad-schedule-layout > .ad-form-card { position: static; max-height: none; overflow-y: visible; }
  @media (min-width: 1024px) {
    .ad-schedule-layout { flex-direction: row; align-items: flex-start; }
    .ad-schedule-layout > .ad-grid-card { flex: 0 0 70%; min-width: 0; }
    .ad-schedule-layout > .ad-form-card { flex: 1 1 0; min-width: 0; position: sticky; top: 1rem; max-height: calc(100vh - 2rem); overflow-y: auto; }
  }
  .ad-grid-card { background: white; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden; position: relative; }
  .ad-grid-header { display: flex; border-bottom: 2px solid #E0E0E0; background: #FAFAFA; position: sticky; top: 0; z-index: 5; }
  .ad-grid-gutter-hd { width: ${GUTTER_W}px; min-width: ${GUTTER_W}px; border-right: 1px solid #E0E0E0; flex-shrink: 0; }
  .ad-grid-day-hd { flex: 1; text-align: center; padding: 0.45rem 0.25rem; font-size: 0.75rem; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: 0.06em; border-right: 1px solid #EEEEEE; }
  .ad-grid-day-hd:last-child { border-right: none; }
  .ad-grid-scroll { height: 600px; overflow-y: auto; overflow-x: hidden; position: relative; }
  .ad-grid-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.75); color: #999; font-size: 0.9rem; z-index: 10; }
  .ad-grid-inner { display: flex; height: ${TOTAL_H}px; min-height: ${TOTAL_H}px; }
  .ad-grid-gutter { width: ${GUTTER_W}px; min-width: ${GUTTER_W}px; position: relative; flex-shrink: 0; border-right: 1px solid #E0E0E0; background: #FAFAFA; }
  .ad-grid-hour-lbl { position: absolute; right: 5px; font-size: 9px; color: #AAAAAA; line-height: ${HOUR_H}px; transform: translateY(-50%); white-space: nowrap; pointer-events: none; }
  .ad-grid-col { flex: 1; position: relative; border-right: 1px solid #EEEEEE; }
  .ad-hour-line { position: absolute; left: 0; right: 0; height: 1px; background: #E8E8E8; pointer-events: none; z-index: 0; }
  .ad-halfhour-line { position: absolute; left: 0; right: 0; height: 1px; border-top: 1px dashed #EEEEEE; pointer-events: none; z-index: 0; }
  .ad-grid-col:last-child { border-right: none; }
  .ad-grid-ground { position: absolute; left: 2px; right: 2px; border-radius: 0 0 3px 3px; z-index: 1; pointer-events: none; opacity: 0.55; box-sizing: border-box; border-top: none; }
  .ad-grid-maint { position: absolute; left: 2px; right: 2px; background: #6b7280; border-radius: 3px; padding: 2px 4px; z-index: 2; overflow: hidden; display: flex; flex-direction: column; gap: 1px; }
  .ad-grid-maint .ad-grid-fn { color: rgba(255,255,255,0.9); }
  .ad-grid-maint .ad-grid-rt { color: rgba(255,255,255,0.65); }
  .ad-grid-next-dep--maint { color: rgba(255,255,255,0.8); }
  .ad-grid-flight { position: absolute; left: 2px; right: 2px; border-radius: 3px; padding: 2px 4px; overflow: hidden; z-index: 3; display: flex; flex-direction: column; gap: 1px; }
  .ad-grid-flight.clickable { cursor: pointer; }
  .ad-grid-flight.clickable:hover { filter: brightness(1.12); }
  .ad-grid-next-dep { position: absolute; bottom: 2px; right: 2px; padding: 2px 3px; border-radius: 3px; background: rgba(255,255,255,0.22); border: 1px solid rgba(255,255,255,0.35); cursor: pointer; color: inherit; display: flex; align-items: center; justify-content: center; line-height: 1; }
  .ad-grid-next-dep:hover { background: rgba(255,255,255,0.45); }
  .ad-grid-del { position: absolute; top: 2px; right: 2px; padding: 0 3px; border-radius: 3px; background: rgba(255,255,255,0.22); border: 1px solid rgba(255,255,255,0.35); cursor: pointer; color: inherit; font-size: 11px; line-height: 14px; font-weight: 700; }
  .ad-grid-del:hover { background: rgba(239,68,68,0.5); border-color: rgba(239,68,68,0.7); }
  .ad-grid-del--maint { color: rgba(255,255,255,0.9); }
  .ad-grid-flight.conflict { outline: 2px solid #FF4444; outline-offset: -2px; }
  .ad-grid-fn { font-size: 9px; font-weight: 700; color: white; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2; }
  .ad-grid-rt { font-size: 8px; color: rgba(255,255,255,0.85); white-space: nowrap; overflow: hidden; line-height: 1.2; }
  .ad-grid-tm { font-size: 8px; color: rgba(255,255,255,0.7); white-space: nowrap; overflow: hidden; font-family: monospace; line-height: 1.2; }
  .ad-grid-empty { padding: 2rem; text-align: center; color: #999; font-size: 0.85rem; }

  /* Form card */
  .ad-form-card { background: white; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden; }

  /* ── Scheduled Flights table ── */
  .ad-sf-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .ad-sf-table th {
    padding: 0.5rem 1rem; text-align: left;
    font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
    color: #555; border-bottom: 2px solid #E8E8E8; background: #FAFAFA; white-space: nowrap;
  }
  .ad-sf-table td { padding: 0.55rem 1rem; border-bottom: 1px solid #F2F2F2; vertical-align: middle; color: #2C2C2C; }
  .ad-sf-table tbody tr:last-child td { border-bottom: none; }
  .ad-sf-table tbody tr:hover td { background: #FAFAFA; }
  tr + .ad-sf-day-sep-row td { border-top: 8px solid white !important; }
  .ad-sf-day-sep-cell {
    padding: 0.32rem 1rem;
    font-size: 0.67rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: #999999; background: #F5F5F5;
    border-top: 1px solid #EEEEEE !important; border-bottom: 1px solid #EEEEEE !important;
  }
  .ad-sf-day-sep-row:hover td { background: #F5F5F5 !important; }
  .ad-sf-maint-row td { background: #FAFAFA; }
  .ad-sf-maint-row:hover td { background: #F3F4F6 !important; }
  .ad-sf-dt    { color: #555; font-size: 0.8rem; white-space: nowrap; font-family: monospace; }
  .ad-sf-fn    { font-family: monospace; font-weight: 700; font-size: 0.88rem; }
  .ad-sf-route { color: #444; }
  .ad-sf-pax   { font-family: monospace; font-size: 0.82rem; color: #444; }
  .ad-sf-rev   { font-family: monospace; font-size: 0.82rem; color: #2C2C2C; font-weight: 600; }
  .ad-sf-est   { color: #888; font-weight: 400; }
  .ad-sf-badge {
    display: inline-block; padding: 0.15rem 0.55rem; border-radius: 4px;
    font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .ad-sf-badge--scheduled  { background: rgba(156,163,175,0.12); }
  .ad-sf-badge--ontime     { background: rgba(34,197,94,0.1); }
  .ad-sf-badge--boarding   { background: rgba(234,179,8,0.1); }
  .ad-sf-badge--taxiing    { background: rgba(234,179,8,0.1); }
  .ad-sf-badge--departed   { background: rgba(34,197,94,0.1); }
  .ad-sf-badge--inflight   { background: rgba(156,163,175,0.12); }
  .ad-sf-badge--ontime     { background: rgba(34,197,94,0.1); }
  .ad-sf-badge--completed  { background: rgba(34,197,94,0.1); }
  .ad-sf-badge--cancelled  { background: #FEF2F2; color: #b91c1c; }

  /* Tabs */
  .sched-tabs { display: flex; border-bottom: 1px solid #E0E0E0; background: #FAFAFA; }
  .sched-tab { flex: 1; padding: 0.75rem 1rem; background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer; font-size: 0.88rem; font-weight: 500; color: #666666; transition: all 0.15s; margin-bottom: -1px; }
  .sched-tab:hover { color: #2C2C2C; background: #F5F5F5; }
  .sched-tab.active { color: #2C2C2C; border-bottom-color: #2C2C2C; font-weight: 700; background: #FFFFFF; }

  /* Form body */
  .sched-form-body { padding: 0; padding-bottom: 0.25rem; }
  .sched-section-hd { padding: 0.32rem 1.25rem; font-size: 0.67rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #999999; background: #F5F5F5; border-top: 1px solid #EEEEEE; border-bottom: 1px solid #EEEEEE; }
  .sched-section-body { padding: 0.85rem 1.25rem 0.85rem; }
  .sched-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
  .sched-3col { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.6rem; }
  .sched-2col .sched-form-row,
  .sched-3col .sched-form-row { margin-bottom: 0; }
  .sched-form-row { display: flex; flex-direction: column; gap: 0.28rem; margin-bottom: 0.65rem; }
  .sched-form-row:last-child { margin-bottom: 0; }
  .sched-form-row label { font-size: 0.75rem; font-weight: 600; color: #555555; text-transform: uppercase; letter-spacing: 0.04em; }
  .sched-form-row select,
  .sched-form-row input[type="number"]:not(.sched-time-inp) {
    padding: 0.48rem 0.7rem; border: 1px solid #E0E0E0; border-radius: 6px;
    font-size: 0.9rem; color: #2C2C2C; background: white; transition: border-color 0.15s; width: 100%;
  }
  .sched-form-row select:focus,
  .sched-form-row input:focus { outline: none; border-color: #2C2C2C; }
  .sched-form-row.price-disabled label { color: #BBBBBB; }
  .sched-range-warn { color: #c2410c; font-weight: 700; font-size: 0.72rem; margin-left: 6px; text-transform: none; letter-spacing: 0; }
  .sched-no-cabin-warning {
    display: flex; gap: 14px; align-items: flex-start;
    margin: 16px; padding: 16px;
    background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px;
    color: #78350f;
  }
  .sched-no-cabin-icon { font-size: 1.6rem; line-height: 1; flex-shrink: 0; opacity: 0.8; }
  .sched-no-cabin-text { font-size: 0.84rem; }
  .sched-no-cabin-text strong { display: block; font-size: 0.9rem; margin-bottom: 4px; color: #92400e; }
  .sched-no-cabin-text p { margin: 0; line-height: 1.5; color: #a16207; }
  .sched-form-row.price-disabled input { background: #F8F8F8; color: #BBBBBB; }
  .sched-time-inputs { display: flex; align-items: center; gap: 0.3rem; }
  .sched-time-inp { width: 56px; padding: 0.48rem 0.4rem; text-align: center; border: 1px solid #E0E0E0; border-radius: 6px; font-size: 0.95rem; color: #2C2C2C; }
  .sched-time-inp:focus { outline: none; border-color: #2C2C2C; }
  .sched-time-sep { font-weight: 700; color: #2C2C2C; font-size: 1.1rem; }
  .sched-time-inp::-webkit-inner-spin-button, .sched-time-inp::-webkit-outer-spin-button { -webkit-appearance: none; }
  .sched-time-inp { -moz-appearance: textfield; }
  .sched-form-actions { display: flex; justify-content: flex-end; padding: 0.85rem 1.25rem 0.6rem; }
  .sched-btn-submit { background: #2C2C2C; color: white; border: none; padding: 0.58rem 1.4rem; border-radius: 6px; font-weight: 600; font-size: 0.9rem; cursor: pointer; transition: background 0.15s; }
  .sched-btn-submit:hover:not(:disabled) { background: #444444; }
  .sched-btn-submit:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Series preview */
  .sched-series-preview { background: #F5F5F5; border: 1px solid #E0E0E0; border-radius: 6px; padding: 0.75rem; margin: 0.5rem 1.25rem; }
  .sched-preview-header { font-size: 0.8rem; font-weight: 700; color: #2C2C2C; display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
  .sched-conflict-badge { background: #fee2e2; color: #dc2626; border: 1px solid #fca5a5; padding: 0.1rem 0.5rem; border-radius: 4px; font-size: 0.75rem; }
  .sched-preview-list { display: flex; flex-direction: column; gap: 0.25rem; }
  .sched-preview-item { display: flex; align-items: center; gap: 0.6rem; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.8rem; background: white; border: 1px solid #E0E0E0; }
  .sched-preview-item.out { border-left: 3px solid #4a6cf7; }
  .sched-preview-item.in  { border-left: 3px solid #38a169; }
  .sched-preview-dir   { font-weight: 700; width: 16px; color: #2C2C2C; }
  .sched-preview-route { flex: 1; color: #2C2C2C; font-weight: 600; }
  .sched-preview-time  { color: #555555; font-family: monospace; font-size: 0.78rem; }
  .sched-preview-day   { color: #888888; font-size: 0.75rem; width: 28px; }
  .sched-preview-more  { font-size: 0.78rem; color: #888888; padding: 0.2rem 0.5rem; }

  /* Modal */
  .sched-modal-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; padding: 1rem; }
  .sched-modal { background: white; border-radius: 8px; width: 100%; max-width: 460px; box-shadow: 0 8px 32px rgba(0,0,0,0.2); overflow: hidden; }
  .sched-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 1rem 1.25rem; border-bottom: 1px solid #E0E0E0; background: #FAFAFA; }
  .sched-modal-header h2 { margin: 0; font-size: 1.05rem; color: #2C2C2C; }
  .sched-modal-close { background: none; border: none; font-size: 1.4rem; cursor: pointer; color: #888888; line-height: 1; padding: 0; }
  .sched-modal-close:hover { color: #2C2C2C; }
  .sched-modal-body { padding: 1.25rem; }
  .sched-modal-footer { display: flex; justify-content: flex-end; gap: 0.6rem; align-items: center; padding: 0.9rem 1.25rem; border-top: 1px solid #E0E0E0; background: #FAFAFA; }
  .sched-flight-info-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.6rem; }
  .sched-flight-info-row > span:first-child { font-weight: 600; color: #2C2C2C; }
  .sched-edit-flighttime { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 6px; background: #F5F5F5; margin-bottom: 1rem; font-size: 0.85rem; }
  .sched-edit-ft-label { color: #888; font-size: 0.78rem; white-space: nowrap; }
  .sched-edit-ft-times { font-weight: 600; color: #2C2C2C; font-family: monospace; letter-spacing: 0.02em; }
  .sched-edit-ft-dur { color: #666; margin-left: auto; white-space: nowrap; }
  .sched-btn-cancel { background: none; border: 1px solid #E0E0E0; color: #555555; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.88rem; transition: all 0.15s; }
  .sched-btn-cancel:hover { border-color: #AAAAAA; color: #2C2C2C; background: #F5F5F5; }
  .sched-btn-delete { background: transparent; color: #dc2626; border: 1px solid #fca5a5; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.88rem; margin-right: auto; transition: all 0.15s; }
  .sched-btn-delete:hover:not(:disabled) { background: #fee2e2; }
  .sched-btn-delete:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Show Flight button in Scheduled Flights table */
  .ad-sf-show-cell { padding: 0.4rem 0.75rem !important; text-align: right; }
  .ad-sf-show-btn {
    background: none; border: 1px solid #E0E0E0; color: #555555;
    padding: 0.28rem 0.65rem; border-radius: 5px; font-size: 0.78rem;
    cursor: pointer; white-space: nowrap; transition: all 0.15s;
  }
  .ad-sf-show-btn:hover { border-color: #2C2C2C; color: #2C2C2C; background: #F5F5F5; }
  .ad-sf-cancel-cell { padding: 0.4rem 0.5rem !important; text-align: right; }
  .ad-sf-cancel-btn {
    background: none; border: 1px solid #fca5a5; color: #dc2626;
    padding: 0.28rem 0.6rem; border-radius: 5px; font-size: 0.78rem;
    cursor: pointer; white-space: nowrap; transition: all 0.15s;
  }
  .ad-sf-cancel-btn:hover { background: #fee2e2; border-color: #dc2626; }
  .ad-sf-delete-btn {
    background: none; border: 1px solid #d1d5db; color: #6b7280;
    padding: 0.28rem 0.6rem; border-radius: 5px; font-size: 0.78rem;
    cursor: pointer; white-space: nowrap; transition: all 0.15s;
  }
  .ad-sf-delete-btn:hover { background: #f3f4f6; border-color: #9ca3af; color: #374151; }

  /* Show Flight modal */
  .sf-modal { max-width: 520px; }
  .sf-modal .sched-modal-header { background: #2C2C2C; border-bottom: none; }
  .sf-modal .sched-modal-close { color: rgba(255,255,255,0.5); }
  .sf-modal .sched-modal-close:hover { color: white; }
  .sf-modal-route { display: flex; align-items: center; gap: 0.5rem; }
  .sf-modal-apt { font-size: 1.3rem; font-weight: 700; font-family: monospace; color: white; letter-spacing: 0.04em; }
  .sf-modal-arrow { font-size: 1.1rem; color: rgba(255,255,255,0.4); }
  .sf-modal-fn { font-size: 0.8rem; font-family: monospace; color: rgba(255,255,255,0.45); margin-left: 0.25rem; }
  .sf-modal-aptnames { font-size: 0.78rem; color: rgba(255,255,255,0.5); margin-top: 2px; }
  .sf-modal-body { padding: 0 1.25rem 1rem; display: flex; flex-direction: column; gap: 0; }
  .sf-section-hd { margin: 0 -1.25rem 0.1rem; padding: 0.32rem 1.25rem; font-size: 0.67rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #999999; background: #F5F5F5; border-top: 1px solid #EEEEEE; border-bottom: 1px solid #EEEEEE; }
  .sf-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-bottom: 0.25rem; }
  .sf-table th { text-align: left; padding: 0.4rem 0.5rem; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #999; border-bottom: 1px solid #F0F0F0; }
  .sf-table td { padding: 0.45rem 0.5rem; border-bottom: 1px solid #F5F5F5; color: #2C2C2C; }
  .sf-table tbody tr:last-child td { border-bottom: none; }
  .sf-table tfoot .sf-total-row td { border-top: 2px solid #E0E0E0; font-weight: 700; padding-top: 0.6rem; font-size: 0.9rem; }
  .sf-mono { font-family: monospace; }
  .sf-rev-pos { color: #16a34a !important; }

  /* Decommission button in info strip */
  .ad-btn-decommission {
    background: transparent; border: 1px solid #D0D0D0; color: #666;
    padding: 0.35rem 0.9rem; border-radius: 5px; font-size: 0.78rem; font-weight: 600;
    cursor: pointer; letter-spacing: 0.03em; transition: all 0.15s; flex-shrink: 0;
  }
  .ad-btn-decommission:hover { background: #fee2e2; border-color: #fca5a5; color: #dc2626; }

  /* Decommission modal */
  .decomm-modal-overlay { position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9000;padding:1rem; }
  .decomm-modal { background:white;border-radius:12px;width:100%;max-width:520px;overflow:hidden; }
  .decomm-modal-head { background:#2C2C2C;color:white;padding:1.25rem 1.5rem;display:flex;justify-content:space-between;align-items:center; }
  .decomm-modal-head h3 { margin:0;font-size:1.05rem;font-weight:700; }
  .decomm-modal-close { background:none;border:none;color:white;font-size:1.5rem;cursor:pointer;opacity:0.7;line-height:1; }
  .decomm-modal-close:hover { opacity:1; }
  .decomm-modal-body { padding:1.5rem; }
  .decomm-modal-sub { font-weight:600;color:#444;margin:0 0 0.5rem;font-size:0.9rem; }
  .decomm-options { display:grid;grid-template-columns:1fr 1fr;gap:1rem; }
  .decomm-option { border:1px solid #E0E0E0;border-radius:8px;padding:1.1rem;display:flex;flex-direction:column;gap:0.5rem; }
  .decomm-option--market { border-color:#2C2C2C; }
  .decomm-option-title { font-weight:700;font-size:0.85rem;color:#2C2C2C;text-transform:uppercase;letter-spacing:0.05em; }
  .decomm-option-desc { font-size:0.78rem;color:#666;line-height:1.4;flex:1; }
  .decomm-option-value { font-size:1.2rem;font-weight:700;color:#2C2C2C; }
  .decomm-btn-scrap,.decomm-btn-market { padding:0.5rem;border-radius:6px;font-size:0.82rem;font-weight:600;cursor:pointer;border:none;width:100%; }
  .decomm-btn-scrap { background:#F5F5F5;color:#DC2626;border:1px solid #DC2626; }
  .decomm-btn-scrap:hover { background:#DC2626;color:white; }
  .decomm-btn-scrap:disabled,.decomm-btn-market:disabled { opacity:0.5;cursor:not-allowed; }
  .decomm-btn-market { background:#2C2C2C;color:white; }
  .decomm-btn-market:hover { background:#1a1a1a; }
`;

export default AircraftDetail;
