import express from 'express';
import { body, validationResult } from 'express-validator';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';
import { calculateFlightDuration } from './flights.js';

const router = express.Router();

// ── Route sync helper ─────────────────────────────────────────────────────────
async function syncRoutePrices(routeId, ecoPrice, bizPrice, firPrice, serviceProfileId) {
  await pool.query(
    'UPDATE routes SET economy_price = $1, business_price = $2, first_price = $3, service_profile_id = $4 WHERE id = $5',
    [ecoPrice, bizPrice ?? null, firPrice ?? null, serviceProfileId ?? null, routeId]
  );
  await pool.query(
    'UPDATE weekly_schedule SET economy_price = $1, business_price = $2, first_price = $3, service_profile_id = $4 WHERE route_id = $5',
    [ecoPrice, bizPrice ?? null, firPrice ?? null, serviceProfileId ?? null, routeId]
  );
  await pool.query(`
    UPDATE flights SET economy_price = $1, business_price = $2, first_price = $3
    WHERE status IN ('scheduled', 'boarding')
      AND (route_id = $4 OR weekly_schedule_id IN (SELECT id FROM weekly_schedule WHERE route_id = $5))
  `, [ecoPrice, bizPrice ?? null, firPrice ?? null, routeId, routeId]);
}

// ── Used Aircraft Market helpers ──────────────────────────────────────────────

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

async function genRegForPrefix(prefix) {
  const fmt = AIRPORT_PREFIX_FORMAT[prefix];
  if (!fmt) {
    for (let i = 0; i < 30; i++) {
      const reg = prefix + '-' + randUMLetters(3);
      const r1 = await pool.query('SELECT id FROM aircraft WHERE registration = $1', [reg]);
      const r2 = await pool.query('SELECT id FROM used_aircraft_market WHERE registration = $1', [reg]);
      if (!r1.rows[0] && !r2.rows[0]) return reg;
    }
    return prefix + '-' + randUMLetters(3) + randUMDigits(2);
  }
  for (let i = 0; i < 30; i++) {
    const reg = fmt();
    const r1 = await pool.query('SELECT id FROM aircraft WHERE registration = $1', [reg]);
    const r2 = await pool.query('SELECT id FROM used_aircraft_market WHERE registration = $1', [reg]);
    if (!r1.rows[0] && !r2.rows[0]) return reg;
  }
  return prefix + '-' + randUMLetters(3) + randUMDigits(2);
}

async function genRegForLocation(iataCode) {
  if (!iataCode) return genRegForPrefix('D');
  const result = await pool.query('SELECT registration_prefix FROM airports WHERE iata_code = $1', [iataCode]);
  const prefix = result.rows[0]?.registration_prefix ?? null;
  if (!prefix) return genRegForPrefix('D');
  return genRegForPrefix(prefix);
}

function calcUsedValue(newPrice, kAge, kFh, ageYears, totalFh) {
  const val = newPrice * Math.exp(-(kAge || 0.035) * ageYears) * Math.exp(-(kFh || 0.000006) * totalFh);
  return Math.max(val, newPrice * 0.30);
}
const MARKET_TARGET_PER_TYPE = 8;

export async function fillUsedMarket() {
  try {
    const tResult = await pool.query('SELECT id, new_price_usd, depreciation_age, depreciation_fh FROM aircraft_types');
    const types = tResult.rows.map(r => ({ id: r.id, newPrice: r.new_price_usd, kAge: r.depreciation_age, kFh: r.depreciation_fh }));
    if (!types.length) return 0;

    const aResult = await pool.query('SELECT iata_code, registration_prefix FROM airports');
    const airports = aResult.rows.map(r => ({ code: r.iata_code, prefix: r.registration_prefix }));

    const countResult = await pool.query('SELECT aircraft_type_id, COUNT(*) as cnt FROM used_aircraft_market GROUP BY aircraft_type_id');
    const countMap = {};
    for (const r of countResult.rows) countMap[String(r.aircraft_type_id)] = parseInt(r.cnt);

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
        const reg = airport ? await genRegForPrefix(airport.prefix) : await genRegForPrefix('D');
        const val = Math.round(calcUsedValue(t.newPrice, t.kAge, t.kFh, ageYears, totalFh));
        await pool.query(
          'INSERT INTO used_aircraft_market (aircraft_type_id, registration, manufactured_year, total_flight_hours, current_value, location) VALUES ($1, $2, $3, $4, $5, $6)',
          [t.id, reg, manufacturedYear, totalFh, val, location]
        );
        total++;
      }
    }
    console.log(`[UsedMarket] Added ${total} listings (target: ${MARKET_TARGET_PER_TYPE} per type)`);
    return total;
  } catch(e) { console.error('fillUsedMarket error:', e); return 0; }
}

let lastMarketRefreshDate = null;
export function startMarketRefreshScheduler() {
  setInterval(async () => {
    try {
      const cetDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
      const cetHour = parseInt(new Intl.DateTimeFormat('en', { timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false }).format(new Date()));
      if (cetHour >= 3 && cetDate !== lastMarketRefreshDate) {
        lastMarketRefreshDate = cetDate;
        await fillUsedMarket();
        console.log('[UsedMarket] Daily refresh completed');
      }
    } catch(e) { console.error('Market refresh error:', e); }
  }, 10 * 60 * 1000);
}

// Helper function to get grouped fleet
async function getGroupedFleetHandler(req, res) {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const result = await pool.query(`
      SELECT t.id as type_id, t.manufacturer, t.model, t.full_name, t.max_passengers, t.range_km,
             COUNT(a.id) as count, t.image_filename
      FROM aircraft a
      JOIN aircraft_types t ON a.aircraft_type_id = t.id
      WHERE a.airline_id = $1
      GROUP BY t.id, t.manufacturer, t.model, t.full_name, t.max_passengers, t.range_km, t.image_filename
      ORDER BY t.manufacturer, t.model
    `, [airlineId]);

    let totalCount = 0;
    const fleetGrouped = result.rows.map(row => {
      const count = parseInt(row.count);
      totalCount += count;
      return {
        type_id: row.type_id,
        manufacturer: row.manufacturer,
        model: row.model,
        full_name: row.full_name,
        max_passengers: row.max_passengers,
        range_km: row.range_km,
        count,
        image_filename: row.image_filename
      };
    });

    res.json({ fleet: fleetGrouped, total_count: totalCount });
  } catch (error) {
    console.error('Get grouped fleet error:', error);
    res.status(500).json({ error: 'Server error' });
  }
}

