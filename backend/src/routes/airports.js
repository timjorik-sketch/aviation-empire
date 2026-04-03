import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';
import { calcGroundStaff } from './personnel.js';

const router = express.Router();

// GET /api/airports/available — all airports with is_opened_by_airline flag (requires auth)
router.get('/available', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;

    const result = await pool.query(`
      SELECT ap.iata_code, ap.name, ap.country, ap.continent, ap.category,
             CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END AS is_opened
      FROM airports ap
      LEFT JOIN airline_destinations d
        ON d.airport_code = ap.iata_code AND d.airline_id = $1
      ORDER BY ap.iata_code ASC
    `, [airlineId]);

    const airports = result.rows.map(r => ({
      iata_code: r.iata_code,
      name: r.name,
      country: r.country,
      continent: r.continent,
      category: r.category,
      is_opened: r.is_opened === 1 || r.is_opened === true
    }));
    res.json({ airports });
  } catch (error) {
    console.error('Available airports error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airports — list all airports (used for dropdowns, no auth)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT iata_code, name, country FROM airports ORDER BY country, name'
    );
    const airports = result.rows.map(r => ({
      iata_code: r.iata_code, name: r.name, country: r.country
    }));
    res.json({ airports });
  } catch (error) {
    console.error('List airports error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airports/:code/airline-status — this airline's destination status for this airport
router.get('/:code/airline-status', authMiddleware, async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const airlineId = req.airlineId;
    if (!airlineId) return res.json({ is_opened: false, destination_type: null, effective_type: null, weekly_flights: 0 });

    // Check if it's the home base
    const homeResult = await pool.query('SELECT home_airport_code FROM airlines WHERE id = $1', [airlineId]);
    const isHomeBase = homeResult.rows[0] ? homeResult.rows[0].home_airport_code === code : false;

    // Airport category
    const apResult = await pool.query('SELECT category FROM airports WHERE iata_code = $1', [code]);
    const apCategory = apResult.rows[0] ? (parseInt(apResult.rows[0].category) || 4) : 4;

    // Aircraft based at this airport
    const aircraftResult = await pool.query(
      'SELECT COUNT(*) FROM aircraft WHERE airline_id = $1 AND home_airport = $2',
      [airlineId, code]
    );
    const aircraftBased = parseInt(aircraftResult.rows[0].count) || 0;

    // Expansion level
    const expResult = await pool.query(
      'SELECT expansion_level FROM airport_expansions WHERE airline_id = $1 AND airport_code = $2',
      [airlineId, code]
    );
    const expansionLevel = expResult.rows[0] ? (parseInt(expResult.rows[0].expansion_level) || 0) : 0;

    // Completed flights
    const completedResult = await pool.query(`
      SELECT COUNT(*) FROM flights f
      JOIN routes r ON f.route_id = r.id
      WHERE f.airline_id = $1 AND (r.departure_airport = $2 OR r.arrival_airport = $2) AND f.status = 'completed'
    `, [airlineId, code]);
    const completedFlights = parseInt(completedResult.rows[0].count) || 0;

    if (isHomeBase) {
      const wfHomeResult = await pool.query(`
        SELECT COUNT(*) FROM weekly_schedule ws
        JOIN aircraft ac ON ws.aircraft_id = ac.id
        WHERE ac.airline_id = $1 AND (ws.departure_airport = $2 OR ws.arrival_airport = $2)
      `, [airlineId, code]);
      const weeklyFlightsHome = parseInt(wfHomeResult.rows[0].count) || 0;
      const groundStaff = calcGroundStaff(apCategory, 'home_base', weeklyFlightsHome, expansionLevel);

      return res.json({
        is_opened: true, destination_type: 'home_base', effective_type: 'home_base',
        weekly_flights: weeklyFlightsHome,
        aircraft_based: aircraftBased,
        ground_staff: groundStaff,
        completed_flights: completedFlights
      });
    }

    const destResult = await pool.query(`
      SELECT d.destination_type,
             (SELECT COUNT(*) FROM weekly_schedule ws
              JOIN aircraft ac ON ws.aircraft_id = ac.id
              WHERE ac.airline_id = $1 AND (ws.departure_airport = $2 OR ws.arrival_airport = $2)
             ) AS weekly_flights
      FROM airline_destinations d
      WHERE d.airline_id = $3 AND d.airport_code = $4
    `, [airlineId, code, airlineId, code]);

    if (!destResult.rows[0]) {
      // Not formally opened — check if airline has any schedule entries here
      const wfCheckResult = await pool.query(`
        SELECT COUNT(*) FROM weekly_schedule ws
        JOIN aircraft ac ON ws.aircraft_id = ac.id
        WHERE ac.airline_id = $1 AND (ws.departure_airport = $2 OR ws.arrival_airport = $2)
      `, [airlineId, code]);
      const wfCount = parseInt(wfCheckResult.rows[0].count) || 0;
      if (wfCount > 0) {
        const etype2 = wfCount >= 600 ? 'base' : 'destination';
        const groundStaff = calcGroundStaff(apCategory, 'destination', wfCount, expansionLevel);
        return res.json({
          is_opened: true, destination_type: 'destination', effective_type: etype2,
          weekly_flights: wfCount, aircraft_based: aircraftBased,
          ground_staff: groundStaff, completed_flights: completedFlights
        });
      }
      return res.json({ is_opened: false, destination_type: null, effective_type: null, weekly_flights: 0 });
    }

    const r = destResult.rows[0];
    const dtype = r.destination_type;
    const wf = parseInt(r.weekly_flights) || 0;
    const etype = (dtype === 'destination' && wf >= 600) ? 'base' : dtype;
    const groundStaff = calcGroundStaff(apCategory, dtype, wf, expansionLevel);
    res.json({
      is_opened: true, destination_type: dtype, effective_type: etype, weekly_flights: wf,
      aircraft_based: aircraftBased,
      ground_staff: groundStaff,
      completed_flights: completedFlights
    });
  } catch (error) {
    console.error('Airport airline-status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airports/:code — airport details with fees and metadata
router.get('/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const result = await pool.query(`
      SELECT iata_code, name, country, registration_prefix,
             landing_fee_light, landing_fee_medium, landing_fee_heavy,
             ground_handling_fee, ground_handling_fee_light, ground_handling_fee_medium, ground_handling_fee_heavy,
             category, continent, state, runway_length_m, latitude, longitude
      FROM airports WHERE iata_code = $1
    `, [code]);
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Airport not found' });
    }
    const r = result.rows[0];
    res.json({
      airport: {
        iata_code: r.iata_code, name: r.name, country: r.country,
        registration_prefix: r.registration_prefix,
        landing_fee_light: r.landing_fee_light, landing_fee_medium: r.landing_fee_medium,
        landing_fee_heavy: r.landing_fee_heavy,
        ground_handling_fee: r.ground_handling_fee,
        ground_handling_fee_light: r.ground_handling_fee_light,
        ground_handling_fee_medium: r.ground_handling_fee_medium,
        ground_handling_fee_heavy: r.ground_handling_fee_heavy,
        category: r.category, continent: r.continent, state: r.state,
        runway_length_m: r.runway_length_m,
        latitude: r.latitude, longitude: r.longitude
      }
    });
  } catch (error) {
    console.error('Get airport error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airports/:code/capable-aircraft — aircraft types that can land at this airport
router.get('/:code/capable-aircraft', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();

    // Get runway length
    const apResult = await pool.query('SELECT runway_length_m FROM airports WHERE iata_code = $1', [code]);
    if (!apResult.rows[0]) return res.status(404).json({ error: 'Airport not found' });
    const runway = apResult.rows[0].runway_length_m;

    if (!runway) return res.json({ aircraft: [], runway_length_m: null });

    const result = await pool.query(`
      SELECT id, manufacturer, model, full_name, max_passengers, range_km,
             min_runway_landing_m, wake_turbulence_category, image_filename
      FROM aircraft_types
      WHERE min_runway_landing_m <= $1
      ORDER BY min_runway_landing_m DESC, max_passengers DESC
    `, [runway]);

    const aircraft = result.rows.map(r => ({
      id: r.id, manufacturer: r.manufacturer, model: r.model, full_name: r.full_name,
      max_passengers: r.max_passengers, range_km: r.range_km,
      min_runway_landing_m: r.min_runway_landing_m,
      wake_turbulence_category: r.wake_turbulence_category,
      image_filename: r.image_filename
    }));
    res.json({ aircraft, runway_length_m: runway });
  } catch (error) {
    console.error('Get capable aircraft error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airports/:code/departures — next 30 departures (next 3 days)
router.get('/:code/departures', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const result = await pool.query(`
      SELECT f.id, f.flight_number, f.departure_time, f.arrival_time, f.status,
             COALESCE(r.arrival_airport, ws.arrival_airport) AS destination,
             ap_dest.name AS destination_name,
             al.name AS airline_name, al.airline_code,
             at.model AS aircraft_model, al.logo_filename
      FROM flights f
      LEFT JOIN routes r        ON f.route_id = r.id
      LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
      LEFT JOIN airports ap_dest ON ap_dest.iata_code = COALESCE(r.arrival_airport, ws.arrival_airport)
      JOIN airlines al    ON f.airline_id = al.id
      JOIN aircraft ac    ON f.aircraft_id = ac.id
      JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      WHERE COALESCE(r.departure_airport, ws.departure_airport) = $1
        AND f.departure_time >= NOW() - INTERVAL '1 minute'
        AND f.departure_time <= NOW() + INTERVAL '3 days'
        AND f.status != 'cancelled'
      ORDER BY f.departure_time ASC
      LIMIT 30
    `, [code]);
    const flights = result.rows.map(r => ({
      id: r.id, flight_number: r.flight_number,
      departure_time: r.departure_time, arrival_time: r.arrival_time,
      status: r.status, destination: r.destination,
      destination_name: r.destination_name, airline_name: r.airline_name,
      airline_code: r.airline_code, aircraft_model: r.aircraft_model,
      logo_filename: r.logo_filename ?? null
    }));
    res.json({ flights });
  } catch (error) {
    console.error('Get departures error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airports/:code/arrivals — next 30 arrivals (next 3 days)
router.get('/:code/arrivals', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const result = await pool.query(`
      SELECT f.id, f.flight_number, f.departure_time, f.arrival_time, f.status,
             COALESCE(r.departure_airport, ws.departure_airport) AS origin,
             ap_orig.name AS origin_name,
             al.name AS airline_name, al.airline_code,
             at.model AS aircraft_model, al.logo_filename
      FROM flights f
      LEFT JOIN routes r        ON f.route_id = r.id
      LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
      LEFT JOIN airports ap_orig ON ap_orig.iata_code = COALESCE(r.departure_airport, ws.departure_airport)
      JOIN airlines al    ON f.airline_id = al.id
      JOIN aircraft ac    ON f.aircraft_id = ac.id
      JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      WHERE COALESCE(r.arrival_airport, ws.arrival_airport) = $1
        AND f.arrival_time >= NOW() - INTERVAL '1 minute'
        AND f.arrival_time <= NOW() + INTERVAL '3 days'
        AND f.status != 'cancelled'
      ORDER BY f.arrival_time ASC
      LIMIT 30
    `, [code]);
    const flights = result.rows.map(r => ({
      id: r.id, flight_number: r.flight_number,
      departure_time: r.departure_time, arrival_time: r.arrival_time,
      status: r.status, origin: r.origin, origin_name: r.origin_name,
      airline_name: r.airline_name, airline_code: r.airline_code,
      aircraft_model: r.aircraft_model, logo_filename: r.logo_filename ?? null
    }));
    res.json({ flights });
  } catch (error) {
    console.error('Get arrivals error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airports/:code/airlines — airlines operating at airport with weekly departure counts
router.get('/:code/airlines', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const result = await pool.query(`
      SELECT al.name, al.airline_code, COUNT(ws.id) AS weekly_departures, al.logo_filename
      FROM weekly_schedule ws
      JOIN aircraft ac ON ws.aircraft_id = ac.id
      JOIN airlines al ON ac.airline_id = al.id
      WHERE ws.departure_airport = $1
      GROUP BY al.id, al.name, al.airline_code, al.logo_filename
      ORDER BY weekly_departures DESC
    `, [code]);
    const airlines = result.rows.map(r => ({
      name: r.name, airline_code: r.airline_code,
      weekly_departures: parseInt(r.weekly_departures),
      logo_filename: r.logo_filename ?? null
    }));
    res.json({ airlines });
  } catch (error) {
    console.error('Get airport airlines error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
