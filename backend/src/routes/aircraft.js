import express from 'express';
import { body, validationResult } from 'express-validator';
import { getDatabase, saveDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';
import { calculateFlightDuration } from './flights.js';

const router = express.Router();

// ── Route sync helper ─────────────────────────────────────────────────────────
// Writes prices + service_profile_id to: routes table, all weekly_schedule entries, all future flights
function syncRoutePrices(db, routeId, ecoPrice, bizPrice, firPrice, serviceProfileId) {
  const updRoute = db.prepare(
    'UPDATE routes SET economy_price = ?, business_price = ?, first_price = ?, service_profile_id = ? WHERE id = ?'
  );
  updRoute.bind([ecoPrice, bizPrice ?? null, firPrice ?? null, serviceProfileId ?? null, routeId]);
  updRoute.step(); updRoute.free();

  const updWs = db.prepare(
    'UPDATE weekly_schedule SET economy_price = ?, business_price = ?, first_price = ?, service_profile_id = ? WHERE route_id = ?'
  );
  updWs.bind([ecoPrice, bizPrice ?? null, firPrice ?? null, serviceProfileId ?? null, routeId]);
  updWs.step(); updWs.free();

  const updF = db.prepare(`
    UPDATE flights SET economy_price = ?, business_price = ?, first_price = ?
    WHERE status IN ('scheduled', 'boarding')
      AND (route_id = ? OR weekly_schedule_id IN (SELECT id FROM weekly_schedule WHERE route_id = ?))
  `);
  updF.bind([ecoPrice, bizPrice ?? null, firPrice ?? null, routeId, routeId]);
  updF.step(); updF.free();
}

// ── Used Aircraft Market helpers ──────────────────────────────────────────────

// Maps airports.registration_prefix → registration generator
// Prefix stored without dash (e.g. 'HB', 'D', 'G')
const AIRPORT_PREFIX_FORMAT = {
  'HB': () => 'HB-' + randUMLetters(3),
  'D':  () => 'D-'  + randUMLetters(4),
  'G':  () => 'G-'  + randUMLetters(4),
  'F':  () => 'F-'  + randUMLetters(4),
  'PH': () => 'PH-' + randUMLetters(3),
  'N':  () => 'N'   + randUMLetters(3) + randUMDigits(3),
  'A6': () => 'A6-' + randUMLetters(3),
  '9V': () => '9V-' + randUMLetters(3),
  'JA': () => 'JA'  + randUMDigits(4),
  'VH': () => 'VH-' + randUMLetters(3),
  'OE': () => 'OE-' + randUMLetters(3),
};
function randUMLetters(n) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({length: n}, () => c[Math.floor(Math.random() * c.length)]).join('');
}
function randUMDigits(n) {
  return Array.from({length: n}, () => Math.floor(Math.random() * 10)).join('');
}
// Generate a unique registration for a given airport prefix string (e.g. 'HB', 'D')
// Checks both aircraft and used_aircraft_market tables for uniqueness
function genRegForPrefix(db, prefix) {
  const fmt = AIRPORT_PREFIX_FORMAT[prefix];
  if (!fmt) {
    // Unknown prefix – use prefix-XXX as fallback
    for (let i = 0; i < 30; i++) {
      const reg = prefix + '-' + randUMLetters(3);
      const s1 = db.prepare('SELECT id FROM aircraft WHERE registration = ?');
      s1.bind([reg]); const e1 = s1.step(); s1.free();
      const s2 = db.prepare('SELECT id FROM used_aircraft_market WHERE registration = ?');
      s2.bind([reg]); const e2 = s2.step(); s2.free();
      if (!e1 && !e2) return reg;
    }
    return prefix + '-' + randUMLetters(3) + randUMDigits(2);
  }
  for (let i = 0; i < 30; i++) {
    const reg = fmt();
    const s1 = db.prepare('SELECT id FROM aircraft WHERE registration = ?');
    s1.bind([reg]); const e1 = s1.step(); s1.free();
    const s2 = db.prepare('SELECT id FROM used_aircraft_market WHERE registration = ?');
    s2.bind([reg]); const e2 = s2.step(); s2.free();
    if (!e1 && !e2) return reg;
  }
  return prefix + '-' + randUMLetters(3) + randUMDigits(2);
}
// Generate a unique registration for a specific airport (by IATA code)
function genRegForLocation(db, iataCode) {
  if (!iataCode) return genRegForPrefix(db, 'D'); // fallback
  const stmt = db.prepare('SELECT registration_prefix FROM airports WHERE iata_code = ?');
  stmt.bind([iataCode]);
  const found = stmt.step();
  const prefix = found ? stmt.get()[0] : null;
  stmt.free();
  if (!prefix) return genRegForPrefix(db, 'D');
  return genRegForPrefix(db, prefix);
}
function calcUsedValue(newPrice, kAge, kFh, ageYears, totalFh) {
  const val = newPrice * Math.exp(-(kAge || 0.035) * ageYears) * Math.exp(-(kFh || 0.000006) * totalFh);
  return Math.max(val, newPrice * 0.30);
}
const MARKET_TARGET_PER_TYPE = 8;

export function fillUsedMarket(db) {
  try {
    const tStmt = db.prepare('SELECT id, new_price_usd, depreciation_age, depreciation_fh FROM aircraft_types');
    const types = [];
    while (tStmt.step()) { const r = tStmt.get(); types.push({id:r[0],newPrice:r[1],kAge:r[2],kFh:r[3]}); }
    tStmt.free();
    if (!types.length) return;

    const aStmt = db.prepare('SELECT iata_code, registration_prefix FROM airports');
    const airports = [];
    while (aStmt.step()) { const r = aStmt.get(); airports.push({ code: r[0], prefix: r[1] }); }
    aStmt.free();

    // Load all existing counts per type upfront to avoid nested prepare issues
    const countMap = {};
    const countAllStmt = db.prepare('SELECT aircraft_type_id, COUNT(*) FROM used_aircraft_market GROUP BY aircraft_type_id');
    while (countAllStmt.step()) { const r = countAllStmt.get(); countMap[String(r[0])] = r[1]; }
    countAllStmt.free();

    const currentYear = new Date().getFullYear();
    let total = 0;
    for (const t of types) {
      const existing = countMap[String(t.id)] || 0;
      if (existing > 0) continue;

      for (let i = 0; i < MARKET_TARGET_PER_TYPE; i++) {
        const ageYears = 2 + Math.random() * 18;
        const manufacturedYear = Math.round(currentYear - ageYears);
        const totalFh = Math.round(ageYears * (400 + Math.random() * 800));
        const airport = airports.length ? airports[Math.floor(Math.random() * airports.length)] : null;
        const location = airport ? airport.code : null;
        const reg = airport ? genRegForPrefix(db, airport.prefix) : genRegForPrefix(db, 'D');
        const val = Math.round(calcUsedValue(t.newPrice, t.kAge, t.kFh, ageYears, totalFh));
        const ins = db.prepare('INSERT INTO used_aircraft_market (aircraft_type_id, registration, manufactured_year, total_flight_hours, current_value, location) VALUES (?, ?, ?, ?, ?, ?)');
        ins.bind([t.id, reg, manufacturedYear, totalFh, val, location]);
        ins.step(); ins.free();
        total++;
      }
    }
    console.log(`[UsedMarket] Added ${total} listings (target: ${MARKET_TARGET_PER_TYPE} per type)`);
    return total;
  } catch(e) { console.error('fillUsedMarket error:', e); return 0; }
}

let lastMarketRefreshDate = null;
export function startMarketRefreshScheduler() {
  // Check every 10 minutes if it's past 3 AM CET and market hasn't been refreshed today
  setInterval(() => {
    try {
      const db = getDatabase();
      if (!db) return;
      const cetDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
      const cetHour = parseInt(new Intl.DateTimeFormat('en', { timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false }).format(new Date()));
      if (cetHour >= 3 && cetDate !== lastMarketRefreshDate) {
        lastMarketRefreshDate = cetDate;
        fillUsedMarket(db);
        saveDatabase();
        console.log('[UsedMarket] Daily refresh completed');
      }
    } catch(e) { console.error('Market refresh error:', e); }
  }, 10 * 60 * 1000);
}

// Helper function to get grouped fleet
function getGroupedFleetHandler(req, res) {
  try {
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Get fleet grouped by type
    const groupedStmt = db.prepare(`
      SELECT t.id as type_id, t.manufacturer, t.model, t.full_name, t.max_passengers, t.range_km,
             COUNT(a.id) as count, t.image_filename
      FROM aircraft a
      JOIN aircraft_types t ON a.aircraft_type_id = t.id
      WHERE a.airline_id = ?
      GROUP BY t.id
      ORDER BY t.manufacturer, t.model
    `);
    groupedStmt.bind([airlineId]);

    const fleetGrouped = [];
    let totalCount = 0;
    while (groupedStmt.step()) {
      const row = groupedStmt.get();
      const count = row[6];
      totalCount += count;
      fleetGrouped.push({
        type_id: row[0],
        manufacturer: row[1],
        model: row[2],
        full_name: row[3],
        max_passengers: row[4],
        range_km: row[5],
        count: count,
        image_filename: row[7]
      });
    }
    groupedStmt.free();

    res.json({ fleet: fleetGrouped, total_count: totalCount });
  } catch (error) {
    console.error('Get grouped fleet error:', error);
    res.status(500).json({ error: 'Server error' });
  }
}

// Helper function to get aircraft market
function getMarketHandler(req, res) {
  try {
    const db = getDatabase();
    const { manufacturer } = req.query;

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });
    const airlineLvlStmt = db.prepare('SELECT level FROM airlines WHERE id = ?');
    airlineLvlStmt.bind([airlineId]);
    if (!airlineLvlStmt.step()) {
      airlineLvlStmt.free();
      return res.status(400).json({ error: 'No airline found' });
    }
    const airlineLevel = airlineLvlStmt.get()[0];
    airlineLvlStmt.free();

    const { wake_category } = req.query;

    let query = `SELECT id, manufacturer, model, full_name, max_passengers, range_km,
      cruise_speed_kmh, min_runway_takeoff_m, min_runway_landing_m,
      fuel_consumption_per_km,
      wake_turbulence_category, required_pilots,
      new_price_usd, required_level, image_filename FROM aircraft_types`;
    const params = [];
    const conditions = [];

    if (manufacturer && manufacturer !== 'All') {
      conditions.push('manufacturer = ?');
      params.push(manufacturer);
    }
    if (wake_category && wake_category !== 'All') {
      conditions.push('wake_turbulence_category = ?');
      params.push(wake_category);
    }
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY new_price_usd ASC';

    const stmt = db.prepare(query);
    if (params.length > 0) {
      stmt.bind(params);
    }

    const aircraftTypes = [];
    while (stmt.step()) {
      const row = stmt.get();
      aircraftTypes.push({
        id: row[0],
        manufacturer: row[1],
        model: row[2],
        full_name: row[3],
        max_passengers: row[4],
        range_km: row[5],
        cruise_speed_kmh: row[6],
        min_runway_takeoff_m: row[7],
        min_runway_landing_m: row[8],
        fuel_consumption_per_km: row[9],
        wake_turbulence_category: row[10],
        required_pilots: row[11],
        new_price_usd: row[12],
        required_level: row[13],
        image_filename: row[14],
        can_purchase: airlineLevel >= row[13]
      });
    }
    stmt.free();

    // Always return full lists for filter dropdowns (unaffected by filters)
    const mfgResult = db.exec('SELECT DISTINCT manufacturer FROM aircraft_types ORDER BY manufacturer');
    const manufacturers = mfgResult.length ? mfgResult[0].values.map(row => row[0]) : [];

    const wakeResult = db.exec('SELECT DISTINCT wake_turbulence_category FROM aircraft_types ORDER BY wake_turbulence_category');
    const wakeCategories = wakeResult.length ? wakeResult[0].values.map(row => row[0]) : [];

    res.json({
      aircraft_types: aircraftTypes,
      manufacturers,
      wake_categories: wakeCategories,
      airline_level: airlineLevel
    });
  } catch (error) {
    console.error('Get aircraft market error:', error);
    res.status(500).json({ error: 'Server error' });
  }
}

// Root route - handles /api/fleet and /api/aircraft-market aliases
router.get('/', authMiddleware, (req, res) => {
  if (req.baseUrl === '/api/fleet') {
    return getGroupedFleetHandler(req, res);
  }
  if (req.baseUrl === '/api/aircraft-market') {
    return getMarketHandler(req, res);
  }
  res.status(404).json({ error: 'Not found' });
});