// Helper function to get aircraft market
async function getMarketHandler(req, res) {
  try {
    const { manufacturer, wake_category } = req.query;

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const lvlResult = await pool.query('SELECT level FROM airlines WHERE id = $1', [airlineId]);
    if (!lvlResult.rows[0]) return res.status(400).json({ error: 'No airline found' });
    const airlineLevel = lvlResult.rows[0].level;

    let query = `SELECT id, manufacturer, model, full_name, max_passengers, range_km,
      cruise_speed_kmh, min_runway_takeoff_m, min_runway_landing_m,
      fuel_consumption_per_km,
      wake_turbulence_category, required_pilots,
      new_price_usd, required_level, image_filename FROM aircraft_types`;
    const params = [];
    const conditions = [];
    let paramIdx = 1;

    if (manufacturer && manufacturer !== 'All') {
      conditions.push(`manufacturer = $${paramIdx++}`);
      params.push(manufacturer);
    }
    if (wake_category && wake_category !== 'All') {
      conditions.push(`wake_turbulence_category = $${paramIdx++}`);
      params.push(wake_category);
    }
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY new_price_usd ASC';

    const result = await pool.query(query, params);
    const aircraftTypes = result.rows.map(row => ({
      id: row.id,
      manufacturer: row.manufacturer,
      model: row.model,
      full_name: row.full_name,
      max_passengers: row.max_passengers,
      range_km: row.range_km,
      cruise_speed_kmh: row.cruise_speed_kmh,
      min_runway_takeoff_m: row.min_runway_takeoff_m,
      min_runway_landing_m: row.min_runway_landing_m,
      fuel_consumption_per_km: row.fuel_consumption_per_km,
      wake_turbulence_category: row.wake_turbulence_category,
      required_pilots: row.required_pilots,
      new_price_usd: row.new_price_usd,
      required_level: row.required_level,
      image_filename: row.image_filename,
      can_purchase: airlineLevel >= row.required_level
    }));

    const mfgResult = await pool.query('SELECT DISTINCT manufacturer FROM aircraft_types ORDER BY manufacturer');
    const manufacturers = mfgResult.rows.map(r => r.manufacturer);

    const wakeResult = await pool.query('SELECT DISTINCT wake_turbulence_category FROM aircraft_types ORDER BY wake_turbulence_category');
    const wakeCategories = wakeResult.rows.map(r => r.wake_turbulence_category);

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
router.get('/', authMiddleware, async (req, res) => {
  if (req.baseUrl === '/api/fleet') {
    return getGroupedFleetHandler(req, res);
  }
  if (req.baseUrl === '/api/aircraft-market') {
    return getMarketHandler(req, res);
  }
  res.status(404).json({ error: 'Not found' });
});

// Get all aircraft types available for purchase
router.get('/types', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const lvlResult = await pool.query('SELECT level FROM airlines WHERE id = $1', [airlineId]);
    if (!lvlResult.rows[0]) return res.status(400).json({ error: 'No airline found' });
    const airlineLevel = lvlResult.rows[0].level;

    const result = await pool.query('SELECT id, manufacturer, model, full_name, max_passengers, range_km, cruise_speed_kmh, new_price_usd, required_level, image_filename FROM aircraft_types ORDER BY required_level, new_price_usd');

    const aircraftTypes = result.rows.map(row => ({
      id: row.id,
      manufacturer: row.manufacturer,
      model: row.model,
      full_name: row.full_name,
      max_passengers: row.max_passengers,
      range_km: row.range_km,
      cruise_speed_kmh: row.cruise_speed_kmh,
      new_price_usd: row.new_price_usd,
      required_level: row.required_level,
      image_filename: row.image_filename,
      can_purchase: airlineLevel >= row.required_level
    }));

    res.json({ aircraft_types: aircraftTypes, airline_level: airlineLevel });
  } catch (error) {
    console.error('Get aircraft types error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get aircraft market (types for purchase) with optional manufacturer filter
router.get('/market', authMiddleware, async (req, res) => {
  return getMarketHandler(req, res);
});

// Get user's fleet (individual aircraft)
router.get('/fleet', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const result = await pool.query(`
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
      WHERE a.airline_id = $1
      ORDER BY a.purchased_at DESC
    `, [airlineId]);

    const fleet = result.rows.map(row => ({
      id: row.id,
      registration: row.registration,
      name: row.name,
      purchased_at: row.purchased_at,
      home_airport: row.home_airport,
      condition: row.condition,
      is_active: row.is_active ?? 0,
      manufacturer: row.manufacturer,
      model: row.model,
      full_name: row.full_name,
      max_passengers: row.max_passengers,
      range_km: row.range_km,
      type_id: row.type_id,
      image_filename: row.image_filename,
      airline_cabin_profile_id: row.airline_cabin_profile_id ?? null,
      airline_cabin_profile_name: row.airline_cabin_profile_name ?? null,
      current_location: row.current_location ?? null,
      new_price_usd: row.new_price_usd,
      depreciation_age: row.depreciation_age,
      depreciation_fh: row.depreciation_fh,
      total_flight_hours: row.total_flight_hours ?? 0,
      is_listed_for_sale: row.is_listed_for_sale ?? 0,
      listed_price: row.listed_price ?? null,
    }));

    res.json({ fleet });
  } catch (error) {
    console.error('Get fleet error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's fleet grouped by type with counts
router.get('/fleet/grouped', authMiddleware, async (req, res) => {
  return getGroupedFleetHandler(req, res);
});

// Get fleet overview: individual aircraft with current status and active flight info
router.get('/fleet/overview', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acResult = await pool.query(`
      SELECT
        a.id, a.registration, a.name, a.home_airport, a.condition, a.is_active,
        t.full_name AS aircraft_type,
        ap.name AS home_airport_name
      FROM aircraft a
      JOIN aircraft_types t ON a.aircraft_type_id = t.id
      LEFT JOIN airports ap ON a.home_airport = ap.iata_code
      WHERE a.airline_id = $1
      ORDER BY a.home_airport, a.registration
    `, [airlineId]);

    const aircraft = acResult.rows.map(row => ({
      id: row.id,
      registration: row.registration,
      name: row.name,
      home_airport: row.home_airport,
      condition: row.condition,
      is_active: row.is_active ?? 0,
      aircraft_type: row.aircraft_type,
      home_airport_name: row.home_airport_name,
      active_fn: null,
      active_dep: null,
      active_arr: null,
      active_flight_status: null
    }));

    const flightResult = await pool.query(`
      SELECT aircraft_id, flight_number, departure_airport, arrival_airport, status
      FROM flights
      WHERE airline_id = $1 AND status IN ('boarding', 'in-flight')
    `, [airlineId]);

    const activeFlights = {};
    for (const row of flightResult.rows) {
      activeFlights[row.aircraft_id] = {
        active_fn: row.flight_number,
        active_dep: row.departure_airport,
        active_arr: row.arrival_airport,
        active_flight_status: row.status
      };
    }

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
async function generateRegistration(prefix) {
  return genRegForPrefix(prefix);
}

// Purchase aircraft (supports quantity and delivery airport)
router.post('/purchase',
  authMiddleware,
  body('typeId').optional().isInt({ min: 1 }).withMessage('Invalid aircraft type'),
  body('aircraft_type_id').optional().isInt({ min: 1 }).withMessage('Invalid aircraft type'),
  body('quantity').optional().isInt({ min: 1, max: 10 }).withMessage('Quantity must be between 1 and 10'),
  body('deliveryAirport').optional().isLength({ min: 3, max: 3 }).withMessage('Invalid airport code'),
  body('name').optional().isLength({ max: 50 }).trim(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const aircraft_type_id = req.body.typeId || req.body.aircraft_type_id;
      const quantity = req.body.quantity || 1;
      const deliveryAirport = req.body.deliveryAirport;
      const { name } = req.body;

      if (!aircraft_type_id) {
        return res.status(400).json({ error: 'Aircraft type ID is required' });
      }

      if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });

      const airlineResult = await pool.query(`
        SELECT a.id, a.balance, a.level, a.home_airport_code
        FROM airlines a
        WHERE a.id = $1 AND a.user_id = $2
      `, [req.airlineId, req.userId]);

      if (!airlineResult.rows[0]) {
        return res.status(400).json({ error: 'No airline found' });
      }
      const airline = airlineResult.rows[0];
      const homeAirport = airline.home_airport_code;

      const airportResult = await pool.query('SELECT registration_prefix FROM airports WHERE iata_code = $1', [homeAirport]);
      if (!airportResult.rows[0]) {
        return res.status(400).json({ error: 'Invalid delivery airport' });
      }
      const registrationPrefix = airportResult.rows[0].registration_prefix;

      const typeResult = await pool.query('SELECT id, manufacturer, model, full_name, max_passengers, range_km, new_price_usd, required_level, image_filename FROM aircraft_types WHERE id = $1', [aircraft_type_id]);
      if (!typeResult.rows[0]) {
        return res.status(400).json({ error: 'Aircraft type not found' });
      }
      const aircraftType = typeResult.rows[0];

      if (airline.level < aircraftType.required_level) {
        return res.status(400).json({
          error: `Requires level ${aircraftType.required_level}. Your airline is level ${airline.level}.`
        });
      }

      const totalCost = aircraftType.new_price_usd * quantity;

      if (airline.balance < totalCost) {
        return res.status(400).json({
          error: `Insufficient funds. Need $${totalCost.toLocaleString()}, have $${airline.balance.toLocaleString()}`
        });
      }

      const purchasedAircraft = [];
      for (let i = 0; i < quantity; i++) {
        const registration = await generateRegistration(registrationPrefix);

        const insertResult = await pool.query(
          'INSERT INTO aircraft (airline_id, aircraft_type_id, registration, name, home_airport, current_location, condition, is_active) VALUES ($1, $2, $3, $4, $5, $6, 100, 0) RETURNING id',
          [airline.id, aircraft_type_id, registration, name || null, homeAirport, deliveryAirport || homeAirport]
        );
        const aircraftId = insertResult.rows[0].id;

        if (req.body.cabin_profile_id) {
          try {
            await pool.query('UPDATE aircraft SET airline_cabin_profile_id = $1 WHERE id = $2', [req.body.cabin_profile_id, aircraftId]);
          } catch (e) { /* ignore if column doesn't exist yet */ }
        }

        purchasedAircraft.push({
          id: aircraftId,
          registration,
          name: name || null,
          home_airport: homeAirport
        });
      }

      const newBalance = airline.balance - totalCost;
      await pool.query('UPDATE airlines SET balance = $1 WHERE id = $2', [newBalance, airline.id]);
      await pool.query(
        'INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, $2, $3, $4)',
        [airline.id, 'aircraft_purchase', -totalCost, `Purchased ${quantity}x ${aircraftType.full_name}`]
      );

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
router.get('/:id/detail', authMiddleware, async (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acResult = await pool.query(`
      SELECT a.id, a.registration, a.name, a.home_airport, a.condition,
             a.aircraft_type_id, a.is_active,
             t.manufacturer, t.model, t.full_name, t.max_passengers, t.range_km,
             t.image_filename, t.id as type_id, a.airline_cabin_profile_id,
             a.current_location, a.crew_assigned,
             t.new_price_usd, t.depreciation_age, t.depreciation_fh,
             a.total_flight_hours, a.purchased_at, t.wake_turbulence_category
      FROM aircraft a
      JOIN aircraft_types t ON a.aircraft_type_id = t.id
      WHERE a.id = $1 AND a.airline_id = $2
    `, [aircraftId, airlineId]);

    if (!acResult.rows[0]) {
      return res.status(404).json({ error: 'Aircraft not found' });
    }
    const row = acResult.rows[0];
    const aircraft = {
      id: row.id, registration: row.registration, name: row.name,
      home_airport: row.home_airport, condition: row.condition,
      aircraft_type_id: row.aircraft_type_id, is_active: row.is_active ?? 0,
      manufacturer: row.manufacturer, model: row.model, full_name: row.full_name,
      max_passengers: row.max_passengers, range_km: row.range_km,
      image_filename: row.image_filename, type_id: row.type_id,
      airline_cabin_profile_id: row.airline_cabin_profile_id ?? null,
      current_location: row.current_location ?? null,
      crew_assigned: row.crew_assigned ?? 0,
      new_price_usd: row.new_price_usd ?? 0,
      depreciation_age: row.depreciation_age ?? 0.055,
      depreciation_fh: row.depreciation_fh ?? 0.000010,
      total_flight_hours: row.total_flight_hours ?? 0,
      purchased_at: row.purchased_at ?? null,
      wake_turbulence_category: row.wake_turbulence_category ?? 'M'
    };

    let home_airport_name = null;
    if (aircraft.home_airport) {
      const haResult = await pool.query('SELECT name FROM airports WHERE iata_code = $1', [aircraft.home_airport]);
      if (haResult.rows[0]) home_airport_name = haResult.rows[0].name;
    }

    let current_flight = null;
    const cfResult = await pool.query(`
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
      WHERE f.aircraft_id = $1 AND f.status = 'in-flight'
      ORDER BY f.departure_time DESC LIMIT 1
    `, [aircraftId]);
    if (cfResult.rows[0]) {
      const cf = cfResult.rows[0];
      current_flight = {
        flight_number: cf.flight_number, departure_time: cf.departure_time, arrival_time: cf.arrival_time,
        departure_airport: cf.dep_code, departure_name: cf.name,
        arrival_airport: cf.arr_code, arrival_name: cf.name
      };
    }

    let current_location = null;
    if (!current_flight) {
      const locCode = aircraft.current_location || aircraft.home_airport;
      if (locCode) {
        const locResult = await pool.query('SELECT name FROM airports WHERE iata_code = $1', [locCode]);
        const locName = locResult.rows[0]?.name ?? locCode;
        current_location = { code: locCode, name: locName };
      }
    }

    let total_flights = 0, total_profit = 0, total_passengers = 0;
    const statsResult = await pool.query(`
      SELECT COUNT(*) as cnt,
             COALESCE(SUM(
               revenue
               - COALESCE(fuel_cost, 0)
               - COALESCE(atc_fee, 0)
               - COALESCE(landing_fee, 0)
               - COALESCE(ground_handling_cost, 0)
               - COALESCE(catering_cost, 0)
             ), 0) as profit,
             COALESCE(SUM(seats_sold), 0) as pax
      FROM flights WHERE aircraft_id = $1 AND status = 'completed'
    `, [aircraftId]);
    if (statsResult.rows[0]) {
      total_flights = parseInt(statsResult.rows[0].cnt);
      total_profit = statsResult.rows[0].profit;
      total_passengers = parseInt(statsResult.rows[0].pax);
    }

    const wsResult = await pool.query(`
      SELECT id, day_of_week, flight_number, departure_airport, arrival_airport, departure_time, arrival_time
      FROM weekly_schedule WHERE aircraft_id = $1 ORDER BY day_of_week, departure_time
    `, [aircraftId]);
    const weekly_schedule = wsResult.rows.map(wsRow => ({
      id: wsRow.id, day_of_week: wsRow.day_of_week, flight_number: wsRow.flight_number,
      departure_airport: wsRow.departure_airport, arrival_airport: wsRow.arrival_airport,
      departure_time: wsRow.departure_time, arrival_time: wsRow.arrival_time
    }));

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

// Assign user-defined cabin profile to aircraft
router.patch('/:id/airline-cabin-profile', authMiddleware, async (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const { profile_id } = req.body;
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const airlineBalResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [airlineId]);
    if (!airlineBalResult.rows[0]) return res.status(400).json({ error: 'No airline found' });
    const currentBalance = airlineBalResult.rows[0].balance;

    const acResult = await pool.query('SELECT id, aircraft_type_id, registration FROM aircraft WHERE id = $1 AND airline_id = $2', [aircraftId, airlineId]);
    if (!acResult.rows[0]) {
      return res.status(404).json({ error: 'Aircraft not found' });
    }
    const { aircraft_type_id: typeId, registration } = acResult.rows[0];

    if (profile_id) {
      const cpResult = await pool.query(
        'SELECT id FROM airline_cabin_profiles WHERE id = $1 AND airline_id = $2 AND aircraft_type_id = $3',
        [profile_id, airlineId, typeId]
      );
      if (!cpResult.rows[0]) {
        return res.status(400).json({ error: 'Cabin profile not valid for this aircraft type' });
      }
    }

    const now = new Date();
    const threeDaysLater = new Date(now.getTime() + 3 * 24 * 3600 * 1000);
    const flightResult = await pool.query(`
      SELECT id, booked_economy, booked_business, booked_first,
             economy_price, business_price, first_price, booking_revenue_collected
      FROM flights
      WHERE aircraft_id = $1 AND status IN ('scheduled', 'boarding')
        AND departure_time >= $2 AND departure_time <= $3
    `, [aircraftId, now.toISOString(), threeDaysLater.toISOString()]);

    const flightsToCancel = flightResult.rows.map(r => ({
      id: r.id,
      booked_economy: r.booked_economy || 0, booked_business: r.booked_business || 0, booked_first: r.booked_first || 0,
      economy_price: r.economy_price || 0, business_price: r.business_price || 0, first_price: r.first_price || 0,
      booking_revenue_collected: r.booking_revenue_collected || 0
    }));

    let penalty = 0;
    for (const f of flightsToCancel) {
      if (!f.booking_revenue_collected) continue;
      penalty += f.booked_economy  * f.economy_price  * 1.2;
      penalty += f.booked_business * (f.business_price || f.economy_price) * 1.2;
      penalty += f.booked_first    * (f.first_price    || f.economy_price) * 1.2;
    }
    penalty = Math.round(penalty);

    if (flightsToCancel.length > 0) {
      const ids = flightsToCancel.map((_, i) => `$${i + 1}`).join(',');
      await pool.query(`UPDATE flights SET status = 'cancelled' WHERE id IN (${ids})`, flightsToCancel.map(f => f.id));
    }

    await pool.query('DELETE FROM weekly_schedule WHERE aircraft_id = $1', [aircraftId]);

    if (penalty > 0) {
      const newBalance = currentBalance - penalty;
      await pool.query('UPDATE airlines SET balance = $1 WHERE id = $2', [newBalance, airlineId]);
      await pool.query(
        "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'other', $2, $3)",
        [airlineId, -penalty, `Flight Cancellation Penalty - Cabin Profile Change (${registration})`]
      );
    }

    await pool.query('UPDATE aircraft SET airline_cabin_profile_id = $1, is_active = 0 WHERE id = $2', [profile_id || null, aircraftId]);

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
router.patch('/:id/cabin-profile-fleet', authMiddleware, async (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const { profile_id } = req.body;
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acResult = await pool.query('SELECT id, aircraft_type_id, is_active FROM aircraft WHERE id = $1 AND airline_id = $2', [aircraftId, airlineId]);
    if (!acResult.rows[0]) return res.status(404).json({ error: 'Aircraft not found' });
    const { aircraft_type_id: typeId, is_active: isActive } = acResult.rows[0];

    if (isActive) {
      return res.status(400).json({ error: 'Deactivate the aircraft before changing its cabin profile' });
    }

    if (profile_id) {
      const cpResult = await pool.query('SELECT id FROM airline_cabin_profiles WHERE id = $1 AND airline_id = $2 AND aircraft_type_id = $3', [profile_id, airlineId, typeId]);
      if (!cpResult.rows[0]) return res.status(400).json({ error: 'Cabin profile not valid for this aircraft type' });
    }

    await pool.query('UPDATE aircraft SET airline_cabin_profile_id = $1 WHERE id = $2', [profile_id || null, aircraftId]);

    res.json({ message: 'Cabin profile updated' });
  } catch (error) {
    console.error('Fleet cabin profile update error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update aircraft name
router.patch('/:id/name', authMiddleware, async (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const { name } = req.body;
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acResult = await pool.query('SELECT id FROM aircraft WHERE id = $1 AND airline_id = $2', [aircraftId, airlineId]);
    if (!acResult.rows[0]) {
      return res.status(404).json({ error: 'Aircraft not found' });
    }

    await pool.query('UPDATE aircraft SET name = $1 WHERE id = $2', [name || null, aircraftId]);

    res.json({ message: 'Aircraft name updated' });
  } catch (error) {
    console.error('Update aircraft name error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/:id/home-airport', authMiddleware, async (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const { home_airport } = req.body;
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acResult = await pool.query('SELECT id FROM aircraft WHERE id = $1 AND airline_id = $2', [aircraftId, airlineId]);
    if (!acResult.rows[0]) return res.status(404).json({ error: 'Aircraft not found' });

    await pool.query('UPDATE aircraft SET home_airport = $1 WHERE id = $2', [home_airport || null, aircraftId]);

    res.json({ message: 'Home airport updated' });
  } catch (error) {
    console.error('Update home airport error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get upcoming flights (next 4 days from weekly schedule)
router.get('/:id/upcoming-flights', authMiddleware, async (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acResult = await pool.query('SELECT id FROM aircraft WHERE id = $1 AND airline_id = $2', [aircraftId, airlineId]);
    if (!acResult.rows[0]) {
      return res.status(404).json({ error: 'Aircraft not found' });
    }

    const wsResult = await pool.query(`
      SELECT id, day_of_week, flight_number, departure_airport, arrival_airport, departure_time, arrival_time
      FROM weekly_schedule WHERE aircraft_id = $1 ORDER BY day_of_week, departure_time
    `, [aircraftId]);
    const scheduleEntries = wsResult.rows.map(row => ({
      id: row.id, day_of_week: row.day_of_week, flight_number: row.flight_number,
      departure_airport: row.departure_airport, arrival_airport: row.arrival_airport,
      departure_time: row.departure_time, arrival_time: row.arrival_time
    }));

    const now = new Date();
    const upcomingFlights = [];

    for (let dayOffset = 0; dayOffset < 4; dayOffset++) {
      const date = new Date(now);
      date.setDate(date.getDate() + dayOffset);
      const jsDay = date.getDay();
      const dayOfWeek = jsDay === 0 ? 6 : jsDay - 1;

      const dayEntries = scheduleEntries.filter(e => e.day_of_week === dayOfWeek);
      const dateStr = date.toISOString().split('T')[0];

      for (const entry of dayEntries) {
        const checkResult = await pool.query(`
          SELECT id, booked_economy, booked_business, booked_first, status
          FROM flights
          WHERE aircraft_id = $1 AND airline_id = $2 AND flight_number = $3
            AND departure_time::date = $4::date
        `, [aircraftId, airlineId, entry.flight_number, dateStr]);

        let flightId = null, booked_economy = 0, booked_business = 0, booked_first = 0, status = 'scheduled';
        if (checkResult.rows[0]) {
          const fRow = checkResult.rows[0];
          flightId = fRow.id;
          booked_economy = fRow.booked_economy || 0;
          booked_business = fRow.booked_business || 0;
          booked_first = fRow.booked_first || 0;
          status = fRow.status;
        }

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
          booked_first
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
router.post('/:id/weekly-schedule', authMiddleware, async (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const { day_of_week, flight_number, departure_airport, arrival_airport, departure_time, arrival_time } = req.body;

    if (day_of_week === undefined || !flight_number || !departure_airport || !arrival_airport || !departure_time || !arrival_time) {
      return res.status(400).json({ error: 'All fields required: day_of_week, flight_number, departure_airport, arrival_airport, departure_time, arrival_time' });
    }

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acResult = await pool.query('SELECT id FROM aircraft WHERE id = $1 AND airline_id = $2', [aircraftId, airlineId]);
    if (!acResult.rows[0]) {
      return res.status(404).json({ error: 'Aircraft not found' });
    }

    const insertResult = await pool.query(`
      INSERT INTO weekly_schedule (aircraft_id, day_of_week, flight_number, departure_airport, arrival_airport, departure_time, arrival_time)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [aircraftId, day_of_week, flight_number, departure_airport, arrival_airport, departure_time, arrival_time]);
    const newId = insertResult.rows[0].id;

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
router.delete('/:id/weekly-schedule/:entryId', authMiddleware, async (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const entryId = parseInt(req.params.entryId);
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acResult = await pool.query('SELECT id, is_active FROM aircraft WHERE id = $1 AND airline_id = $2', [aircraftId, airlineId]);
    if (!acResult.rows[0]) {
      return res.status(404).json({ error: 'Aircraft not found' });
    }
    const isOpForEntry = acResult.rows[0].is_active;

    if (isOpForEntry) {
      return res.status(400).json({ error: 'Aircraft must be inactive to edit schedule. Deactivate the aircraft first.' });
    }

    await pool.query('DELETE FROM weekly_schedule WHERE id = $1 AND aircraft_id = $2', [entryId, aircraftId]);

    res.json({ message: 'Weekly schedule entry deleted' });
  } catch (error) {
    console.error('Delete weekly schedule error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get aircraft schedule (weekly template — no dates)
router.get('/:id/schedule', authMiddleware, async (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acResult = await pool.query(`
      SELECT a.id, a.registration, a.name, a.home_airport, a.condition,
             t.manufacturer, t.model, t.full_name, t.max_passengers, t.range_km, t.id as type_id,
             a.is_active, t.image_filename,
             a.airline_cabin_profile_id, t.wake_turbulence_category
      FROM aircraft a
      JOIN aircraft_types t ON a.aircraft_type_id = t.id
      WHERE a.id = $1 AND a.airline_id = $2
    `, [aircraftId, airlineId]);

    if (!acResult.rows[0]) return res.status(404).json({ error: 'Aircraft not found' });
    const acRow = acResult.rows[0];
    const aircraft = {
      id: acRow.id, registration: acRow.registration, name: acRow.name,
      home_airport: acRow.home_airport, condition: acRow.condition,
      manufacturer: acRow.manufacturer, model: acRow.model, full_name: acRow.full_name,
      max_passengers: acRow.max_passengers, range_km: acRow.range_km, type_id: acRow.type_id,
      is_active: acRow.is_active ?? 0, image_filename: acRow.image_filename,
      airline_cabin_profile_id: acRow.airline_cabin_profile_id ?? null,
      wake_turbulence_category: acRow.wake_turbulence_category ?? 'M'
    };
    const routesResult = await pool.query(`
      SELECT r.id, r.flight_number, r.departure_airport, r.arrival_airport, r.distance_km,
             r.economy_price, r.business_price, r.first_price, r.service_profile_id
      FROM routes r WHERE r.airline_id = $1 ORDER BY r.flight_number
    `, [airlineId]);
    const routes = routesResult.rows.map(row => ({
      id: row.id, flight_number: row.flight_number,
      departure_airport: row.departure_airport, arrival_airport: row.arrival_airport,
      distance_km: row.distance_km,
      economy_price: row.economy_price, business_price: row.business_price, first_price: row.first_price,
      service_profile_id: row.service_profile_id,
      estimated_duration: calculateFlightDuration(row.distance_km)
    }));

    const schedResult = await pool.query(`
      SELECT ws.id, ws.day_of_week, ws.flight_number,
             ws.departure_airport, ws.arrival_airport,
             ws.departure_time, ws.arrival_time,
             ws.economy_price, ws.business_price, ws.first_price, ws.route_id,
             ws.service_profile_id
      FROM weekly_schedule ws
      WHERE ws.aircraft_id = $1
      ORDER BY ws.day_of_week, ws.departure_time
    `, [aircraftId]);
    const schedule = schedResult.rows.map(row => ({
      id: row.id, day_of_week: row.day_of_week, flight_number: row.flight_number,
      departure_airport: row.departure_airport, arrival_airport: row.arrival_airport,
      departure_time: row.departure_time, arrival_time: row.arrival_time,
      economy_price: row.economy_price, business_price: row.business_price, first_price: row.first_price,
      route_id: row.route_id, service_profile_id: row.service_profile_id
    }));

    const maintResult = await pool.query(`
      SELECT id, day_of_week, start_minutes, duration_minutes, type, status
      FROM maintenance_schedule
      WHERE aircraft_id = $1 AND airline_id = $2 AND day_of_week IS NOT NULL
      ORDER BY day_of_week, start_minutes
    `, [aircraftId, airlineId]);
    const maintenance = maintResult.rows.map(row => ({
      id: row.id, day_of_week: row.day_of_week,
      start_minutes: row.start_minutes, duration_minutes: row.duration_minutes,
      type: row.type, status: row.status
    }));

    res.json({ aircraft, routes, schedule, maintenance });
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

async function getExpansionDepartures(airlineId, aircraftId) {
  const homeResult = await pool.query('SELECT home_airport_code FROM airlines WHERE id = $1', [airlineId]);
  const homeCode = homeResult.rows[0]?.home_airport_code ?? null;

  const schedResult = await pool.query(`
    SELECT ws.departure_airport, COUNT(*) as cnt
    FROM weekly_schedule ws
    WHERE ws.aircraft_id = $1
      AND ws.departure_airport != $2
      AND ws.arrival_airport != $3
      AND NOT EXISTS (
        SELECT 1 FROM airport_expansions ae
        WHERE ae.airline_id = $4
          AND ae.airport_code = ws.arrival_airport
          AND ae.expansion_level > 0
      )
    GROUP BY ws.departure_airport
  `, [aircraftId, homeCode || '', homeCode || '', airlineId]);

  const result = {};
  for (const r of schedResult.rows) {
    result[r.departure_airport] = parseInt(r.cnt);
  }
  return result;
}

// Toggle aircraft active state (activate / deactivate)
router.patch('/:id/active', authMiddleware, async (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acResult = await pool.query('SELECT id, is_active, airline_cabin_profile_id, crew_assigned FROM aircraft WHERE id = $1 AND airline_id = $2', [aircraftId, airlineId]);
    if (!acResult.rows[0]) {
      return res.status(404).json({ error: 'Aircraft not found' });
    }
    const { is_active: currentIsActive, airline_cabin_profile_id: cabinProfileId, crew_assigned: crewAssigned } = acResult.rows[0];

    const newIsActive = currentIsActive ? 0 : 1;

    if (newIsActive === 1) {
      if (!cabinProfileId) {
        return res.status(400).json({
          error: 'Cannot activate aircraft: no cabin profile assigned. Please assign a cabin profile first.'
        });
      }
      if (!crewAssigned) {
        return res.status(400).json({
          error: 'Cannot activate aircraft: no crew assigned. Please hire crew first.'
        });
      }
      const schedCountResult = await pool.query('SELECT COUNT(*) as cnt FROM weekly_schedule WHERE aircraft_id = $1', [aircraftId]);
      const schedCount = parseInt(schedCountResult.rows[0].cnt);
      if (schedCount === 0) {
        return res.status(400).json({
          error: 'Cannot activate aircraft: no flights in weekly schedule. Add at least one flight first.'
        });
      }

      // ── Expansion capacity check ──────────────────────────────────────────
      const expDeps = await getExpansionDepartures(airlineId, aircraftId);
      const violations = [];

      for (const [airport, adding] of Object.entries(expDeps)) {
        const expResult = await pool.query('SELECT expansion_level FROM airport_expansions WHERE airline_id = $1 AND airport_code = $2', [airlineId, airport]);
        const expLevel = expResult.rows[0]?.expansion_level ?? 0;
        const capacity = expLevel * 100;

        if (expLevel === 0) {
          violations.push({ airport, current: 0, capacity: 0, adding, no_expansion: true });
          continue;
        }

        const homeResult = await pool.query('SELECT home_airport_code FROM airlines WHERE id = $1', [airlineId]);
        const homeCodeForCheck = homeResult.rows[0]?.home_airport_code ?? '';

        const currentResult = await pool.query(`
          SELECT COUNT(*) as cnt FROM weekly_schedule ws
          JOIN aircraft ac ON ac.id = ws.aircraft_id
          WHERE ac.airline_id = $1 AND ac.is_active = 1
            AND ws.departure_airport = $2
            AND ws.arrival_airport != $3
            AND ac.id != $4
            AND NOT EXISTS (
              SELECT 1 FROM airport_expansions ae
              WHERE ae.airline_id = ac.airline_id
                AND ae.airport_code = ws.arrival_airport
                AND ae.expansion_level > 0
            )
        `, [airlineId, airport, homeCodeForCheck, aircraftId]);
        const current = parseInt(currentResult.rows[0].cnt);

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

    await pool.query('UPDATE aircraft SET is_active = $1 WHERE id = $2', [newIsActive, aircraftId]);

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
router.delete('/:id/schedule', authMiddleware, async (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acResult = await pool.query('SELECT id, is_active FROM aircraft WHERE id = $1 AND airline_id = $2', [aircraftId, airlineId]);
    if (!acResult.rows[0]) return res.status(404).json({ error: 'Aircraft not found' });
    const isActiveForClear = acResult.rows[0].is_active;

    if (isActiveForClear) {
      return res.status(400).json({ error: 'Aircraft must be inactive to edit schedule. Deactivate the aircraft first.' });
    }

    const countResult = await pool.query('SELECT COUNT(*) as cnt FROM weekly_schedule WHERE aircraft_id = $1', [aircraftId]);
    const count = parseInt(countResult.rows[0].cnt);

    // Detach existing flight instances from the template (FK constraint), but let them run normally
    await pool.query('UPDATE flights SET weekly_schedule_id = NULL WHERE aircraft_id = $1', [aircraftId]);
    await pool.query('DELETE FROM weekly_schedule WHERE aircraft_id = $1', [aircraftId]);
    await pool.query('DELETE FROM maintenance_schedule WHERE aircraft_id = $1', [aircraftId]);

    res.json({
      message: `Cleared ${count} schedule entry(s)`,
      deleted_count: count
    });
  } catch (error) {
    console.error('Clear schedule error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Schedule flights for a specific aircraft (weekly template — day_of_week + HH:MM, no dates)
router.post('/:id/schedule', authMiddleware, async (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acResult = await pool.query(`
      SELECT a.id, t.wake_turbulence_category, t.range_km, t.full_name, a.is_active
      FROM aircraft a
      JOIN aircraft_types t ON a.aircraft_type_id = t.id
      WHERE a.id = $1 AND a.airline_id = $2
    `, [aircraftId, airlineId]);
    if (!acResult.rows[0]) return res.status(404).json({ error: 'Aircraft not found' });
    const { wake_turbulence_category: wakeCategory, range_km: aircraftRange, full_name: aircraftName, is_active: isActive } = acResult.rows[0];

    if (isActive) {
      return res.status(400).json({ error: 'Aircraft must be inactive to edit schedule. Deactivate the aircraft first.' });
    }

    const flightsToSchedule = req.body.flights || [req.body];
    if (!flightsToSchedule.length) return res.status(400).json({ error: 'No flights provided' });

    const TURNAROUND_BY_CATEGORY = { L: 25, M: 40, H: 60 };
    const GROUND_MIN = TURNAROUND_BY_CATEGORY[wakeCategory] || 40;
    const added = [];
    const newBatch = [];

    for (const flightData of flightsToSchedule) {
      const { route_id, day_of_week, departure_time, economy_price, business_price, first_price, service_profile_id } = flightData;

      if (route_id === undefined || day_of_week === undefined || !departure_time || !economy_price) {
        return res.status(400).json({ error: 'Each flight requires route_id, day_of_week, departure_time (HH:MM), economy_price' });
      }

      const dow = parseInt(day_of_week);
      if (dow < 0 || dow > 6) return res.status(400).json({ error: 'day_of_week must be 0 (Mon) – 6 (Sun)' });

      const routeResult = await pool.query(`
        SELECT r.id, r.flight_number, r.distance_km, r.departure_airport, r.arrival_airport
        FROM routes r WHERE r.id = $1 AND r.airline_id = $2
      `, [route_id, airlineId]);
      if (!routeResult.rows[0]) return res.status(400).json({ error: `Route ${route_id} not found` });
      const route = routeResult.rows[0];

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

      const [depH, depM] = departure_time.split(':').map(Number);
      const depMin = depH * 60 + depM;
      const durationMin = calculateFlightDuration(route.distance_km);
      const arrMin = depMin + durationMin;
      const arrH = Math.floor(arrMin % 1440 / 60);
      const arrMM = arrMin % 60;
      const arrTime = `${String(arrH).padStart(2, '0')}:${String(arrMM).padStart(2, '0')}`;

      const existResult = await pool.query(`
        SELECT departure_time, arrival_time FROM weekly_schedule
        WHERE aircraft_id = $1 AND day_of_week = $2
      `, [aircraftId, dow]);

      let overlap = false;
      for (const row of existResult.rows) {
        const [eDepH, eDepM] = row.departure_time.split(':').map(Number);
        const [eArrH, eArrM] = row.arrival_time.split(':').map(Number);
        const eDepMin = eDepH * 60 + eDepM;
        const eArrMin = eArrH * 60 + eArrM;
        if (depMin < eArrMin + GROUND_MIN && eDepMin < arrMin + GROUND_MIN) { overlap = true; break; }
      }
      if (overlap) return res.status(400).json({ error: `Flight at ${departure_time} on day ${dow} overlaps with an existing entry (incl. ${GROUND_MIN}min turnaround)` });

      const maintResult = await pool.query(`
        SELECT start_minutes, duration_minutes FROM maintenance_schedule
        WHERE aircraft_id = $1 AND airline_id = $2 AND day_of_week = $3
      `, [aircraftId, airlineId, dow]);

      let maintOverlap = false;
      for (const row of maintResult.rows) {
        const mStart = row.start_minutes, mEnd = row.start_minutes + row.duration_minutes;
        if (depMin < mEnd && mStart < arrMin) { maintOverlap = true; break; }
      }
      if (maintOverlap) return res.status(400).json({ error: `Flight at ${departure_time} overlaps with a maintenance window` });

      for (const nw of newBatch) {
        if (nw.dow !== dow) continue;
        if (depMin < nw.arrMin + GROUND_MIN && nw.depMin < arrMin + GROUND_MIN) {
          return res.status(400).json({ error: `Flight at ${departure_time} overlaps with another flight in this batch` });
        }
      }

      const insertResult = await pool.query(`
        INSERT INTO weekly_schedule
          (aircraft_id, day_of_week, flight_number, departure_airport, arrival_airport,
           departure_time, arrival_time, economy_price, business_price, first_price, route_id, service_profile_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id
      `, [
        aircraftId, dow, route.flight_number, route.departure_airport, route.arrival_airport,
        departure_time, arrTime,
        parseFloat(economy_price), business_price ?? null, first_price ?? null, route.id,
        service_profile_id ?? null
      ]);
      const entryId = insertResult.rows[0].id;

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

    const seenRoutes = new Set();
    for (const f of added) {
      if (!seenRoutes.has(f.route_id)) {
        seenRoutes.add(f.route_id);
        await syncRoutePrices(f.route_id, f.economy_price, f.business_price, f.first_price, f.service_profile_id);
      }
    }

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
router.patch('/:id/schedule/:entryId', authMiddleware, async (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const entryId = parseInt(req.params.entryId);
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acResult = await pool.query('SELECT id, is_active FROM aircraft WHERE id = $1 AND airline_id = $2', [aircraftId, airlineId]);
    if (!acResult.rows[0]) return res.status(404).json({ error: 'Aircraft not found' });
    const isOpForEdit = acResult.rows[0].is_active;

    if (isOpForEdit) {
      return res.status(400).json({ error: 'Aircraft must be inactive to edit schedule. Deactivate the aircraft first.' });
    }

    const entryResult = await pool.query('SELECT id, route_id FROM weekly_schedule WHERE id = $1 AND aircraft_id = $2', [entryId, aircraftId]);
    if (!entryResult.rows[0]) return res.status(404).json({ error: 'Schedule entry not found' });
    const existingRouteId = entryResult.rows[0].route_id;

    const { day_of_week, departure_time, economy_price, business_price, first_price, service_profile_id } = req.body;
    const dow = day_of_week !== undefined ? parseInt(day_of_week) : null;

    let arrTime = null;
    if (departure_time) {
      const routeId = existingRouteId;
      let distKm = 0;
      if (routeId) {
        const rResult = await pool.query('SELECT distance_km FROM routes WHERE id = $1', [routeId]);
        if (rResult.rows[0]) distKm = rResult.rows[0].distance_km;
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
    let paramIdx = 1;
    if (dow !== null) { updates.push(`day_of_week = $${paramIdx++}`); params.push(dow); }
    if (departure_time) { updates.push(`departure_time = $${paramIdx++}`, `arrival_time = $${paramIdx++}`); params.push(departure_time, arrTime); }
    if (economy_price !== undefined) { updates.push(`economy_price = $${paramIdx++}`); params.push(parseFloat(economy_price)); }
    if (business_price !== undefined) { updates.push(`business_price = $${paramIdx++}`); params.push(business_price ?? null); }
    if (first_price !== undefined) { updates.push(`first_price = $${paramIdx++}`); params.push(first_price ?? null); }
    if (service_profile_id !== undefined) { updates.push(`service_profile_id = $${paramIdx++}`); params.push(service_profile_id ?? null); }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(entryId);
    await pool.query(`UPDATE weekly_schedule SET ${updates.join(', ')} WHERE id = $${paramIdx}`, params);

    const priceChanged = economy_price !== undefined || business_price !== undefined || first_price !== undefined;
    const spChanged = service_profile_id !== undefined;
    if ((priceChanged || spChanged) && existingRouteId) {
      const curResult = await pool.query('SELECT economy_price, business_price, first_price, service_profile_id FROM weekly_schedule WHERE id = $1', [entryId]);
      if (curResult.rows[0]) {
        const cur = curResult.rows[0];
        await syncRoutePrices(existingRouteId, cur.economy_price, cur.business_price, cur.first_price, cur.service_profile_id);
      }
    }

    res.json({ message: 'Schedule entry updated' });
  } catch (error) {
    console.error('Edit schedule entry error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get upcoming generated flights for a specific aircraft (next 72h + last 24h completed)
router.get('/:id/flights', authMiddleware, async (req, res) => {
  try {
    const aircraftId = parseInt(req.params.id);
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acResult = await pool.query('SELECT id FROM aircraft WHERE id = $1 AND airline_id = $2', [aircraftId, airlineId]);
    if (!acResult.rows[0]) return res.status(404).json({ error: 'Aircraft not found' });

    const now = new Date();
    // Start of yesterday (00:00 local = UTC midnight-ish; use 48h back to always include full previous day)
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const pastWindow  = yesterday.toISOString();
    const past24h     = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const future72h   = new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString();

    const result = await pool.query(`
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
      WHERE f.aircraft_id = $1
        AND (
          (f.status IN ('scheduled','boarding','in-flight') AND f.departure_time <= $2)
          OR (f.status = 'completed' AND f.departure_time >= $3)
          OR (f.status = 'cancelled' AND f.departure_time >= $4)
        )
      ORDER BY f.departure_time ASC
      LIMIT 60
    `, [aircraftId, future72h, past24h, pastWindow]);

    const flights = result.rows.map(r => ({
      id: r.id, flight_number: r.flight_number,
      departure_time: r.departure_time, arrival_time: r.arrival_time,
      status: r.status, total_seats: r.total_seats, seats_sold: r.seats_sold,
      economy_price: r.economy_price, business_price: r.business_price, first_price: r.first_price,
      booked_economy: r.booked_economy, booked_business: r.booked_business, booked_first: r.booked_first,
      revenue: r.revenue,
      departure_airport: r.dep_airport, arrival_airport: r.arr_airport,
      distance_km: r.distance_km,
      dep_airport_name: r.dep_airport_name, arr_airport_name: r.arr_airport_name,
      dep_gh_light: r.dep_gh_light, dep_gh_medium: r.dep_gh_medium, dep_gh_heavy: r.dep_gh_heavy,
      arr_gh_light: r.arr_gh_light, arr_gh_medium: r.arr_gh_medium, arr_gh_heavy: r.arr_gh_heavy,
      landing_fee_light: r.landing_fee_light, landing_fee_medium: r.landing_fee_medium, landing_fee_heavy: r.landing_fee_heavy,
      fuel_cost: r.fuel_cost,
      atc_fee: r.atc_fee,
      catering_cost: r.catering_cost,
      landing_fee_paid: r.landing_fee_paid,
      ground_handling_paid: r.ground_handling_paid,
      eco_capacity: r.eco_capacity,
      biz_capacity: r.biz_capacity,
      fir_capacity: r.fir_capacity,
      satisfaction_score: r.satisfaction_score,
      violated_rules: r.violated_rules ? JSON.parse(r.violated_rules) : [],
    }));

    const maintResult = await pool.query(`
      SELECT id, day_of_week, start_minutes, duration_minutes, type
      FROM maintenance_schedule
      WHERE aircraft_id = $1
    `, [aircraftId]);
    const maintEntries = maintResult.rows.map(r => ({
      id: r.id, day_of_week: r.day_of_week, start_minutes: r.start_minutes,
      duration_minutes: r.duration_minutes, type: r.type
    }));

    const startOfToday = new Date(now); startOfToday.setUTCHours(0, 0, 0, 0);
    const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const windowEnd   = new Date(now.getTime() + 72 * 60 * 60 * 1000);

    function berlinOffsetMin(date) {
      const s = date.toLocaleString('sv', { timeZone: 'Europe/Berlin' });
      const asUtc = new Date(s.replace(' ', 'T') + 'Z');
      return Math.round((asUtc.getTime() - date.getTime()) / 60000);
    }

    for (const m of maintEntries) {
      for (const weekOffset of [0, 7]) {
        const jsTargetDay = m.day_of_week === 6 ? 0 : m.day_of_week + 1;
        const currentJsDay = startOfToday.getUTCDay();
        let daysUntil = (jsTargetDay - currentJsDay + 7) % 7 + weekOffset;

        const occurrenceDate = new Date(startOfToday);
        occurrenceDate.setUTCDate(occurrenceDate.getUTCDate() + daysUntil);
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
          break;
        }
      }
    }

    const trResult = await pool.query(`
      SELECT id, departure_airport, arrival_airport, departure_time, arrival_time, status, cost
      FROM transfer_flights
      WHERE aircraft_id = $1 AND airline_id = $2
        AND arrival_time >= $3 AND departure_time <= $4
    `, [aircraftId, airlineId, past24h, future72h]);

    for (const r of trResult.rows) {
      flights.push({
        id: `transfer_${r.id}`,
        _type: 'transfer',
        _db_id: r.id,
        departure_airport: r.departure_airport,
        arrival_airport: r.arrival_airport,
        departure_time: r.departure_time,
        arrival_time: r.arrival_time,
        status: r.status,
        cost: r.cost,
      });
    }

    flights.sort((a, b) => new Date(a.departure_time) - new Date(b.departure_time));

    res.json({ flights });
  } catch (error) {
    console.error('Get aircraft flights error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /:id/transfer — schedule a one-time positioning/transfer flight
router.post('/:id/transfer', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  const aircraftId = parseInt(req.params.id);
  const { destination_airport, departure_time } = req.body;

  if (!destination_airport || !departure_time) {
    return res.status(400).json({ error: 'destination_airport and departure_time are required' });
  }

  try {
    const airlineId = req.airlineId;

    const acResult = await pool.query(`
      SELECT a.id, a.current_location, a.home_airport, al.balance,
             t.cruise_speed_kmh
      FROM aircraft a
      JOIN airlines al ON al.id = a.airline_id
      JOIN aircraft_types t ON t.id = a.aircraft_type_id
      WHERE a.id = $1 AND a.airline_id = $2
    `, [aircraftId, airlineId]);
    if (!acResult.rows[0]) return res.status(404).json({ error: 'Aircraft not found' });
    const { current_location: currentLocation, home_airport: homeAirport, balance, cruise_speed_kmh: cruiseSpeed } = acResult.rows[0];

    const departureAirport = currentLocation || homeAirport;
    if (!departureAirport) return res.status(400).json({ error: 'Aircraft has no known location' });
    if (departureAirport === destination_airport) {
      return res.status(400).json({ error: 'Aircraft is already at this airport' });
    }

    const TRANSFER_COST = 500000;
    if (balance < TRANSFER_COST) {
      return res.status(400).json({ error: `Insufficient balance. Transfer costs $500,000 (balance: $${Math.round(balance).toLocaleString()})` });
    }

    const apResult = await pool.query('SELECT iata_code, latitude, longitude FROM airports WHERE iata_code IN ($1, $2)', [departureAirport, destination_airport]);
    const apCoords = {};
    for (const r of apResult.rows) {
      apCoords[r.iata_code] = { lat: r.latitude, lon: r.longitude };
    }

    if (!apCoords[departureAirport] || !apCoords[destination_airport]) {
      return res.status(400).json({ error: 'Airport coordinates not found' });
    }

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
    const flightMinutes = Math.round((distanceKm / speed) * 60) + 30;

    const depDt = new Date(departure_time);
    if (isNaN(depDt.getTime())) return res.status(400).json({ error: 'Invalid departure_time' });
    if (depDt < new Date()) return res.status(400).json({ error: 'Departure time must be in the future' });

    const arrDt = new Date(depDt.getTime() + flightMinutes * 60000);
    const depISO = depDt.toISOString();
    const arrISO = arrDt.toISOString();

    const conflictResult = await pool.query(`
      SELECT COUNT(*) as cnt FROM flights
      WHERE aircraft_id = $1
        AND status IN ('scheduled', 'boarding', 'in-flight')
        AND departure_time < $2 AND arrival_time > $3
    `, [aircraftId, arrISO, depISO]);
    const conflictCount = parseInt(conflictResult.rows[0].cnt);
    if (conflictCount > 0) {
      return res.status(400).json({ error: `Transfer conflicts with ${conflictCount} scheduled flight(s). Clear or reschedule overlapping flights first.` });
    }

    const trConflictResult = await pool.query(`
      SELECT COUNT(*) as cnt FROM transfer_flights
      WHERE aircraft_id = $1 AND status = 'scheduled'
        AND departure_time < $2 AND arrival_time > $3
    `, [aircraftId, arrISO, depISO]);
    const trConflict = parseInt(trConflictResult.rows[0].cnt);
    if (trConflict > 0) {
      return res.status(400).json({ error: 'Transfer overlaps with another scheduled transfer flight.' });
    }

    await pool.query('UPDATE airlines SET balance = balance - $1 WHERE id = $2', [TRANSFER_COST, airlineId]);

    await pool.query(`
      INSERT INTO transfer_flights (aircraft_id, airline_id, departure_airport, arrival_airport, departure_time, arrival_time, cost, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled')
    `, [aircraftId, airlineId, departureAirport, destination_airport, depISO, arrISO, TRANSFER_COST]);

    const balResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [airlineId]);
    const newBalance = balResult.rows[0].balance;

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
router.delete('/:id/scrap', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  const aircraftId = parseInt(req.params.id);
  try {
    const acResult = await pool.query(`
      SELECT ac.id, at.new_price_usd, at.full_name, ac.registration, ac.is_active
      FROM aircraft ac
      JOIN aircraft_types at ON at.id = ac.aircraft_type_id
      WHERE ac.id = $1 AND ac.airline_id = $2
    `, [aircraftId, req.airlineId]);
    if (!acResult.rows[0]) return res.status(404).json({ error: 'Aircraft not found' });
    const { new_price_usd: newPrice, full_name: fullName, registration, is_active: isOpForScrap } = acResult.rows[0];

    if (isOpForScrap) {
      return res.status(400).json({ error: 'Deactivate aircraft before scrapping. Aircraft must be inactive with no pending scheduled flights.' });
    }

    const pendingResult = await pool.query(`SELECT COUNT(*) as cnt FROM flights WHERE aircraft_id = $1 AND status IN ('scheduled','boarding','in-flight')`, [aircraftId]);
    const pendingFlights = parseInt(pendingResult.rows[0].cnt);
    if (pendingFlights > 0) {
      return res.status(400).json({ error: 'Cannot scrap aircraft: wait until all scheduled flights complete.' });
    }

    const scrapValue = Math.round((newPrice || 0) * 0.05);

    const balResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const currentBalance = balResult.rows[0].balance;

    await pool.query('UPDATE personnel SET aircraft_id = NULL WHERE aircraft_id = $1', [aircraftId]);
    await pool.query('DELETE FROM aircraft WHERE id = $1 AND airline_id = $2', [aircraftId, req.airlineId]);

    const newBalance = currentBalance + scrapValue;
    await pool.query('UPDATE airlines SET balance = $1 WHERE id = $2', [newBalance, req.airlineId]);

    if (scrapValue > 0) {
      await pool.query('INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, $2, $3, $4)',
        [req.airlineId, 'other', scrapValue, `Scrap value: ${registration} ${fullName}`]);
    }

    res.json({ message: 'Aircraft scrapped', scrap_value: scrapValue, new_balance: newBalance });
  } catch (err) {
    console.error('Scrap aircraft error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/aircraft/market/used — list used aircraft market
router.get('/market/used', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.registration, u.manufactured_year, u.total_flight_hours, u.current_value, u.listed_at,
             t.id as type_id, t.manufacturer, t.model, t.full_name, t.max_passengers, t.range_km,
             t.cruise_speed_kmh, t.wake_turbulence_category, t.image_filename,
             t.new_price_usd, t.min_runway_takeoff_m, t.min_runway_landing_m, u.location
      FROM used_aircraft_market u
      JOIN aircraft_types t ON u.aircraft_type_id = t.id
      ORDER BY u.current_value ASC
    `);
    const listings = result.rows.map(r => {
      const currentYear = new Date().getFullYear();
      const ageYears = currentYear - r.manufactured_year;
      return {
        id: r.id, registration: r.registration, manufactured_year: r.manufactured_year,
        total_flight_hours: r.total_flight_hours, current_value: r.current_value, listed_at: r.listed_at,
        age_years: ageYears,
        type_id: r.type_id, manufacturer: r.manufacturer, model: r.model, full_name: r.full_name,
        max_passengers: r.max_passengers, range_km: r.range_km, cruise_speed_kmh: r.cruise_speed_kmh,
        wake_turbulence_category: r.wake_turbulence_category, image_filename: r.image_filename,
        new_price_usd: r.new_price_usd, min_runway_takeoff_m: r.min_runway_takeoff_m,
        min_runway_landing_m: r.min_runway_landing_m, location: r.location
      };
    });
    res.json({ listings });
  } catch(e) {
    console.error('Used market list error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/aircraft/market/used/:id/buy — buy from used market
router.post('/market/used/:id/buy', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  const listingId = parseInt(req.params.id);
  const { deliveryAirport, cabin_profile_id } = req.body;
  try {
    const lResult = await pool.query('SELECT u.*, t.new_price_usd, t.depreciation_age, t.depreciation_fh FROM used_aircraft_market u JOIN aircraft_types t ON u.aircraft_type_id = t.id WHERE u.id = $1', [listingId]);
    if (!lResult.rows[0]) return res.status(404).json({ error: 'Listing not found' });
    const l = lResult.rows[0];
    const { aircraft_type_id: typeId, manufactured_year: manufacturedYear, total_flight_hours: totalFh,
            current_value: currentValue, seller_aircraft_id: sellerAircraftId, seller_airline_id: sellerAirlineId } = l;

    const balResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const balance = balResult.rows[0].balance;
    if (balance < currentValue) return res.status(400).json({ error: 'Insufficient funds' });

    const airlineResult = await pool.query('SELECT home_airport_code FROM airlines WHERE id = $1', [req.airlineId]);
    const buyerHomeAirport = airlineResult.rows[0].home_airport_code;
    const registration = await genRegForLocation(buyerHomeAirport);

    const purchasedAt = `${manufacturedYear}-07-01 00:00:00`;
    const airport = deliveryAirport || null;
    await pool.query(`
      INSERT INTO aircraft (airline_id, aircraft_type_id, registration, home_airport, is_active,
        purchased_at, current_location, total_flight_hours, airline_cabin_profile_id)
      VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8)
    `, [req.airlineId, typeId, registration, airport, purchasedAt, airport, totalFh, cabin_profile_id || null]);

    await pool.query('DELETE FROM used_aircraft_market WHERE id = $1', [listingId]);

    if (sellerAircraftId && sellerAirlineId) {
      await pool.query('UPDATE personnel SET aircraft_id = NULL WHERE aircraft_id = $1', [sellerAircraftId]);
      await pool.query('DELETE FROM aircraft WHERE id = $1', [sellerAircraftId]);
      const selBalResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [sellerAirlineId]);
      const sellerBalance = selBalResult.rows[0].balance;
      await pool.query('UPDATE airlines SET balance = $1 WHERE id = $2', [sellerBalance + currentValue, sellerAirlineId]);
      await pool.query(
        "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'other', $2, $3)",
        [sellerAirlineId, currentValue, `Aircraft sold on used market: ${registration}`]
      );
    }

    const newBalance = balance - currentValue;
    await pool.query('UPDATE airlines SET balance = $1 WHERE id = $2', [newBalance, req.airlineId]);
    await pool.query(
      "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'aircraft_purchase', $2, $3)",
      [req.airlineId, -currentValue, `Used aircraft purchase: ${registration}`]
    );

    res.json({ message: `${registration} added to fleet`, new_balance: newBalance });
  } catch(e) {
    console.error('Buy used aircraft error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/aircraft/:id/sell-to-market — list aircraft on used market
router.post('/:id/sell-to-market', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  const aircraftId = parseInt(req.params.id);
  try {
    const acResult = await pool.query(`
      SELECT ac.registration, ac.purchased_at, ac.total_flight_hours,
             t.new_price_usd, t.depreciation_age, t.depreciation_fh, t.id as type_id, t.full_name,
             ac.current_location, ac.is_active, ac.is_listed_for_sale
      FROM aircraft ac JOIN aircraft_types t ON t.id = ac.aircraft_type_id
      WHERE ac.id = $1 AND ac.airline_id = $2
    `, [aircraftId, req.airlineId]);
    if (!acResult.rows[0]) return res.status(404).json({ error: 'Aircraft not found' });
    const r = acResult.rows[0];
    const { registration, purchased_at: purchasedAt, total_flight_hours: totalFh, new_price_usd: newPrice,
            depreciation_age: kAge, depreciation_fh: kFh, type_id: typeId, full_name: fullName,
            current_location: currentLocation, is_active: isActive, is_listed_for_sale: alreadyListed } = r;

    if (isActive) return res.status(400).json({ error: 'Deactivate aircraft before listing for sale.' });
    if (alreadyListed) return res.status(400).json({ error: 'Aircraft is already listed for sale.' });

    const pendingResult = await pool.query(`SELECT COUNT(*) as cnt FROM flights WHERE aircraft_id = $1 AND status IN ('scheduled','boarding','in-flight')`, [aircraftId]);
    const pendingCount = parseInt(pendingResult.rows[0].cnt);
    if (pendingCount > 0) return res.status(400).json({ error: 'Cannot list aircraft: wait until all scheduled flights complete.' });

    const deliveryMs = purchasedAt ? new Date(purchasedAt).getTime() : Date.now();
    const ageYears = Math.max(0, (Date.now() - deliveryMs) / (365.25 * 24 * 3600 * 1000));
    const marketValue = Math.round(calcUsedValue(newPrice, kAge, kFh, ageYears, totalFh || 0));
    const manufacturedYear = Math.round(new Date().getFullYear() - ageYears);
    const finalReg = await genRegForLocation(currentLocation);

    await pool.query(
      'INSERT INTO used_aircraft_market (aircraft_type_id, registration, manufactured_year, total_flight_hours, current_value, location, seller_aircraft_id, seller_airline_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [typeId, finalReg, manufacturedYear, totalFh || 0, marketValue, currentLocation || null, aircraftId, req.airlineId]
    );

    await pool.query('UPDATE aircraft SET is_listed_for_sale = 1 WHERE id = $1', [aircraftId]);

    res.json({ message: `${registration} listed on used market`, market_value: marketValue, is_listed_for_sale: 1 });
  } catch(e) {
    console.error('Sell to market error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/aircraft/:id/cancel-listing — remove from used market, keep in fleet
router.delete('/:id/cancel-listing', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  const aircraftId = parseInt(req.params.id);
  try {
    const chkResult = await pool.query('SELECT id, is_listed_for_sale FROM aircraft WHERE id = $1 AND airline_id = $2', [aircraftId, req.airlineId]);
    if (!chkResult.rows[0]) return res.status(404).json({ error: 'Aircraft not found' });
    if (!chkResult.rows[0].is_listed_for_sale) return res.status(400).json({ error: 'Aircraft is not listed for sale.' });

    await pool.query('DELETE FROM used_aircraft_market WHERE seller_aircraft_id = $1', [aircraftId]);
    await pool.query('UPDATE aircraft SET is_listed_for_sale = 0 WHERE id = $1', [aircraftId]);

    res.json({ message: 'Listing cancelled', is_listed_for_sale: 0 });
  } catch(e) {
    console.error('Cancel listing error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DEV: POST /api/aircraft/dev/clear-market — delete all used aircraft market listings
router.post('/dev/clear-market', authMiddleware, async (_req, res) => {
  try {
    await pool.query('DELETE FROM used_aircraft_market');
    res.json({ message: 'Market cleared' });
  } catch(e) {
    console.error('Clear market error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DEV: POST /api/aircraft/dev/fill-market — manually fill used aircraft market
router.post('/dev/fill-market', authMiddleware, async (_req, res) => {
  try {
    const added = await fillUsedMarket();
    res.json({ message: added > 0 ? `${added} neue Listings hinzugefügt` : 'Nichts hinzugefügt — alle Typen haben bereits Listings' });
  } catch(e) {
    console.error('Fill market error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/aircraft/types?level=X — aircraft types for a specific required_level
router.get('/types', authMiddleware, async (req, res) => {
  try {
    const level = parseInt(req.query.level) || 1;
    const result = await pool.query(`
      SELECT id, full_name, max_passengers, range_km, image_filename, required_level
      FROM aircraft_types WHERE required_level = $1 ORDER BY max_passengers ASC
    `, [level]);
    const types = result.rows.map(r => ({
      id: r.id, full_name: r.full_name, max_passengers: r.max_passengers,
      range_km: r.range_km, image_filename: r.image_filename, required_level: r.required_level
    }));
    res.json({ types });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