// Get all aircraft types available for purchase
router.get('/types', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });
    const airlineLvlStmt = db.prepare('SELECT level FROM airlines WHERE id = ?');
    airlineLvlStmt.bind([airlineId]);
    if (!airlineLvlStmt.step()) {
      airlineLvlStmt.free();
      return res.status(400).json({ error: 'No airline found' });
    }
    const airlineLevel = airlineLvlStmt.get()[0];
    airlineLvlStmt.free();

    const result = db.exec('SELECT id, manufacturer, model, full_name, max_passengers, range_km, cruise_speed_kmh, new_price_usd, required_level, image_filename FROM aircraft_types ORDER BY required_level, new_price_usd');

    if (!result.length) {
      return res.json({ aircraft_types: [], airline_level: airlineLevel });
    }

    const aircraftTypes = result[0].values.map(row => ({
      id: row[0],
      manufacturer: row[1],
      model: row[2],
      full_name: row[3],
      max_passengers: row[4],
      range_km: row[5],
      cruise_speed_kmh: row[6],
      new_price_usd: row[7],
      required_level: row[8],
      image_filename: row[9],
      can_purchase: airlineLevel >= row[8]
    }));

    res.json({ aircraft_types: aircraftTypes, airline_level: airlineLevel });
  } catch (error) {
    console.error('Get aircraft types error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get aircraft market (types for purchase) with optional manufacturer filter
router.get('/market', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();
    const { manufacturer } = req.query;

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });
    const airlineLvlStmt = db.prepare('SELECT level FROM airlines WHERE id = ?');
    airlineLvlStmt.bind([airlineId]);
    if (!airlineLvlStmt.step()) {
      airlineLvlStmt.free();
      return res.status(400).json({ error: 'No airline found' });
    }
    const airlineLevel = airlineLvlStmt.get()[0];
    airlineLvlStmt.free();

    const { wake_category } = req.query;

    let query = `SELECT id, manufacturer, model, full_name, max_passengers, range_km,
      cruise_speed_kmh, min_runway_takeoff_m, min_runway_landing_m,
      fuel_consumption_per_km,
      wake_turbulence_category, required_pilots,
      new_price_usd, required_level, image_filename FROM aircraft_types`;
    const params = [];
    const conditions = [];

    if (manufacturer && manufacturer !== 'All') {
      conditions.push('manufacturer = ?');
      params.push(manufacturer);
    }
    if (wake_category && wake_category !== 'All') {
      conditions.push('wake_turbulence_category = ?');
      params.push(wake_category);
    }
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY new_price_usd ASC';

    const stmt = db.prepare(query);
    if (params.length > 0) {
      stmt.bind(params);
    }

    const aircraftTypes = [];
    while (stmt.step()) {
      const row = stmt.get();
      aircraftTypes.push({
        id: row[0],
        manufacturer: row[1],
        model: row[2],
        full_name: row[3],
        max_passengers: row[4],
        range_km: row[5],
        cruise_speed_kmh: row[6],
        min_runway_takeoff_m: row[7],
        min_runway_landing_m: row[8],
        fuel_consumption_per_km: row[9],
        wake_turbulence_category: row[10],
        required_pilots: row[11],
        new_price_usd: row[12],
        required_level: row[13],
        image_filename: row[14],
        can_purchase: airlineLevel >= row[13]
      });
    }
    stmt.free();

    // Always return full lists for filter dropdowns (unaffected by filters)
    const mfgResult = db.exec('SELECT DISTINCT manufacturer FROM aircraft_types ORDER BY manufacturer');
    const manufacturers = mfgResult.length ? mfgResult[0].values.map(row => row[0]) : [];

    const wakeResult = db.exec('SELECT DISTINCT wake_turbulence_category FROM aircraft_types ORDER BY wake_turbulence_category');
    const wakeCategories = wakeResult.length ? wakeResult[0].values.map(row => row[0]) : [];

    res.json({
      aircraft_types: aircraftTypes,
      manufacturers,
      wake_categories: wakeCategories,
      airline_level: airlineLevel
    });
  } catch (error) {
    console.error('Get aircraft market error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's fleet (individual aircraft)
router.get('/fleet', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Get fleet with aircraft type details
    const fleetStmt = db.prepare(`
      SELECT a.id, a.registration, a.name, a.purchased_at, a.home_airport, a.condition, a.is_active,
             t.manufacturer, t.model, t.full_name, t.max_passengers, t.range_km, t.id as type_id,
             t.image_filename, a.airline_cabin_profile_id, acp.name as airline_cabin_profile_name,
             a.current_location,
             t.new_price_usd, t.depreciation_age, t.depreciation_fh, a.total_flight_hours,
             a.is_listed_for_sale,
             (SELECT current_value FROM used_aircraft_market WHERE seller_aircraft_id = a.id LIMIT 1) as listed_price
      FROM aircraft a
      JOIN aircraft_types t ON a.aircraft_type_id = t.id
      LEFT JOIN airline_cabin_profiles acp ON a.airline_cabin_profile_id = acp.id
      WHERE a.airline_id = ?
      ORDER BY a.purchased_at DESC
    `);
    fleetStmt.bind([airlineId]);

    const fleet = [];
    while (fleetStmt.step()) {
      const row = fleetStmt.get();
      fleet.push({
        id: row[0],
        registration: row[1],
        name: row[2],
        purchased_at: row[3],
        home_airport: row[4],
        condition: row[5],
        is_active: row[6] ?? 0,
        manufacturer: row[7],
        model: row[8],
        full_name: row[9],
        max_passengers: row[10],
        range_km: row[11],
        type_id: row[12],
        image_filename: row[13],
        airline_cabin_profile_id: row[14] ?? null,
        airline_cabin_profile_name: row[15] ?? null,
        current_location: row[16] ?? null,
        new_price_usd: row[17],
        depreciation_age: row[18],
        depreciation_fh: row[19],
        total_flight_hours: row[20] ?? 0,
        is_listed_for_sale: row[21] ?? 0,
        listed_price: row[22] ?? null,
      });
    }
    fleetStmt.free();

    res.json({ fleet });
  } catch (error) {
    console.error('Get fleet error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's fleet grouped by type with counts
router.get('/fleet/grouped', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Get fleet grouped by type
    const groupedStmt = db.prepare(`
      SELECT t.id as type_id, t.manufacturer, t.model, t.full_name, t.max_passengers, t.range_km,
             COUNT(a.id) as count, t.image_filename
      FROM aircraft a
      JOIN aircraft_types t ON a.aircraft_type_id = t.id
      WHERE a.airline_id = ?
      GROUP BY t.id
      ORDER BY t.manufacturer, t.model
    `);
    groupedStmt.bind([airlineId]);

    const fleetGrouped = [];
    let totalCount = 0;
    while (groupedStmt.step()) {
      const row = groupedStmt.get();
      const count = row[6];
      totalCount += count;
      fleetGrouped.push({
        type_id: row[0],
        manufacturer: row[1],
        model: row[2],
        full_name: row[3],
        max_passengers: row[4],
        range_km: row[5],
        count: count,
        image_filename: row[7]
      });
    }
    groupedStmt.free();

    res.json({ fleet: fleetGrouped, total_count: totalCount });
  } catch (error) {
    console.error('Get grouped fleet error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get fleet overview: individual aircraft with current status and active flight info
router.get('/fleet/overview', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Query 1: all aircraft with type and home airport name
    const acStmt = db.prepare(`
      SELECT
        a.id, a.registration, a.name, a.home_airport, a.condition, a.is_active,
        t.full_name AS aircraft_type,
        ap.name AS home_airport_name
      FROM aircraft a
      JOIN aircraft_types t ON a.aircraft_type_id = t.id
      LEFT JOIN airports ap ON a.home_airport = ap.iata_code
      WHERE a.airline_id = ?
      ORDER BY a.home_airport, a.registration
    `);
    acStmt.bind([airlineId]);

    const aircraft = [];
    while (acStmt.step()) {
      const row = acStmt.get();
      aircraft.push({
        id: row[0],
        registration: row[1],
        name: row[2],
        home_airport: row[3],
        condition: row[4],
        is_active: row[5] ?? 0,
        aircraft_type: row[6],
        home_airport_name: row[7],
        active_fn: null,
        active_dep: null,
        active_arr: null,
        active_flight_status: null
      });
    }
    acStmt.free();

    // Query 2: currently active flights (boarding or in-flight)
    const flightStmt = db.prepare(`
      SELECT aircraft_id, flight_number, departure_airport, arrival_airport, status
      FROM flights
      WHERE airline_id = ? AND status IN ('boarding', 'in-flight')
    `);
    flightStmt.bind([airlineId]);

    const activeFlights = {};
    while (flightStmt.step()) {
      const row = flightStmt.get();
      activeFlights[row[0]] = {
        active_fn: row[1],
        active_dep: row[2],
        active_arr: row[3],
        active_flight_status: row[4]
      };
    }
    flightStmt.free();

    // Merge active flight data onto aircraft
    for (const ac of aircraft) {
      if (activeFlights[ac.id]) {
        Object.assign(ac, activeFlights[ac.id]);
      }
    }

    res.json({ aircraft });
  } catch (error) {
    console.error('Get fleet overview error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Generate unique registration for new aircraft purchases
// Uses the same format logic as the used market
function generateRegistration(db, prefix) {
  return genRegForPrefix(db, prefix);
}

// Purchase aircraft (supports quantity and delivery airport)
router.post('/purchase',
  authMiddleware,
  body('typeId').optional().isInt({ min: 1 }).withMessage('Invalid aircraft type'),
  body('aircraft_type_id').optional().isInt({ min: 1 }).withMessage('Invalid aircraft type'),
  body('quantity').optional().isInt({ min: 1, max: 10 }).withMessage('Quantity must be between 1 and 10'),
  body('deliveryAirport').optional().isLength({ min: 3, max: 3 }).withMessage('Invalid airport code'),
  body('name').optional().isLength({ max: 50 }).trim(),
  (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      // Support both typeId and aircraft_type_id for backwards compatibility
      const aircraft_type_id = req.body.typeId || req.body.aircraft_type_id;
      const quantity = req.body.quantity || 1;
      const deliveryAirport = req.body.deliveryAirport;
      const { name } = req.body;

      if (!aircraft_type_id) {
        return res.status(400).json({ error: 'Aircraft type ID is required' });
      }

      const db = getDatabase();

      // Get airline details
      const airlineStmt = db.prepare(`
        SELECT a.id, a.balance, a.level, a.home_airport_code
        FROM airlines a
        WHERE a.user_id = ?
      `);
      airlineStmt.bind([req.userId]);

      if (!airlineStmt.step()) {
        airlineStmt.free();
        return res.status(400).json({ error: 'No airline found' });
      }

      const airlineRow = airlineStmt.get();
      const airline = {
        id: airlineRow[0],
        balance: airlineRow[1],
        level: airlineRow[2],
        home_airport_code: airlineRow[3]
      };
      airlineStmt.free();

      // Registration prefix always from airline's home base, not delivery airport
      const airportStmt = db.prepare('SELECT registration_prefix FROM airports WHERE iata_code = ?');
      airportStmt.bind([airline.home_airport_code]);

      if (!airportStmt.step()) {
        airportStmt.free();
        return res.status(400).json({ error: 'Invalid delivery airport' });
      }

      const registrationPrefix = airportStmt.get()[0];
      airportStmt.free();

      // Get aircraft type
      const typeStmt = db.prepare('SELECT id, manufacturer, model, full_name, max_passengers, range_km, new_price_usd, required_level, image_filename FROM aircraft_types WHERE id = ?');
      typeStmt.bind([aircraft_type_id]);

      if (!typeStmt.step()) {
        typeStmt.free();
        return res.status(400).json({ error: 'Aircraft type not found' });
      }

      const typeRow = typeStmt.get();
      const aircraftType = {
        id: typeRow[0],
        manufacturer: typeRow[1],
        model: typeRow[2],
        full_name: typeRow[3],
        max_passengers: typeRow[4],
        range_km: typeRow[5],
        new_price_usd: typeRow[6],
        required_level: typeRow[7],
        image_filename: typeRow[8]
      };
      typeStmt.free();

      // Check level requirement
      if (airline.level < aircraftType.required_level) {
        return res.status(400).json({
          error: `Requires level ${aircraftType.required_level}. Your airline is level ${airline.level}.`
        });
      }

      // Calculate total cost
      const totalCost = aircraftType.new_price_usd * quantity;

      // Check balance
      if (airline.balance < totalCost) {
        return res.status(400).json({
          error: `Insufficient funds. Need $${totalCost.toLocaleString()}, have $${airline.balance.toLocaleString()}`
        });
      }

      // Purchase aircraft
      const purchasedAircraft = [];
      for (let i = 0; i < quantity; i++) {
        // Generate registration
        const registration = generateRegistration(db, registrationPrefix);

        // Create aircraft
        const insertStmt = db.prepare(
          'INSERT INTO aircraft (airline_id, aircraft_type_id, registration, name, home_airport, current_location, condition, is_active) VALUES (?, ?, ?, ?, ?, ?, 100, 0)'
        );
        insertStmt.bind([airline.id, aircraft_type_id, registration, name || null, homeAirport, deliveryAirport || homeAirport]);
        insertStmt.step();
        insertStmt.free();

        // Get the created aircraft ID
        const fetchStmt = db.prepare('SELECT id FROM aircraft WHERE registration = ?');
        fetchStmt.bind([registration]);
        fetchStmt.step();
        const aircraftId = fetchStmt.get()[0];
        fetchStmt.free();

        // Assign user-defined cabin profile if provided
        if (req.body.cabin_profile_id) {
          try {
            const cpUpdateStmt = db.prepare(
              'UPDATE aircraft SET airline_cabin_profile_id = ? WHERE id = ?'
            );
            cpUpdateStmt.bind([req.body.cabin_profile_id, aircraftId]);
            cpUpdateStmt.step();
            cpUpdateStmt.free();
          } catch (e) { /* ignore if column doesn't exist yet */ }
        }

        purchasedAircraft.push({
          id: aircraftId,
          registration,
          name: name || null,
          home_airport: homeAirport
        });
      }

      // Deduct balance
      const newBalance = airline.balance - totalCost;
      const updateBalanceStmt = db.prepare('UPDATE airlines SET balance = ? WHERE id = ?');
      updateBalanceStmt.bind([newBalance, airline.id]);
      updateBalanceStmt.step();
      updateBalanceStmt.free();

      // Record transaction
      const txnStmt = db.prepare(
        'INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, ?, ?, ?)'
      );
      txnStmt.bind([
        airline.id,
        'aircraft_purchase',
        -totalCost,
        `Purchased ${quantity}x ${aircraftType.full_name}`
      ]);
      txnStmt.step();
      txnStmt.free();

      saveDatabase();

      res.status(201).json({
        message: `Successfully purchased ${quantity} ${aircraftType.full_name}${quantity > 1 ? 's' : ''}`,
        aircraft: purchasedAircraft.map(a => ({
          ...a,
          full_name: aircraftType.full_name,
          manufacturer: aircraftType.manufacturer,
          model: aircraftType.model,
          max_passengers: aircraftType.max_passengers,
          range_km: aircraftType.range_km
        })),
        quantity,
        total_cost: totalCost,
        new_balance: newBalance
      });
    } catch (error) {
      console.error('Purchase aircraft error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Get single aircraft detail with cabin profile and weekly schedule
router.get('/:id/detail', authMiddleware, (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Get aircraft with type and cabin profile
    const acStmt = db.prepare(`
      SELECT a.id, a.registration, a.name, a.home_airport, a.condition,
             a.aircraft_type_id, a.is_active, a.cabin_profile_id,
             t.manufacturer, t.model, t.full_name, t.max_passengers, t.range_km,
             t.image_filename, t.id as type_id, a.airline_cabin_profile_id,
             a.current_location, a.crew_assigned,
             t.new_price_usd, t.depreciation_age, t.depreciation_fh,
             a.total_flight_hours, a.purchased_at, t.wake_turbulence_category
      FROM aircraft a
      JOIN aircraft_types t ON a.aircraft_type_id = t.id
      WHERE a.id = ? AND a.airline_id = ?
    `);
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) {
      acStmt.free();
      return res.status(404).json({ error: 'Aircraft not found' });
    }
    const row = acStmt.get();
    const aircraft = {
      id: row[0], registration: row[1], name: row[2],
      home_airport: row[3], condition: row[4],
      aircraft_type_id: row[5], is_active: row[6] ?? 0,
      cabin_profile_id: row[7],
      manufacturer: row[8], model: row[9], full_name: row[10],
      max_passengers: row[11], range_km: row[12],
      image_filename: row[13], type_id: row[14],
      airline_cabin_profile_id: row[15] ?? null,
      current_location: row[16] ?? null,
      crew_assigned: row[17] ?? 0,
      new_price_usd: row[18] ?? 0,
      depreciation_age: row[19] ?? 0.055,
      depreciation_fh: row[20] ?? 0.000010,
      total_flight_hours: row[21] ?? 0,
      purchased_at: row[22] ?? null,
      wake_turbulence_category: row[23] ?? 'M'
    };
    acStmt.free();

    // Get cabin profile if set (airline_cabin_profiles is the current table)
    let cabin_profile = null;
    if (aircraft.cabin_profile_id) {
      try {
        const cpStmt = db.prepare('SELECT id, name FROM airline_cabin_profiles WHERE id = ?');
        cpStmt.bind([aircraft.cabin_profile_id]);
        if (cpStmt.step()) {
          const cpRow = cpStmt.get();
          cabin_profile = { id: cpRow[0], name: cpRow[1] };
        }
        cpStmt.free();
      } catch (e) {
        // legacy cabin_profiles table may not exist — ignore
      }
    }

    // Home airport name
    let home_airport_name = null;
    if (aircraft.home_airport) {
      const haStmt = db.prepare('SELECT name FROM airports WHERE iata_code = ?');
      haStmt.bind([aircraft.home_airport]);
      if (haStmt.step()) home_airport_name = haStmt.get()[0];
      haStmt.free();
    }

    // Current in-flight status
    let current_flight = null;
    const cfStmt = db.prepare(`
      SELECT f.flight_number, f.departure_time, f.arrival_time,
             COALESCE(r.departure_airport, ws.departure_airport) as dep_code,
             dep.name,
             COALESCE(r.arrival_airport, ws.arrival_airport) as arr_code,
             arr.name
      FROM flights f
      LEFT JOIN routes r ON f.route_id = r.id
      LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
      LEFT JOIN airports dep ON dep.iata_code = COALESCE(r.departure_airport, ws.departure_airport)
      LEFT JOIN airports arr ON arr.iata_code = COALESCE(r.arrival_airport, ws.arrival_airport)
      WHERE f.aircraft_id = ? AND f.status = 'in-flight'
      ORDER BY f.departure_time DESC LIMIT 1
    `);
    cfStmt.bind([aircraftId]);
    if (cfStmt.step()) {
      const cf = cfStmt.get();
      current_flight = {
        flight_number: cf[0], departure_time: cf[1], arrival_time: cf[2],
        departure_airport: cf[3], departure_name: cf[4],
        arrival_airport: cf[5], arrival_name: cf[6]
      };
    }
    cfStmt.free();

    // Current location when on ground: stored current_location column (updated when flights complete)
    let current_location = null;
    if (!current_flight) {
      const locCode = aircraft.current_location || aircraft.home_airport;
      if (locCode) {
        const locStmt = db.prepare('SELECT name FROM airports WHERE iata_code = ?');
        locStmt.bind([locCode]);
        const locName = locStmt.step() ? locStmt.get()[0] : locCode;
        locStmt.free();
        current_location = { code: locCode, name: locName };
      }
    }

    // Stats
    let total_flights = 0, total_profit = 0, total_passengers = 0;
    const statsStmt = db.prepare(`
      SELECT COUNT(*),
             COALESCE(SUM(
               revenue
               - COALESCE(fuel_cost, 0)
               - COALESCE(atc_fee, 0)
               - COALESCE(landing_fee, 0)
               - COALESCE(ground_handling_cost, 0)
               - COALESCE(catering_cost, 0)
             ), 0),
             COALESCE(SUM(seats_sold), 0)
      FROM flights WHERE aircraft_id = ? AND status = 'completed'
    `);
    statsStmt.bind([aircraftId]);
    if (statsStmt.step()) {
      const sr = statsStmt.get();
      total_flights = sr[0]; total_profit = sr[1]; total_passengers = sr[2];
    }
    statsStmt.free();

    // Get weekly schedule
    const wsStmt = db.prepare(`
      SELECT id, day_of_week, flight_number, departure_airport, arrival_airport, departure_time, arrival_time
      FROM weekly_schedule WHERE aircraft_id = ? ORDER BY day_of_week, departure_time
    `);
    wsStmt.bind([aircraftId]);
    const weekly_schedule = [];
    while (wsStmt.step()) {
      const wsRow = wsStmt.get();
      weekly_schedule.push({
        id: wsRow[0], day_of_week: wsRow[1], flight_number: wsRow[2],
        departure_airport: wsRow[3], arrival_airport: wsRow[4],
        departure_time: wsRow[5], arrival_time: wsRow[6]
      });
    }
    wsStmt.free();

    res.json({
      aircraft: { ...aircraft, home_airport_name },
      cabin_profile, weekly_schedule,
      current_flight, current_location,
      stats: { total_flights, total_profit, total_passengers }
    });
  } catch (error) {
    console.error('Get aircraft detail error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get cabin profiles for an aircraft type
router.get('/:id/cabin-profiles', authMiddleware, (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const db = getDatabase();

    // Get airline ID and verify ownership
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Get aircraft type
    const acStmt = db.prepare('SELECT aircraft_type_id FROM aircraft WHERE id = ? AND airline_id = ?');
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) {
      acStmt.free();
      return res.status(404).json({ error: 'Aircraft not found' });
    }
    const typeId = acStmt.get()[0];
    acStmt.free();

    // Get cabin profiles for this type
    const cpStmt = db.prepare('SELECT id, name, aircraft_type_id, economy_seats, business_seats, first_seats FROM cabin_profiles WHERE aircraft_type_id = ?');
    cpStmt.bind([typeId]);
    const profiles = [];
    while (cpStmt.step()) {
      const row = cpStmt.get();
      profiles.push({
        id: row[0], name: row[1], aircraft_type_id: row[2],
        economy_seats: row[3], business_seats: row[4], first_seats: row[5]
      });
    }
    cpStmt.free();

    res.json({ profiles });
  } catch (error) {
    console.error('Get cabin profiles error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update aircraft cabin profile
router.put('/:id/cabin-profile', authMiddleware, (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const { cabinProfileId } = req.body;
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Verify aircraft ownership
    const acStmt = db.prepare('SELECT id, aircraft_type_id FROM aircraft WHERE id = ? AND airline_id = ?');
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) {
      acStmt.free();
      return res.status(404).json({ error: 'Aircraft not found' });
    }
    const typeId = acStmt.get()[1];
    acStmt.free();

    // Verify cabin profile belongs to this aircraft type
    if (cabinProfileId) {
      const cpStmt = db.prepare('SELECT id FROM cabin_profiles WHERE id = ? AND aircraft_type_id = ?');
      cpStmt.bind([cabinProfileId, typeId]);
      if (!cpStmt.step()) {
        cpStmt.free();
        return res.status(400).json({ error: 'Cabin profile not valid for this aircraft type' });
      }
      cpStmt.free();
    }

    const updateStmt = db.prepare('UPDATE aircraft SET cabin_profile_id = ? WHERE id = ?');
    updateStmt.bind([cabinProfileId || null, aircraftId]);
    updateStmt.step();
    updateStmt.free();

    saveDatabase();

    res.json({ message: 'Cabin profile updated' });
  } catch (error) {
    console.error('Update cabin profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Assign user-defined cabin profile to aircraft
router.patch('/:id/airline-cabin-profile', authMiddleware, (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const { profile_id } = req.body;
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });
    const airlineBalStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    airlineBalStmt.bind([airlineId]);
    if (!airlineBalStmt.step()) {
      airlineBalStmt.free();
      return res.status(400).json({ error: 'No airline found' });
    }
    const currentBalance = airlineBalStmt.get()[0];
    airlineBalStmt.free();

    const acStmt = db.prepare('SELECT id, aircraft_type_id, registration FROM aircraft WHERE id = ? AND airline_id = ?');
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) {
      acStmt.free();
      return res.status(404).json({ error: 'Aircraft not found' });
    }
    const acInfo = acStmt.get();
    const typeId = acInfo[1];
    const registration = acInfo[2];
    acStmt.free();

    if (profile_id) {
      const cpStmt = db.prepare(
        'SELECT id FROM airline_cabin_profiles WHERE id = ? AND airline_id = ? AND aircraft_type_id = ?'
      );
      cpStmt.bind([profile_id, airlineId, typeId]);
      if (!cpStmt.step()) {
        cpStmt.free();
        return res.status(400).json({ error: 'Cabin profile not valid for this aircraft type' });
      }
      cpStmt.free();
    }

    // Cancel upcoming scheduled flights and calculate penalty
    const now = new Date();
    const threeDaysLater = new Date(now.getTime() + 3 * 24 * 3600 * 1000);
    const flightStmt = db.prepare(`
      SELECT id, booked_economy, booked_business, booked_first,
             economy_price, business_price, first_price, booking_revenue_collected
      FROM flights
      WHERE aircraft_id = ? AND status IN ('scheduled', 'boarding')
        AND departure_time >= ? AND departure_time <= ?
    `);
    flightStmt.bind([aircraftId, now.toISOString(), threeDaysLater.toISOString()]);
    const flightsToCancel = [];
    while (flightStmt.step()) {
      const r = flightStmt.get();
      flightsToCancel.push({
        id: r[0],
        booked_economy: r[1] || 0, booked_business: r[2] || 0, booked_first: r[3] || 0,
        economy_price: r[4] || 0, business_price: r[5] || 0, first_price: r[6] || 0,
        booking_revenue_collected: r[7] || 0
      });
    }
    flightStmt.free();

    let penalty = 0;
    for (const f of flightsToCancel) {
      // Only penalize flights where booking revenue was already collected
      if (!f.booking_revenue_collected) continue;
      penalty += f.booked_economy  * f.economy_price  * 1.2;
      penalty += f.booked_business * (f.business_price || f.economy_price) * 1.2;
      penalty += f.booked_first    * (f.first_price    || f.economy_price) * 1.2;
    }
    penalty = Math.round(penalty);

    // Cancel the flights
    if (flightsToCancel.length > 0) {
      const ids = flightsToCancel.map(() => '?').join(',');
      const cancelStmt = db.prepare(`UPDATE flights SET status = 'cancelled' WHERE id IN (${ids})`);
      cancelStmt.bind(flightsToCancel.map(f => f.id));
      cancelStmt.step();
      cancelStmt.free();
    }

    // Delete weekly schedule template
    const deleteSchedStmt = db.prepare('DELETE FROM weekly_schedule WHERE aircraft_id = ?');
    deleteSchedStmt.bind([aircraftId]);
    deleteSchedStmt.step();
    deleteSchedStmt.free();

    // Deduct penalty from balance
    if (penalty > 0) {
      const newBalance = currentBalance - penalty;
      const updBalStmt = db.prepare('UPDATE airlines SET balance = ? WHERE id = ?');
      updBalStmt.bind([newBalance, airlineId]);
      updBalStmt.step();
      updBalStmt.free();

      const txStmt = db.prepare("INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'other', ?, ?)");
      txStmt.bind([airlineId, -penalty, `Flight Cancellation Penalty - Cabin Profile Change (${registration})`]);
      txStmt.step();
      txStmt.free();
    }

    // Deactivate the aircraft and update cabin profile
    const updateStmt = db.prepare('UPDATE aircraft SET airline_cabin_profile_id = ?, is_active = 0 WHERE id = ?');
    updateStmt.bind([profile_id || null, aircraftId]);
    updateStmt.step();
    updateStmt.free();

    saveDatabase();
    res.json({
      message: 'Cabin profile updated',
      cancelled_flights: flightsToCancel.length,
      penalty
    });
  } catch (error) {
    console.error('Assign cabin profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Simple cabin profile assignment (fleet edit mode) — no destructive side effects
// Only allowed when aircraft is inactive (is_active = 0)
router.patch('/:id/cabin-profile-fleet', authMiddleware, (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const { profile_id } = req.body;
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acStmt = db.prepare('SELECT id, aircraft_type_id, is_active FROM aircraft WHERE id = ? AND airline_id = ?');
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) { acStmt.free(); return res.status(404).json({ error: 'Aircraft not found' }); }
    const acRow = acStmt.get();
    const typeId = acRow[1];
    const isActive = acRow[2];
    acStmt.free();

    if (isActive) {
      return res.status(400).json({ error: 'Deactivate the aircraft before changing its cabin profile' });
    }

    if (profile_id) {
      const cpStmt = db.prepare('SELECT id FROM airline_cabin_profiles WHERE id = ? AND airline_id = ? AND aircraft_type_id = ?');
      cpStmt.bind([profile_id, airlineId, typeId]);
      if (!cpStmt.step()) { cpStmt.free(); return res.status(400).json({ error: 'Cabin profile not valid for this aircraft type' }); }
      cpStmt.free();
    }

    const updateStmt = db.prepare('UPDATE aircraft SET airline_cabin_profile_id = ? WHERE id = ?');
    updateStmt.bind([profile_id || null, aircraftId]);
    updateStmt.step();
    updateStmt.free();

    saveDatabase();
    res.json({ message: 'Cabin profile updated' });
  } catch (error) {
    console.error('Fleet cabin profile update error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update aircraft name
router.patch('/:id/name', authMiddleware, (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const { name } = req.body;
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acStmt = db.prepare('SELECT id FROM aircraft WHERE id = ? AND airline_id = ?');
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) {
      acStmt.free();
      return res.status(404).json({ error: 'Aircraft not found' });
    }
    acStmt.free();

    const updateStmt = db.prepare('UPDATE aircraft SET name = ? WHERE id = ?');
    updateStmt.bind([name || null, aircraftId]);
    updateStmt.step();
    updateStmt.free();

    saveDatabase();

    res.json({ message: 'Aircraft name updated' });
  } catch (error) {
    console.error('Update aircraft name error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/:id/home-airport', authMiddleware, (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const { home_airport } = req.body;
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acStmt = db.prepare('SELECT id FROM aircraft WHERE id = ? AND airline_id = ?');
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) { acStmt.free(); return res.status(404).json({ error: 'Aircraft not found' }); }
    acStmt.free();

    const updateStmt = db.prepare('UPDATE aircraft SET home_airport = ? WHERE id = ?');
    updateStmt.bind([home_airport || null, aircraftId]);
    updateStmt.step();
    updateStmt.free();

    saveDatabase();
    res.json({ message: 'Home airport updated' });
  } catch (error) {
    console.error('Update home airport error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get upcoming flights (next 4 days from weekly schedule)
router.get('/:id/upcoming-flights', authMiddleware, (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Verify aircraft ownership and get cabin profile
    const acStmt = db.prepare('SELECT id, cabin_profile_id FROM aircraft WHERE id = ? AND airline_id = ?');
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) {
      acStmt.free();
      return res.status(404).json({ error: 'Aircraft not found' });
    }
    const cabinProfileId = acStmt.get()[1];
    acStmt.free();

    // Get cabin profile seat counts
    let economy_total = 0, business_total = 0, first_total = 0;
    if (cabinProfileId) {
      const cpStmt = db.prepare('SELECT economy_seats, business_seats, first_seats FROM cabin_profiles WHERE id = ?');
      cpStmt.bind([cabinProfileId]);
      if (cpStmt.step()) {
        const cpRow = cpStmt.get();
        economy_total = cpRow[0];
        business_total = cpRow[1];
        first_total = cpRow[2];
      }
      cpStmt.free();
    }

    // Get weekly schedule entries
    const wsStmt = db.prepare(`
      SELECT id, day_of_week, flight_number, departure_airport, arrival_airport, departure_time, arrival_time
      FROM weekly_schedule WHERE aircraft_id = ? ORDER BY day_of_week, departure_time
    `);
    wsStmt.bind([aircraftId]);
    const scheduleEntries = [];
    while (wsStmt.step()) {
      const row = wsStmt.get();
      scheduleEntries.push({
        id: row[0], day_of_week: row[1], flight_number: row[2],
        departure_airport: row[3], arrival_airport: row[4],
        departure_time: row[5], arrival_time: row[6]
      });
    }
    wsStmt.free();

    // Generate upcoming flights for next 4 days
    const now = new Date();
    const upcomingFlights = [];

    for (let dayOffset = 0; dayOffset < 4; dayOffset++) {
      const date = new Date(now);
      date.setDate(date.getDate() + dayOffset);
      // day_of_week: 0=Mon, 1=Tue, ..., 6=Sun
      const jsDay = date.getDay(); // 0=Sun, 1=Mon, ...
      const dayOfWeek = jsDay === 0 ? 6 : jsDay - 1;

      const dayEntries = scheduleEntries.filter(e => e.day_of_week === dayOfWeek);
      const dateStr = date.toISOString().split('T')[0];

      for (const entry of dayEntries) {
        // Check if a matching flight already exists in flights table for this date
        const checkStmt = db.prepare(`
          SELECT id, booked_economy, booked_business, booked_first, status
          FROM flights
          WHERE aircraft_id = ? AND airline_id = ? AND flight_number = ?
            AND date(departure_time) = date(?)
        `);
        checkStmt.bind([aircraftId, airlineId, entry.flight_number, dateStr]);

        let flightId = null, booked_economy = 0, booked_business = 0, booked_first = 0, status = 'scheduled';
        if (checkStmt.step()) {
          const fRow = checkStmt.get();
          flightId = fRow[0];
          booked_economy = fRow[1] || 0;
          booked_business = fRow[2] || 0;
          booked_first = fRow[3] || 0;
          status = fRow[4];
        }
        checkStmt.free();

        upcomingFlights.push({
          flight_id: flightId,
          schedule_id: entry.id,
          flight_number: entry.flight_number,
          departure_airport: entry.departure_airport,
          arrival_airport: entry.arrival_airport,
          departure_time: `${dateStr}T${entry.departure_time}`,
          arrival_time: `${dateStr}T${entry.arrival_time}`,
          date: dateStr,
          day_of_week: dayOfWeek,
          status,
          booked_economy,
          booked_business,
          booked_first,
          economy_total,
          business_total,
          first_total
        });
      }
    }

    res.json({ upcoming_flights: upcomingFlights });
  } catch (error) {
    console.error('Get upcoming flights error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add entry to weekly schedule
router.post('/:id/weekly-schedule', authMiddleware, (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const { day_of_week, flight_number, departure_airport, arrival_airport, departure_time, arrival_time } = req.body;
    const db = getDatabase();

    // Validate
    if (day_of_week === undefined || !flight_number || !departure_airport || !arrival_airport || !departure_time || !arrival_time) {
      return res.status(400).json({ error: 'All fields required: day_of_week, flight_number, departure_airport, arrival_airport, departure_time, arrival_time' });
    }

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Verify aircraft ownership
    const acStmt = db.prepare('SELECT id FROM aircraft WHERE id = ? AND airline_id = ?');
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) {
      acStmt.free();
      return res.status(404).json({ error: 'Aircraft not found' });
    }
    acStmt.free();

    const insertStmt = db.prepare(`
      INSERT INTO weekly_schedule (aircraft_id, day_of_week, flight_number, departure_airport, arrival_airport, departure_time, arrival_time)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertStmt.bind([aircraftId, day_of_week, flight_number, departure_airport, arrival_airport, departure_time, arrival_time]);
    insertStmt.step();
    insertStmt.free();

    const idStmt = db.prepare('SELECT last_insert_rowid()');
    idStmt.step();
    const newId = idStmt.get()[0];
    idStmt.free();

    saveDatabase();

    res.status(201).json({
      message: 'Weekly schedule entry added',
      entry: { id: newId, aircraft_id: aircraftId, day_of_week, flight_number, departure_airport, arrival_airport, departure_time, arrival_time }
    });
  } catch (error) {
    console.error('Add weekly schedule error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete entry from weekly schedule
router.delete('/:id/weekly-schedule/:entryId', authMiddleware, (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const entryId = parseInt(req.params.entryId);
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Verify aircraft ownership
    const acStmt = db.prepare('SELECT id, is_active FROM aircraft WHERE id = ? AND airline_id = ?');
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) {
      acStmt.free();
      return res.status(404).json({ error: 'Aircraft not found' });
    }
    const isOpForEntry = acStmt.get()[1];
    acStmt.free();

    if (isOpForEntry) {
      return res.status(400).json({ error: 'Aircraft must be inactive to edit schedule. Deactivate the aircraft first.' });
    }

    // Delete entry
    const deleteStmt = db.prepare('DELETE FROM weekly_schedule WHERE id = ? AND aircraft_id = ?');
    deleteStmt.bind([entryId, aircraftId]);
    deleteStmt.step();
    deleteStmt.free();

    saveDatabase();

    res.json({ message: 'Weekly schedule entry deleted' });
  } catch (error) {
    console.error('Delete weekly schedule error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get aircraft schedule (weekly template — no dates)
router.get('/:id/schedule', authMiddleware, (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acStmt = db.prepare(`
      SELECT a.id, a.registration, a.name, a.home_airport, a.condition,
             t.manufacturer, t.model, t.full_name, t.max_passengers, t.range_km, t.id as type_id,
             a.is_active, t.image_filename,
             cp.id as cp_id, cp.name as cp_name,
             cp.economy_seats, cp.business_seats, cp.first_seats,
             a.airline_cabin_profile_id, t.wake_turbulence_category
      FROM aircraft a
      JOIN aircraft_types t ON a.aircraft_type_id = t.id
      LEFT JOIN cabin_profiles cp ON a.cabin_profile_id = cp.id
      WHERE a.id = ? AND a.airline_id = ?
    `);
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) { acStmt.free(); return res.status(404).json({ error: 'Aircraft not found' }); }
    const acRow = acStmt.get();
    const aircraft = {
      id: acRow[0], registration: acRow[1], name: acRow[2],
      home_airport: acRow[3], condition: acRow[4],
      manufacturer: acRow[5], model: acRow[6], full_name: acRow[7],
      max_passengers: acRow[8], range_km: acRow[9], type_id: acRow[10],
      is_active: acRow[11] ?? 0, image_filename: acRow[12],
      airline_cabin_profile_id: acRow[18] ?? null,
      wake_turbulence_category: acRow[19] ?? 'M'
    };
    const cabin_profile = acRow[13] ? {
      id: acRow[13], name: acRow[14],
      economy_seats: acRow[15], business_seats: acRow[16], first_seats: acRow[17]
    } : null;
    acStmt.free();

    // All airline routes (including stored prices + service profile)
    const routesStmt = db.prepare(`
      SELECT r.id, r.flight_number, r.departure_airport, r.arrival_airport, r.distance_km,
             r.economy_price, r.business_price, r.first_price, r.service_profile_id
      FROM routes r WHERE r.airline_id = ? ORDER BY r.flight_number
    `);
    routesStmt.bind([airlineId]);
    const routes = [];
    while (routesStmt.step()) {
      const row = routesStmt.get();
      routes.push({
        id: row[0], flight_number: row[1],
        departure_airport: row[2], arrival_airport: row[3],
        distance_km: row[4],
        economy_price: row[5], business_price: row[6], first_price: row[7],
        service_profile_id: row[8],
        estimated_duration: calculateFlightDuration(row[4])
      });
    }
    routesStmt.free();

    // Weekly schedule template entries
    const schedStmt = db.prepare(`
      SELECT ws.id, ws.day_of_week, ws.flight_number,
             ws.departure_airport, ws.arrival_airport,
             ws.departure_time, ws.arrival_time,
             ws.economy_price, ws.business_price, ws.first_price, ws.route_id,
             ws.service_profile_id
      FROM weekly_schedule ws
      WHERE ws.aircraft_id = ?
      ORDER BY ws.day_of_week, ws.departure_time
    `);
    schedStmt.bind([aircraftId]);
    const schedule = [];
    while (schedStmt.step()) {
      const row = schedStmt.get();
      schedule.push({
        id: row[0], day_of_week: row[1], flight_number: row[2],
        departure_airport: row[3], arrival_airport: row[4],
        departure_time: row[5], arrival_time: row[6],
        economy_price: row[7], business_price: row[8], first_price: row[9],
        route_id: row[10], service_profile_id: row[11]
      });
    }
    schedStmt.free();

    // Maintenance template entries (day_of_week based)
    const maintStmt = db.prepare(`
      SELECT id, day_of_week, start_minutes, duration_minutes, type, status
      FROM maintenance_schedule
      WHERE aircraft_id = ? AND airline_id = ? AND day_of_week IS NOT NULL
      ORDER BY day_of_week, start_minutes
    `);
    maintStmt.bind([aircraftId, airlineId]);
    const maintenance = [];
    while (maintStmt.step()) {
      const row = maintStmt.get();
      maintenance.push({
        id: row[0], day_of_week: row[1],
        start_minutes: row[2], duration_minutes: row[3],
        type: row[4], status: row[5]
      });
    }
    maintStmt.free();

    res.json({ aircraft, cabin_profile, routes, schedule, maintenance });
  } catch (error) {
    console.error('Get aircraft schedule error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Slot tracking helpers ────────────────────────────────────────────────────

function getCurrentWeekStart() {
  const now = new Date();
  const day = now.getUTCDay();
  const daysToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + daysToMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0];
}

// Returns { [airportCode]: departureCount } for expansion-relevant departures on this aircraft.
// Counting rules:
//   Rule 1: dep = home base OR arr = home base → never count
//   Rule 2: both have expansion → never count
//   Rule 3: only dep has expansion → count dep (this is what matters for capacity)
//   Rule 4: only arr has expansion → never count
//   Rule 5: neither has expansion → blocked at route creation, shouldn't occur
function getExpansionDepartures(db, airlineId, aircraftId) {
  const homeStmt = db.prepare('SELECT home_airport_code FROM airlines WHERE id = ?');
  homeStmt.bind([airlineId]);
  const homeCode = homeStmt.step() ? homeStmt.get()[0] : null;
  homeStmt.free();

  // Only count departures where:
  // - departure is not home base (Rule 1)
  // - arrival is not home base (Rule 1)
  // - arrival has no expansion (Rules 2 & 4: if dest has expansion, don't count origin)
  const schedStmt = db.prepare(`
    SELECT ws.departure_airport, COUNT(*) as cnt
    FROM weekly_schedule ws
    WHERE ws.aircraft_id = ?
      AND ws.departure_airport != ?
      AND ws.arrival_airport != ?
      AND NOT EXISTS (
        SELECT 1 FROM airport_expansions ae
        WHERE ae.airline_id = ?
          AND ae.airport_code = ws.arrival_airport
          AND ae.expansion_level > 0
      )
    GROUP BY ws.departure_airport
  `);
  schedStmt.bind([aircraftId, homeCode || '', homeCode || '', airlineId]);
  const result = {};
  while (schedStmt.step()) {
    const r = schedStmt.get();
    result[r[0]] = r[1];
  }
  schedStmt.free();
  return result;
}

// Toggle aircraft active state (activate / deactivate)
router.patch('/:id/active', authMiddleware, (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Get current active state
    const acStmt = db.prepare('SELECT id, is_active, airline_cabin_profile_id, crew_assigned FROM aircraft WHERE id = ? AND airline_id = ?');
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) {
      acStmt.free();
      return res.status(404).json({ error: 'Aircraft not found' });
    }
    const acRow = acStmt.get();
    const currentIsActive = acRow[1];
    const cabinProfileId = acRow[2];
    const crewAssigned = acRow[3];
    acStmt.free();

    const newIsActive = currentIsActive ? 0 : 1;

    if (newIsActive === 1) {
      // Check: cabin profile required
      if (!cabinProfileId) {
        return res.status(400).json({
          error: 'Cannot activate aircraft: no cabin profile assigned. Please assign a cabin profile first.'
        });
      }
      // Check: crew required
      if (!crewAssigned) {
        return res.status(400).json({
          error: 'Cannot activate aircraft: no crew assigned. Please hire crew first.'
        });
      }
      // Check: at least one flight in weekly schedule
      const schedCountStmt = db.prepare('SELECT COUNT(*) FROM weekly_schedule WHERE aircraft_id = ?');
      schedCountStmt.bind([aircraftId]);
      schedCountStmt.step();
      const schedCount = schedCountStmt.get()[0];
      schedCountStmt.free();
      if (schedCount === 0) {
        return res.status(400).json({
          error: 'Cannot activate aircraft: no flights in weekly schedule. Add at least one flight first.'
        });
      }

      // ── Expansion capacity check (real-time) ──────────────────────────────
      const expDeps = getExpansionDepartures(db, airlineId, aircraftId);
      const violations = [];

      for (const [airport, adding] of Object.entries(expDeps)) {
        const expStmt = db.prepare('SELECT expansion_level FROM airport_expansions WHERE airline_id = ? AND airport_code = ?');
        expStmt.bind([airlineId, airport]);
        const expLevel = expStmt.step() ? expStmt.get()[0] : 0;
        expStmt.free();
        const capacity = expLevel * 100;

        if (expLevel === 0) {
          violations.push({ airport, current: 0, capacity: 0, adding, no_expansion: true });
          continue;
        }

        // Real-time count from all OTHER active aircraft applying same counting rules:
        // only count departures to non-expansion, non-home-base destinations
        const homeCodeForCheck = (() => {
          const s = db.prepare('SELECT home_airport_code FROM airlines WHERE id = ?');
          s.bind([airlineId]); s.step(); const c = s.get()[0]; s.free(); return c || '';
        })();
        const currentStmt = db.prepare(`
          SELECT COUNT(*) FROM weekly_schedule ws
          JOIN aircraft ac ON ac.id = ws.aircraft_id
          WHERE ac.airline_id = ? AND ac.is_active = 1
            AND ws.departure_airport = ?
            AND ws.arrival_airport != ?
            AND ac.id != ?
            AND NOT EXISTS (
              SELECT 1 FROM airport_expansions ae
              WHERE ae.airline_id = ac.airline_id
                AND ae.airport_code = ws.arrival_airport
                AND ae.expansion_level > 0
            )
        `);
        currentStmt.bind([airlineId, airport, homeCodeForCheck, aircraftId]);
        currentStmt.step();
        const current = currentStmt.get()[0];
        currentStmt.free();

        if (current + adding > capacity) {
          violations.push({ airport, current, capacity, adding });
        }
      }

      if (violations.length > 0) {
        return res.status(400).json({
          error: 'slot_capacity_exceeded',
          message: 'Schedule exceeds expansion capacity at one or more airports.',
          violations,
        });
      }
    }

    const updateStmt = db.prepare('UPDATE aircraft SET is_active = ? WHERE id = ?');
    updateStmt.bind([newIsActive, aircraftId]);
    updateStmt.step();
    updateStmt.free();

    saveDatabase();

    res.json({
      message: `Aircraft ${newIsActive ? 'activated' : 'deactivated'}`,
      is_active: newIsActive
    });
  } catch (error) {
    console.error('Toggle aircraft active error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Clear schedule — deletes all weekly_schedule entries for an aircraft
router.delete('/:id/schedule', authMiddleware, (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acStmt = db.prepare('SELECT id, is_active FROM aircraft WHERE id = ? AND airline_id = ?');
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) { acStmt.free(); return res.status(404).json({ error: 'Aircraft not found' }); }
    const acRow2 = acStmt.get();
    const isActiveForClear = acRow2[1];
    acStmt.free();

    if (isActiveForClear) {
      return res.status(400).json({ error: 'Aircraft must be inactive to edit schedule. Deactivate the aircraft first.' });
    }

    const countStmt = db.prepare('SELECT COUNT(*) FROM weekly_schedule WHERE aircraft_id = ?');
    countStmt.bind([aircraftId]);
    countStmt.step();
    const count = countStmt.get()[0];
    countStmt.free();

    // Cancel upcoming scheduled/boarding flights and apply cancellation penalties
    const airlineBalStmt = db.prepare('SELECT id, balance FROM airlines WHERE id = ?');
    airlineBalStmt.bind([airlineId]);
    airlineBalStmt.step();
    const airlineBalRow = airlineBalStmt.get();
    let currentBalance = airlineBalRow[1];
    airlineBalStmt.free();

    const upcomingStmt = db.prepare(`
      SELECT id, flight_number,
             booked_economy, booked_business, booked_first,
             economy_price, business_price, first_price,
             booking_revenue_collected
      FROM flights
      WHERE aircraft_id = ? AND status IN ('scheduled', 'boarding')
    `);
    upcomingStmt.bind([aircraftId]);
    const upcomingFlights = [];
    while (upcomingStmt.step()) {
      const r = upcomingStmt.get();
      upcomingFlights.push({
        id: r[0], flight_number: r[1],
        booked_economy: r[2] || 0, booked_business: r[3] || 0, booked_first: r[4] || 0,
        economy_price: r[5] || 0, business_price: r[6] || 0, first_price: r[7] || 0,
        booking_revenue_collected: r[8] || 0
      });
    }
    upcomingStmt.free();

    if (upcomingFlights.length > 0) {
      // Cancel all upcoming flights
      const ids = upcomingFlights.map(() => '?').join(',');
      const cancelStmt = db.prepare(`UPDATE flights SET status = 'cancelled' WHERE id IN (${ids})`);
      cancelStmt.bind(upcomingFlights.map(f => f.id));
      cancelStmt.step();
      cancelStmt.free();

      // Calculate and apply penalty for flights with collected booking revenue
      let totalPenalty = 0;
      for (const f of upcomingFlights) {
        if (!f.booking_revenue_collected) continue;
        totalPenalty += f.booked_economy  * f.economy_price  * 1.2;
        totalPenalty += f.booked_business * (f.business_price || f.economy_price) * 1.2;
        totalPenalty += f.booked_first    * (f.first_price    || f.economy_price) * 1.2;
      }
      totalPenalty = Math.round(totalPenalty);

      if (totalPenalty > 0) {
        currentBalance -= totalPenalty;
        const updBalStmt = db.prepare('UPDATE airlines SET balance = ? WHERE id = ?');
        updBalStmt.bind([currentBalance, airlineId]);
        updBalStmt.step();
        updBalStmt.free();

        const txStmt = db.prepare(
          "INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'other', ?, ?)"
        );
        txStmt.bind([airlineId, -totalPenalty, `Flight Cancellation Penalty - Schedule Cleared (${upcomingFlights.length} flights)`]);
        txStmt.step();
        txStmt.free();
      }
    }

    const deleteStmt = db.prepare('DELETE FROM weekly_schedule WHERE aircraft_id = ?');
    deleteStmt.bind([aircraftId]);
    deleteStmt.step();
    deleteStmt.free();

    const deleteMaintStmt = db.prepare('DELETE FROM maintenance_schedule WHERE aircraft_id = ?');
    deleteMaintStmt.bind([aircraftId]);
    deleteMaintStmt.step();
    deleteMaintStmt.free();

    saveDatabase();
    res.json({
      message: `Cleared ${count} schedule entry(s)`,
      deleted_count: count,
      cancelled_flights: upcomingFlights.length
    });
  } catch (error) {
    console.error('Clear schedule error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Schedule flights for a specific aircraft (weekly template — day_of_week + HH:MM, no dates)
router.post('/:id/schedule', authMiddleware, (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Verify aircraft ownership and get type info for turnaround + range validation
    const acStmt = db.prepare(`
      SELECT a.id, t.wake_turbulence_category, t.range_km, t.full_name, a.is_active
      FROM aircraft a
      JOIN aircraft_types t ON a.aircraft_type_id = t.id
      WHERE a.id = ? AND a.airline_id = ?
    `);
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) { acStmt.free(); return res.status(404).json({ error: 'Aircraft not found' }); }
    const acRow = acStmt.get();
    const wakeCategory   = acRow[1];
    const aircraftRange  = acRow[2];
    const aircraftName   = acRow[3];
    const isActive    = acRow[4];
    acStmt.free();

    if (isActive) {
      return res.status(400).json({ error: 'Aircraft must be inactive to edit schedule. Deactivate the aircraft first.' });
    }

    const flightsToSchedule = req.body.flights || [req.body];
    if (!flightsToSchedule.length) return res.status(400).json({ error: 'No flights provided' });

    const TURNAROUND_BY_CATEGORY = { L: 25, M: 40, H: 60 };
    const GROUND_MIN = TURNAROUND_BY_CATEGORY[wakeCategory] || 40;
    const added = [];
    const newBatch = []; // track new entries in this batch for self-overlap

    for (const flightData of flightsToSchedule) {
      const { route_id, day_of_week, departure_time, economy_price, business_price, first_price, service_profile_id } = flightData;

      if (route_id === undefined || day_of_week === undefined || !departure_time || !economy_price) {
        return res.status(400).json({ error: 'Each flight requires route_id, day_of_week, departure_time (HH:MM), economy_price' });
      }

      const dow = parseInt(day_of_week);
      if (dow < 0 || dow > 6) return res.status(400).json({ error: 'day_of_week must be 0 (Mon) – 6 (Sun)' });

      // Verify route
      const routeStmt = db.prepare(`
        SELECT r.id, r.flight_number, r.distance_km, r.departure_airport, r.arrival_airport
        FROM routes r WHERE r.id = ? AND r.airline_id = ?
      `);
      routeStmt.bind([route_id, airlineId]);
      if (!routeStmt.step()) { routeStmt.free(); return res.status(400).json({ error: `Route ${route_id} not found` }); }
      const routeRow = routeStmt.get();
      const route = {
        id: routeRow[0], flight_number: routeRow[1], distance_km: routeRow[2],
        departure_airport: routeRow[3], arrival_airport: routeRow[4]
      };
      routeStmt.free();

      // Range validation
      if (aircraftRange && route.distance_km > aircraftRange) {
        return res.status(400).json({
          error: `Route exceeds aircraft range`,
          detail: {
            flight_number: route.flight_number,
            route_distance_km: route.distance_km,
            aircraft_name: aircraftName,
            aircraft_range_km: aircraftRange
          }
        });
      }

      // Parse departure time → minutes since midnight
      const [depH, depM] = departure_time.split(':').map(Number);
      const depMin = depH * 60 + depM;
      const durationMin = calculateFlightDuration(route.distance_km);
      const arrMin = depMin + durationMin;
      const arrH = Math.floor(arrMin % 1440 / 60);
      const arrMM = arrMin % 60;
      const arrTime = `${String(arrH).padStart(2, '0')}:${String(arrMM).padStart(2, '0')}`;

      // Check overlap with existing weekly_schedule on same day
      const existStmt = db.prepare(`
        SELECT departure_time, arrival_time FROM weekly_schedule
        WHERE aircraft_id = ? AND day_of_week = ?
      `);
      existStmt.bind([aircraftId, dow]);
      let overlap = false;
      while (existStmt.step()) {
        const row = existStmt.get();
        const [eDepH, eDepM] = row[0].split(':').map(Number);
        const [eArrH, eArrM] = row[1].split(':').map(Number);
        const eDepMin = eDepH * 60 + eDepM;
        const eArrMin = eArrH * 60 + eArrM;
        if (depMin < eArrMin + GROUND_MIN && eDepMin < arrMin + GROUND_MIN) { overlap = true; break; }
      }
      existStmt.free();
      if (overlap) return res.status(400).json({ error: `Flight at ${departure_time} on day ${dow} overlaps with an existing entry (incl. ${GROUND_MIN}min turnaround)` });

      // Check overlap with maintenance on same day
      const maintStmt = db.prepare(`
        SELECT start_minutes, duration_minutes FROM maintenance_schedule
        WHERE aircraft_id = ? AND airline_id = ? AND day_of_week = ?
      `);
      maintStmt.bind([aircraftId, airlineId, dow]);
      let maintOverlap = false;
      while (maintStmt.step()) {
        const row = maintStmt.get();
        const mStart = row[0], mEnd = row[0] + row[1];
        if (depMin < mEnd && mStart < arrMin) { maintOverlap = true; break; }
      }
      maintStmt.free();
      if (maintOverlap) return res.status(400).json({ error: `Flight at ${departure_time} overlaps with a maintenance window` });

      // Check overlap with batch entries already added in this request
      for (const nw of newBatch) {
        if (nw.dow !== dow) continue;
        if (depMin < nw.arrMin + GROUND_MIN && nw.depMin < arrMin + GROUND_MIN) {
          return res.status(400).json({ error: `Flight at ${departure_time} overlaps with another flight in this batch` });
        }
      }

      // Insert into weekly_schedule
      const insertStmt = db.prepare(`
        INSERT INTO weekly_schedule
          (aircraft_id, day_of_week, flight_number, departure_airport, arrival_airport,
           departure_time, arrival_time, economy_price, business_price, first_price, route_id, service_profile_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertStmt.bind([
        aircraftId, dow, route.flight_number, route.departure_airport, route.arrival_airport,
        departure_time, arrTime,
        parseFloat(economy_price), business_price ?? null, first_price ?? null, route.id,
        service_profile_id ?? null
      ]);
      insertStmt.step();
      insertStmt.free();

      const idStmt = db.prepare('SELECT last_insert_rowid()');
      idStmt.step();
      const entryId = idStmt.get()[0];
      idStmt.free();

      newBatch.push({ dow, depMin, arrMin });
      added.push({
        id: entryId, day_of_week: dow, flight_number: route.flight_number,
        departure_airport: route.departure_airport, arrival_airport: route.arrival_airport,
        departure_time, arrival_time: arrTime,
        economy_price: parseFloat(economy_price), business_price: business_price ?? null,
        first_price: first_price ?? null, route_id: route.id,
        service_profile_id: service_profile_id ?? null
      });
    }

    // Sync prices + service profile back to route + all weekly_schedule entries + future flights (per unique route)
    const seenRoutes = new Set();
    for (const f of added) {
      if (!seenRoutes.has(f.route_id)) {
        seenRoutes.add(f.route_id);
        syncRoutePrices(db, f.route_id, f.economy_price, f.business_price, f.first_price, f.service_profile_id);
      }
    }

    saveDatabase();

    res.status(201).json({
      message: `Successfully scheduled ${added.length} flight(s)`,
      flights: added
    });
  } catch (error) {
    console.error('Schedule aircraft flights error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Edit a weekly schedule entry (PATCH /:id/schedule/:entryId)
router.patch('/:id/schedule/:entryId', authMiddleware, (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const entryId = parseInt(req.params.entryId);
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Verify aircraft + entry ownership
    const acStmt = db.prepare('SELECT id, is_active FROM aircraft WHERE id = ? AND airline_id = ?');
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) { acStmt.free(); return res.status(404).json({ error: 'Aircraft not found' }); }
    const isOpForEdit = acStmt.get()[1];
    acStmt.free();

    if (isOpForEdit) {
      return res.status(400).json({ error: 'Aircraft must be inactive to edit schedule. Deactivate the aircraft first.' });
    }

    const entryStmt = db.prepare('SELECT id, route_id FROM weekly_schedule WHERE id = ? AND aircraft_id = ?');
    entryStmt.bind([entryId, aircraftId]);
    if (!entryStmt.step()) { entryStmt.free(); return res.status(404).json({ error: 'Schedule entry not found' }); }
    const existingRouteId = entryStmt.get()[1];
    entryStmt.free();

    const { day_of_week, departure_time, economy_price, business_price, first_price, service_profile_id } = req.body;
    const dow = day_of_week !== undefined ? parseInt(day_of_week) : null;

    // Recalculate arrival time if departure_time changed
    let arrTime = null;
    if (departure_time) {
      const routeId = existingRouteId;
      let distKm = 0;
      if (routeId) {
        const rStmt = db.prepare('SELECT distance_km FROM routes WHERE id = ?');
        rStmt.bind([routeId]);
        if (rStmt.step()) distKm = rStmt.get()[0];
        rStmt.free();
      }
      const durationMin = distKm ? calculateFlightDuration(distKm) : 0;
      const [depH, depM] = departure_time.split(':').map(Number);
      const depMin = depH * 60 + depM;
      const arrMin = depMin + durationMin;
      const arrH = Math.floor(arrMin % 1440 / 60);
      const arrMM = arrMin % 60;
      arrTime = `${String(arrH).padStart(2, '0')}:${String(arrMM).padStart(2, '0')}`;
    }

    const updates = [];
    const params = [];
    if (dow !== null) { updates.push('day_of_week = ?'); params.push(dow); }
    if (departure_time) { updates.push('departure_time = ?', 'arrival_time = ?'); params.push(departure_time, arrTime); }
    if (economy_price !== undefined) { updates.push('economy_price = ?'); params.push(parseFloat(economy_price)); }
    if (business_price !== undefined) { updates.push('business_price = ?'); params.push(business_price ?? null); }
    if (first_price !== undefined) { updates.push('first_price = ?'); params.push(first_price ?? null); }
    if (service_profile_id !== undefined) { updates.push('service_profile_id = ?'); params.push(service_profile_id ?? null); }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(entryId);
    const updateStmt = db.prepare(`UPDATE weekly_schedule SET ${updates.join(', ')} WHERE id = ?`);
    updateStmt.bind(params);
    updateStmt.step();
    updateStmt.free();

    // If prices or service profile changed, sync to route + all other schedule entries + future flights
    const priceChanged = economy_price !== undefined || business_price !== undefined || first_price !== undefined;
    const spChanged = service_profile_id !== undefined;
    if ((priceChanged || spChanged) && existingRouteId) {
      // Read current values for the entry (in case only some were updated)
      const curStmt = db.prepare('SELECT economy_price, business_price, first_price, service_profile_id FROM weekly_schedule WHERE id = ?');
      curStmt.bind([entryId]);
      let curEco = null, curBiz = null, curFir = null, curSp = null;
      if (curStmt.step()) { [curEco, curBiz, curFir, curSp] = curStmt.get(); }
      curStmt.free();
      syncRoutePrices(db, existingRouteId, curEco, curBiz, curFir, curSp);
    }

    saveDatabase();
    res.json({ message: 'Schedule entry updated' });
  } catch (error) {
    console.error('Edit schedule entry error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get upcoming generated flights for a specific aircraft (next 72h + last 24h completed)
router.get('/:id/flights', authMiddleware, (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acStmt = db.prepare('SELECT id FROM aircraft WHERE id = ? AND airline_id = ?');
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) { acStmt.free(); return res.status(404).json({ error: 'Aircraft not found' }); }
    acStmt.free();

    const now = new Date();
    const past24h   = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const future72h = new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString();

    const stmt = db.prepare(`
      SELECT f.id, f.flight_number, f.departure_time, f.arrival_time,
             f.status, f.total_seats, f.seats_sold,
             f.economy_price, f.business_price, f.first_price,
             f.booked_economy, f.booked_business, f.booked_first,
             f.revenue,
             COALESCE(r.departure_airport, ws.departure_airport) as dep_airport,
             COALESCE(r.arrival_airport,   ws.arrival_airport)   as arr_airport,
             COALESCE(r.distance_km, ws_r.distance_km) as distance_km,
             ap_dep.name as dep_airport_name,
             ap_arr.name as arr_airport_name,
             ap_dep.ground_handling_fee_light  as dep_gh_light,
             ap_dep.ground_handling_fee_medium as dep_gh_medium,
             ap_dep.ground_handling_fee_heavy  as dep_gh_heavy,
             ap_arr.ground_handling_fee_light  as arr_gh_light,
             ap_arr.ground_handling_fee_medium as arr_gh_medium,
             ap_arr.ground_handling_fee_heavy  as arr_gh_heavy,
             ap_arr.landing_fee_light, ap_arr.landing_fee_medium, ap_arr.landing_fee_heavy,
             COALESCE(f.fuel_cost, 0) as fuel_cost,
             COALESCE(f.atc_fee, 0) as atc_fee,
             COALESCE(f.catering_cost, 0) as catering_cost,
             COALESCE(f.landing_fee, 0) as landing_fee_paid,
             COALESCE(f.ground_handling_cost, 0) as ground_handling_paid,
             COALESCE(eco_cl.actual_capacity, 0) as eco_capacity,
             COALESCE(biz_cl.actual_capacity, 0) as biz_capacity,
             COALESCE(fir_cl.actual_capacity, 0) as fir_capacity,
             ac_ref.airline_cabin_profile_id,
             f.satisfaction_score,
             f.violated_rules
      FROM flights f
      LEFT JOIN routes r ON f.route_id = r.id
      LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
      LEFT JOIN routes ws_r ON ws_r.id = ws.route_id
      LEFT JOIN airports ap_dep ON ap_dep.iata_code = COALESCE(r.departure_airport, ws.departure_airport)
      LEFT JOIN airports ap_arr ON ap_arr.iata_code = COALESCE(r.arrival_airport, ws.arrival_airport)
      LEFT JOIN aircraft ac_ref ON ac_ref.id = f.aircraft_id
      LEFT JOIN airline_cabin_classes eco_cl ON eco_cl.profile_id = ac_ref.airline_cabin_profile_id AND eco_cl.class_type = 'economy'
      LEFT JOIN airline_cabin_classes biz_cl ON biz_cl.profile_id = ac_ref.airline_cabin_profile_id AND biz_cl.class_type = 'business'
      LEFT JOIN airline_cabin_classes fir_cl ON fir_cl.profile_id = ac_ref.airline_cabin_profile_id AND fir_cl.class_type = 'first'
      WHERE f.aircraft_id = ?
        AND f.status != 'cancelled'
        AND (
          (f.status IN ('scheduled','boarding','in-flight') AND datetime(f.departure_time) <= datetime(?))
          OR (f.status = 'completed' AND datetime(f.departure_time) >= datetime(?))
        )
      ORDER BY f.departure_time ASC
      LIMIT 60
    `);
    stmt.bind([aircraftId, future72h, past24h]);

    const flights = [];
    while (stmt.step()) {
      const r = stmt.get();
      flights.push({
        id: r[0], flight_number: r[1],
        departure_time: r[2], arrival_time: r[3],
        status: r[4], total_seats: r[5], seats_sold: r[6],
        economy_price: r[7], business_price: r[8], first_price: r[9],
        booked_economy: r[10], booked_business: r[11], booked_first: r[12],
        revenue: r[13],
        departure_airport: r[14], arrival_airport: r[15],
        distance_km: r[16],
        dep_airport_name: r[17], arr_airport_name: r[18],
        dep_gh_light: r[19], dep_gh_medium: r[20], dep_gh_heavy: r[21],
        arr_gh_light: r[22], arr_gh_medium: r[23], arr_gh_heavy: r[24],
        landing_fee_light: r[25], landing_fee_medium: r[26], landing_fee_heavy: r[27],
        fuel_cost: r[28],
        atc_fee: r[29],
        catering_cost: r[30],
        landing_fee_paid: r[31],
        ground_handling_paid: r[32],
        eco_capacity: r[33],
        biz_capacity: r[34],
        fir_capacity: r[35],
        satisfaction_score: r[37],
        violated_rules: r[38] ? JSON.parse(r[38]) : [],
      });
    }
    stmt.free();

    // Add maintenance entries as concrete datetime instances within the window
    const maintStmt = db.prepare(`
      SELECT id, day_of_week, start_minutes, duration_minutes, type
      FROM maintenance_schedule
      WHERE aircraft_id = ?
    `);
    maintStmt.bind([aircraftId]);
    const maintEntries = [];
    while (maintStmt.step()) {
      const r = maintStmt.get();
      maintEntries.push({ id: r[0], day_of_week: r[1], start_minutes: r[2], duration_minutes: r[3], type: r[4] });
    }
    maintStmt.free();

    // Compute next (and possibly current-week) occurrence for each maintenance entry
    // game uses 0=Mon..6=Sun; JS getDay() 0=Sun..6=Sat
    // start_minutes is stored as Europe/Berlin local time → convert to UTC for ISO
    const startOfToday = new Date(now); startOfToday.setUTCHours(0, 0, 0, 0);
    const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const windowEnd   = new Date(now.getTime() + 72 * 60 * 60 * 1000);

    // Returns Berlin UTC offset in minutes (e.g. 60 for UTC+1, 120 for UTC+2)
    function berlinOffsetMin(date) {
      const s = date.toLocaleString('sv', { timeZone: 'Europe/Berlin' }); // "2026-03-21 23:00:00"
      const asUtc = new Date(s.replace(' ', 'T') + 'Z');
      return Math.round((asUtc.getTime() - date.getTime()) / 60000);
    }

    for (const m of maintEntries) {
      // Try this week's occurrence and next week's
      for (const weekOffset of [0, 7]) {
        const jsTargetDay = m.day_of_week === 6 ? 0 : m.day_of_week + 1; // game→JS day
        const currentJsDay = startOfToday.getUTCDay();
        let daysUntil = (jsTargetDay - currentJsDay + 7) % 7 + weekOffset;

        const occurrenceDate = new Date(startOfToday);
        occurrenceDate.setUTCDate(occurrenceDate.getUTCDate() + daysUntil);
        // Interpret start_minutes as Berlin local time, convert to UTC
        const offsetMin = berlinOffsetMin(occurrenceDate);
        const utcStartMin = m.start_minutes - offsetMin;
        const startDt = new Date(occurrenceDate.getTime() + utcStartMin * 60000);
        const endDt = new Date(startDt.getTime() + m.duration_minutes * 60000);

        if (startDt < windowEnd && endDt > windowStart) {
          const status = now >= startDt && now < endDt ? 'in-progress' : now >= endDt ? 'completed' : 'scheduled';
          flights.push({
            id: `maint_${m.id}_${weekOffset}`,
            _type: 'maintenance',
            maintenance_type: m.type || 'routine',
            departure_time: startDt.toISOString(),
            arrival_time: endDt.toISOString(),
            status,
          });
          break; // only one occurrence per entry within window
        }
      }
    }

    // Add transfer flights within the window
    const trStmt = db.prepare(`
      SELECT id, departure_airport, arrival_airport, departure_time, arrival_time, status, cost
      FROM transfer_flights
      WHERE aircraft_id = ? AND airline_id = ?
        AND arrival_time >= ? AND departure_time <= ?
    `);
    trStmt.bind([aircraftId, airlineId, past24h, future72h]);
    while (trStmt.step()) {
      const r = trStmt.get();
      flights.push({
        id: `transfer_${r[0]}`,
        _type: 'transfer',
        _db_id: r[0],
        departure_airport: r[1],
        arrival_airport: r[2],
        departure_time: r[3],
        arrival_time: r[4],
        status: r[5],
        cost: r[6],
      });
    }
    trStmt.free();

    flights.sort((a, b) => new Date(a.departure_time) - new Date(b.departure_time));

    res.json({ flights });
  } catch (error) {
    console.error('Get aircraft flights error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /:id/transfer — schedule a one-time positioning/transfer flight
router.post('/:id/transfer', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  const aircraftId = parseInt(req.params.id);
  const { destination_airport, departure_time } = req.body;

  if (!destination_airport || !departure_time) {
    return res.status(400).json({ error: 'destination_airport and departure_time are required' });
  }

  try {
    const db = getDatabase();
    const airlineId = req.airlineId;

    // Verify aircraft ownership and get type data + current location
    const acStmt = db.prepare(`
      SELECT a.id, a.current_location, a.home_airport, al.balance,
             t.cruise_speed_kmh
      FROM aircraft a
      JOIN airlines al ON al.id = a.airline_id
      JOIN aircraft_types t ON t.id = a.aircraft_type_id
      WHERE a.id = ? AND a.airline_id = ?
    `);
    acStmt.bind([aircraftId, airlineId]);
    if (!acStmt.step()) { acStmt.free(); return res.status(404).json({ error: 'Aircraft not found' }); }
    const acRow = acStmt.get();
    acStmt.free();
    const [, currentLocation, homeAirport, balance, cruiseSpeed] = acRow;

    const departureAirport = currentLocation || homeAirport;
    if (!departureAirport) return res.status(400).json({ error: 'Aircraft has no known location' });
    if (departureAirport === destination_airport) {
      return res.status(400).json({ error: 'Aircraft is already at this airport' });
    }

    // Check balance
    const TRANSFER_COST = 500000;
    if (balance < TRANSFER_COST) {
      return res.status(400).json({ error: `Insufficient balance. Transfer costs $500,000 (balance: $${Math.round(balance).toLocaleString()})` });
    }

    // Get coordinates for both airports to calculate distance
    const apStmt = db.prepare('SELECT iata_code, latitude, longitude FROM airports WHERE iata_code IN (?, ?)');
    apStmt.bind([departureAirport, destination_airport]);
    const apCoords = {};
    while (apStmt.step()) {
      const r = apStmt.get();
      apCoords[r[0]] = { lat: r[1], lon: r[2] };
    }
    apStmt.free();

    if (!apCoords[departureAirport] || !apCoords[destination_airport]) {
      return res.status(400).json({ error: 'Airport coordinates not found' });
    }

    // Haversine distance
    function haversineKm(lat1, lon1, lat2, lon2) {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }
    const { lat: lat1, lon: lon1 } = apCoords[departureAirport];
    const { lat: lat2, lon: lon2 } = apCoords[destination_airport];
    const distanceKm = Math.round(haversineKm(lat1, lon1, lat2, lon2));
    const speed = cruiseSpeed || 850;
    const flightMinutes = Math.round((distanceKm / speed) * 60) + 30; // +30 min for taxi/approach

    const depDt = new Date(departure_time);
    if (isNaN(depDt.getTime())) return res.status(400).json({ error: 'Invalid departure_time' });
    if (depDt < new Date()) return res.status(400).json({ error: 'Departure time must be in the future' });

    const arrDt = new Date(depDt.getTime() + flightMinutes * 60000);
    const depISO = depDt.toISOString();
    const arrISO = arrDt.toISOString();

    // Conflict check: any scheduled/boarding/in-flight flights that overlap
    const conflictStmt = db.prepare(`
      SELECT COUNT(*) FROM flights
      WHERE aircraft_id = ?
        AND status IN ('scheduled', 'boarding', 'in-flight')
        AND departure_time < ? AND arrival_time > ?
    `);
    conflictStmt.bind([aircraftId, arrISO, depISO]);
    conflictStmt.step();
    const conflictCount = conflictStmt.get()[0];
    conflictStmt.free();
    if (conflictCount > 0) {
      return res.status(400).json({ error: `Transfer conflicts with ${conflictCount} scheduled flight(s). Clear or reschedule overlapping flights first.` });
    }

    // Conflict check: other pending transfer flights
    const trConflictStmt = db.prepare(`
      SELECT COUNT(*) FROM transfer_flights
      WHERE aircraft_id = ? AND status = 'scheduled'
        AND departure_time < ? AND arrival_time > ?
    `);
    trConflictStmt.bind([aircraftId, arrISO, depISO]);
    trConflictStmt.step();
    const trConflict = trConflictStmt.get()[0];
    trConflictStmt.free();
    if (trConflict > 0) {
      return res.status(400).json({ error: 'Transfer overlaps with another scheduled transfer flight.' });
    }

    // Deduct cost
    const deductStmt = db.prepare('UPDATE airlines SET balance = balance - ? WHERE id = ?');
    deductStmt.bind([TRANSFER_COST, airlineId]);
    deductStmt.step();
    deductStmt.free();

    // Insert transfer flight
    const insertStmt = db.prepare(`
      INSERT INTO transfer_flights (aircraft_id, airline_id, departure_airport, arrival_airport, departure_time, arrival_time, cost, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled')
    `);
    insertStmt.bind([aircraftId, airlineId, departureAirport, destination_airport, depISO, arrISO, TRANSFER_COST]);
    insertStmt.step();
    insertStmt.free();

    // Get new balance
    const balStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    balStmt.bind([airlineId]);
    balStmt.step();
    const newBalance = balStmt.get()[0];
    balStmt.free();

    res.json({
      message: `Transfer flight scheduled: ${departureAirport} → ${destination_airport} (${distanceKm} km, ${Math.floor(flightMinutes/60)}h ${flightMinutes%60}m)`,
      departure_airport: departureAirport,
      arrival_airport: destination_airport,
      departure_time: depISO,
      arrival_time: arrISO,
      distance_km: distanceKm,
      duration_minutes: flightMinutes,
      cost: TRANSFER_COST,
      new_balance: newBalance,
    });
  } catch (error) {
    console.error('Transfer flight error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id/scrap — decommission aircraft, receive 5% of new_price_usd
router.delete('/:id/scrap', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  const aircraftId = parseInt(req.params.id);
  try {
    const db = getDatabase();

    // Verify ownership + get type price
    const acStmt = db.prepare(`
      SELECT ac.id, at.new_price_usd, at.full_name, ac.registration, ac.is_active
      FROM aircraft ac
      JOIN aircraft_types at ON at.id = ac.aircraft_type_id
      WHERE ac.id = ? AND ac.airline_id = ?
    `);
    acStmt.bind([aircraftId, req.airlineId]);
    if (!acStmt.step()) { acStmt.free(); return res.status(404).json({ error: 'Aircraft not found' }); }
    const acRow = acStmt.get();
    acStmt.free();
    const [, newPrice, fullName, registration, isOpForScrap] = acRow;

    if (isOpForScrap) {
      return res.status(400).json({ error: 'Deactivate aircraft before scrapping. Aircraft must be inactive with no pending scheduled flights.' });
    }

    // Check for pending flights
    const pendingFlightStmt = db.prepare(`SELECT COUNT(*) FROM flights WHERE aircraft_id = ? AND status IN ('scheduled','boarding','in-flight')`);
    pendingFlightStmt.bind([aircraftId]);
    pendingFlightStmt.step();
    const pendingFlights = pendingFlightStmt.get()[0];
    pendingFlightStmt.free();
    if (pendingFlights > 0) {
      return res.status(400).json({ error: 'Cannot scrap aircraft: wait until all scheduled flights complete.' });
    }

    const scrapValue = Math.round((newPrice || 0) * 0.05);

    // Get current balance
    const balStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    balStmt.bind([req.airlineId]);
    balStmt.step();
    const currentBalance = balStmt.get()[0];
    balStmt.free();

    // Release crew to undeployed pool before deleting (prevents cascade delete)
    const relCrewStmt = db.prepare('UPDATE personnel SET aircraft_id = NULL WHERE aircraft_id = ?');
    relCrewStmt.bind([aircraftId]); relCrewStmt.step(); relCrewStmt.free();

    // Delete aircraft (cascades to weekly_schedule, flights via ON DELETE CASCADE)
    const delStmt = db.prepare('DELETE FROM aircraft WHERE id = ? AND airline_id = ?');
    delStmt.bind([aircraftId, req.airlineId]);
    delStmt.step(); delStmt.free();

    // Add scrap value to balance
    const newBalance = currentBalance + scrapValue;
    const updStmt = db.prepare('UPDATE airlines SET balance = ? WHERE id = ?');
    updStmt.bind([newBalance, req.airlineId]);
    updStmt.step(); updStmt.free();

    // Record transaction
    if (scrapValue > 0) {
      const txStmt = db.prepare('INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, ?, ?, ?)');
      txStmt.bind([req.airlineId, 'other', scrapValue, `Scrap value: ${registration} ${fullName}`]);
      txStmt.step(); txStmt.free();
    }

    saveDatabase();
    res.json({ message: 'Aircraft scrapped', scrap_value: scrapValue, new_balance: newBalance });
  } catch (err) {
    console.error('Scrap aircraft error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/aircraft/market/used — list used aircraft market
router.get('/market/used', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT u.id, u.registration, u.manufactured_year, u.total_flight_hours, u.current_value, u.listed_at,
             t.id as type_id, t.manufacturer, t.model, t.full_name, t.max_passengers, t.range_km,
             t.cruise_speed_kmh, t.wake_turbulence_category, t.image_filename,
             t.new_price_usd, t.min_runway_takeoff_m, t.min_runway_landing_m, u.location
      FROM used_aircraft_market u
      JOIN aircraft_types t ON u.aircraft_type_id = t.id
      ORDER BY u.current_value ASC
    `);
    const listings = [];
    while (stmt.step()) {
      const r = stmt.get();
      const currentYear = new Date().getFullYear();
      const ageYears = currentYear - r[2];
      listings.push({
        id: r[0], registration: r[1], manufactured_year: r[2],
        total_flight_hours: r[3], current_value: r[4], listed_at: r[5],
        age_years: ageYears,
        type_id: r[6], manufacturer: r[7], model: r[8], full_name: r[9],
        max_passengers: r[10], range_km: r[11], cruise_speed_kmh: r[12],
        wake_turbulence_category: r[13], image_filename: r[14],
        new_price_usd: r[15], min_runway_takeoff_m: r[16], min_runway_landing_m: r[17],
        location: r[18]
      });
    }
    stmt.free();
    res.json({ listings });
  } catch(e) {
    console.error('Used market list error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/aircraft/market/used/:id/buy — buy from used market
router.post('/market/used/:id/buy', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  const listingId = parseInt(req.params.id);
  const { deliveryAirport, cabin_profile_id } = req.body;
  try {
    const db = getDatabase();
    // Get listing
    const lStmt = db.prepare('SELECT u.*, t.new_price_usd, t.depreciation_age, t.depreciation_fh FROM used_aircraft_market u JOIN aircraft_types t ON u.aircraft_type_id = t.id WHERE u.id = ?');
    lStmt.bind([listingId]);
    if (!lStmt.step()) { lStmt.free(); return res.status(404).json({ error: 'Listing not found' }); }
    const l = lStmt.get(); lStmt.free();
    // cols: id(0) type_id(1) registration(2) manufactured_year(3) total_fh(4) current_value(5)
    //       listed_at(6) location(7) seller_aircraft_id(8) seller_airline_id(9)
    const [id, typeId, , manufacturedYear, totalFh, currentValue, , , sellerAircraftId, sellerAirlineId] = l;
    // Check balance
    const balStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    balStmt.bind([req.airlineId]); balStmt.step();
    const balance = balStmt.get()[0]; balStmt.free();
    if (balance < currentValue) return res.status(400).json({ error: 'Insufficient funds' });
    // Get buyer's home airport to determine registration prefix
    const airlineStmt = db.prepare('SELECT home_airport_code FROM airlines WHERE id = ?');
    airlineStmt.bind([req.airlineId]); airlineStmt.step();
    const buyerHomeAirport = airlineStmt.get()[0]; airlineStmt.free();
    // Registration always based on buyer's home base, never delivery airport
    const registration = genRegForLocation(db, buyerHomeAirport);
    // Create aircraft with correct age (purchased_at = manufacture date)
    const purchasedAt = `${manufacturedYear}-07-01 00:00:00`;
    const airport = deliveryAirport || null;
    const insStmt = db.prepare(`
      INSERT INTO aircraft (airline_id, aircraft_type_id, registration, home_airport, is_active,
        purchased_at, current_location, total_flight_hours, airline_cabin_profile_id)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
    `);
    insStmt.bind([req.airlineId, typeId, registration, airport, purchasedAt, airport, totalFh, cabin_profile_id || null]);
    insStmt.step(); insStmt.free();
    // Remove listing
    const delStmt = db.prepare('DELETE FROM used_aircraft_market WHERE id = ?');
    delStmt.bind([listingId]); delStmt.step(); delStmt.free();
    // If sold by a player airline: delete seller's aircraft and credit their balance
    if (sellerAircraftId && sellerAirlineId) {
      // Release seller's crew to undeployed pool before deleting aircraft
      const relCrewStmt = db.prepare('UPDATE personnel SET aircraft_id = NULL WHERE aircraft_id = ?');
      relCrewStmt.bind([sellerAircraftId]); relCrewStmt.step(); relCrewStmt.free();
      const delAcStmt = db.prepare('DELETE FROM aircraft WHERE id = ?');
      delAcStmt.bind([sellerAircraftId]); delAcStmt.step(); delAcStmt.free();
      const selBalStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
      selBalStmt.bind([sellerAirlineId]); selBalStmt.step();
      const sellerBalance = selBalStmt.get()[0]; selBalStmt.free();
      const updSelStmt = db.prepare('UPDATE airlines SET balance = ? WHERE id = ?');
      updSelStmt.bind([sellerBalance + currentValue, sellerAirlineId]); updSelStmt.step(); updSelStmt.free();
      const selTxStmt = db.prepare("INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'other', ?, ?)");
      selTxStmt.bind([sellerAirlineId, currentValue, `Aircraft sold on used market: ${registration}`]);
      selTxStmt.step(); selTxStmt.free();
    }
    // Deduct buyer's balance
    const newBalance = balance - currentValue;
    const updStmt = db.prepare('UPDATE airlines SET balance = ? WHERE id = ?');
    updStmt.bind([newBalance, req.airlineId]); updStmt.step(); updStmt.free();
    // Transaction
    const txStmt = db.prepare("INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'aircraft_purchase', ?, ?)");
    txStmt.bind([req.airlineId, -currentValue, `Used aircraft purchase: ${registration}`]);
    txStmt.step(); txStmt.free();
    saveDatabase();
    res.json({ message: `${registration} added to fleet`, new_balance: newBalance });
  } catch(e) {
    console.error('Buy used aircraft error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/aircraft/:id/sell-to-market — list aircraft on used market (stays in fleet until bought)
router.post('/:id/sell-to-market', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  const aircraftId = parseInt(req.params.id);
  try {
    const db = getDatabase();
    const acStmt = db.prepare(`
      SELECT ac.registration, ac.purchased_at, ac.total_flight_hours,
             t.new_price_usd, t.depreciation_age, t.depreciation_fh, t.id as type_id, t.full_name,
             ac.current_location, ac.is_active, ac.is_listed_for_sale
      FROM aircraft ac JOIN aircraft_types t ON t.id = ac.aircraft_type_id
      WHERE ac.id = ? AND ac.airline_id = ?
    `);
    acStmt.bind([aircraftId, req.airlineId]);
    if (!acStmt.step()) { acStmt.free(); return res.status(404).json({ error: 'Aircraft not found' }); }
    const r = acStmt.get(); acStmt.free();
    const [registration, purchasedAt, totalFh, newPrice, kAge, kFh, typeId, fullName, currentLocation, isActive, alreadyListed] = r;

    if (isActive) return res.status(400).json({ error: 'Deactivate aircraft before listing for sale.' });
    if (alreadyListed) return res.status(400).json({ error: 'Aircraft is already listed for sale.' });

    const pendingStmt = db.prepare(`SELECT COUNT(*) FROM flights WHERE aircraft_id = ? AND status IN ('scheduled','boarding','in-flight')`);
    pendingStmt.bind([aircraftId]); pendingStmt.step();
    const pendingCount = pendingStmt.get()[0]; pendingStmt.free();
    if (pendingCount > 0) return res.status(400).json({ error: 'Cannot list aircraft: wait until all scheduled flights complete.' });

    // Compute value
    const deliveryMs = purchasedAt ? new Date(purchasedAt).getTime() : Date.now();
    const ageYears = Math.max(0, (Date.now() - deliveryMs) / (365.25 * 24 * 3600 * 1000));
    const marketValue = Math.round(calcUsedValue(newPrice, kAge, kFh, ageYears, totalFh || 0));
    const manufacturedYear = Math.round(new Date().getFullYear() - ageYears);
    const finalReg = genRegForLocation(db, currentLocation);

    // Insert listing with seller reference
    const insStmt = db.prepare('INSERT INTO used_aircraft_market (aircraft_type_id, registration, manufactured_year, total_flight_hours, current_value, location, seller_aircraft_id, seller_airline_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insStmt.bind([typeId, finalReg, manufacturedYear, totalFh || 0, marketValue, currentLocation || null, aircraftId, req.airlineId]);
    insStmt.step(); insStmt.free();

    // Mark as listed (keep in fleet)
    const markStmt = db.prepare('UPDATE aircraft SET is_listed_for_sale = 1 WHERE id = ?');
    markStmt.bind([aircraftId]); markStmt.step(); markStmt.free();

    saveDatabase();
    res.json({ message: `${registration} listed on used market`, market_value: marketValue, is_listed_for_sale: 1 });
  } catch(e) {
    console.error('Sell to market error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/aircraft/:id/cancel-listing — remove from used market, keep in fleet
router.delete('/:id/cancel-listing', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  const aircraftId = parseInt(req.params.id);
  try {
    const db = getDatabase();
    const chkStmt = db.prepare('SELECT id, is_listed_for_sale FROM aircraft WHERE id = ? AND airline_id = ?');
    chkStmt.bind([aircraftId, req.airlineId]);
    if (!chkStmt.step()) { chkStmt.free(); return res.status(404).json({ error: 'Aircraft not found' }); }
    const chkRow = chkStmt.get(); chkStmt.free();
    if (!chkRow[1]) return res.status(400).json({ error: 'Aircraft is not listed for sale.' });

    const delStmt = db.prepare('DELETE FROM used_aircraft_market WHERE seller_aircraft_id = ?');
    delStmt.bind([aircraftId]); delStmt.step(); delStmt.free();

    const unmarkStmt = db.prepare('UPDATE aircraft SET is_listed_for_sale = 0 WHERE id = ?');
    unmarkStmt.bind([aircraftId]); unmarkStmt.step(); unmarkStmt.free();

    saveDatabase();
    res.json({ message: 'Listing cancelled', is_listed_for_sale: 0 });
  } catch(e) {
    console.error('Cancel listing error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DEV: POST /api/aircraft/dev/clear-market — delete all used aircraft market listings
router.post('/dev/clear-market', authMiddleware, (_req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare('DELETE FROM used_aircraft_market');
    stmt.step(); stmt.free();
    saveDatabase();
    res.json({ message: 'Market cleared' });
  } catch(e) {
    console.error('Clear market error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DEV: POST /api/aircraft/dev/fill-market — manually fill used aircraft market
router.post('/dev/fill-market', authMiddleware, (_req, res) => {
  try {
    const db = getDatabase();
    const added = fillUsedMarket(db);
    saveDatabase();
    res.json({ message: added > 0 ? `${added} neue Listings hinzugefügt` : 'Nichts hinzugefügt — alle Typen haben bereits Listings' });
  } catch(e) {
    console.error('Fill market error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/aircraft/types?level=X — aircraft types for a specific required_level
router.get('/types', authMiddleware, (req, res) => {
  try {
    const db    = getDatabase();
    const level = parseInt(req.query.level) || 1;
    const stmt  = db.prepare(`
      SELECT id, full_name, max_passengers, range_km, image_filename, required_level
      FROM aircraft_types WHERE required_level = ? ORDER BY max_passengers ASC
    `);
    stmt.bind([level]);
    const types = [];
    while (stmt.step()) {
      const r = stmt.get();
      types.push({ id: r[0], full_name: r[1], max_passengers: r[2], range_km: r[3], image_filename: r[4], required_level: r[5] });
    }
    stmt.free();
    res.json({ types });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
