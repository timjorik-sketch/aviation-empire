import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';
import { calcGroundStaff } from './personnel.js';
import { diversionGeoFraction } from '../utils/delaySystem.js';

const router = express.Router();

// For a medical-diverted flight, the stored departure_time/arrival_time are the
// ORIGINAL endpoints (origin→dest). On the diversion airport's boards we must
// instead show when it actually touches down here and departs again. The cruise
// time (total minus the ground stop) is split by the diversion's geographic
// position along the route. Returns { arrival, departure } Date objects, or null.
function diversionStopTimes(depTime, arrTime, delayMin, depLat, depLon, arrLat, arrLon, divLat, divLon) {
  const frac = diversionGeoFraction(depLat, depLon, arrLat, arrLon, divLat, divLon);
  if (frac == null) return null;
  const dep = new Date(depTime).getTime();
  const arr = new Date(arrTime).getTime();
  const stopMs = Math.max(0, (delayMin || 0) * 60000);
  const cruiseMs = Math.max(0, (arr - dep) - stopMs);
  const arrival = new Date(dep + cruiseMs * frac);     // touchdown at diversion airport
  const departure = new Date(arrival.getTime() + stopMs); // continues onward
  return { arrival, departure };
}

// ── Board query helpers ───────────────────────────────────────────────────────
// Shared by the individual /departures, /arrivals, /airlines endpoints and by
// the merged /board endpoint (one request instead of three for the AirportPage).

async function queryDepartures(code) {
  // The board shows two classes of flight for this airport:
  //   1. 'normal'    — naturally departing from CODE
  //   2. 'diversion' — medical-diverted flight currently parked here, will
  //                    continue to its original destination
  const result = await pool.query(`
    SELECT f.id, f.flight_number, f.departure_time, f.arrival_time, f.status,
           f.delay_reason, f.delay_minutes, f.diversion_airport_code,
           COALESCE(r.arrival_airport, ws.arrival_airport) AS destination,
           ap_dest.name AS destination_name,
           al.name AS airline_name, al.airline_code,
           at.model AS aircraft_model, al.logo_filename,
           ap_dep.latitude AS dep_lat, ap_dep.longitude AS dep_lon,
           ap_dest.latitude AS dest_lat, ap_dest.longitude AS dest_lon,
           ap_div.latitude AS div_lat, ap_div.longitude AS div_lon,
           CASE
             WHEN f.diversion_airport_code = $1 THEN 'diversion'
             ELSE 'normal'
           END AS view_type
    FROM flights f
    LEFT JOIN routes r        ON f.route_id = r.id
    LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
    LEFT JOIN airports ap_dest ON ap_dest.iata_code = COALESCE(r.arrival_airport, ws.arrival_airport)
    LEFT JOIN airports ap_dep  ON ap_dep.iata_code  = COALESCE(r.departure_airport, ws.departure_airport)
    LEFT JOIN airports ap_div  ON ap_div.iata_code  = f.diversion_airport_code
    JOIN airlines al    ON f.airline_id = al.id
    JOIN aircraft ac    ON f.aircraft_id = ac.id
    JOIN aircraft_types at ON ac.aircraft_type_id = at.id
    WHERE f.status != 'cancelled' AND (
          (COALESCE(r.departure_airport, ws.departure_airport) = $1
            AND f.departure_time >= NOW() - INTERVAL '1 minute'
            AND f.departure_time <= NOW() + INTERVAL '3 days')
       OR (f.diversion_airport_code = $1
            AND f.delay_reason = 'medical'
            AND f.status IN ('boarding','in-flight'))
      )
    ORDER BY f.departure_time ASC
    LIMIT 30
  `, [code]);
  return result.rows.map(r => {
    // On the diversion airport's board, show the onward (continuation) departure
    // time, not the original origin departure.
    let departure_time = r.departure_time;
    if (r.view_type === 'diversion') {
      const t = diversionStopTimes(r.departure_time, r.arrival_time, r.delay_minutes,
        r.dep_lat, r.dep_lon, r.dest_lat, r.dest_lon, r.div_lat, r.div_lon);
      if (t) departure_time = t.departure;
    }
    return {
      id: r.id, flight_number: r.flight_number,
      departure_time, arrival_time: r.arrival_time,
      status: r.status, destination: r.destination,
      destination_name: r.destination_name, airline_name: r.airline_name,
      airline_code: r.airline_code, aircraft_model: r.aircraft_model,
      logo_filename: r.logo_filename ?? null,
      delay_reason: r.delay_reason,
      delay_minutes: r.delay_minutes,
      diversion_airport_code: r.diversion_airport_code,
      view_type: r.view_type,
    };
  });
}

async function queryArrivals(code) {
  // Three classes of arrival shown:
  //   1. 'normal'     — flight whose arrival_airport is CODE
  //   2. 'turnback'   — tech_air flight whose dep_airport is CODE; aircraft
  //                     turned back and is landing here mid-disruption
  //   3. 'diversion'  — medical-diverted flight whose diversion_airport is CODE
  const result = await pool.query(`
    SELECT f.id, f.flight_number, f.departure_time, f.arrival_time, f.status,
           f.delay_reason, f.delay_minutes, f.diversion_airport_code,
           COALESCE(r.departure_airport, ws.departure_airport) AS origin,
           COALESCE(r.arrival_airport,   ws.arrival_airport)   AS scheduled_dest,
           ap_orig.name AS origin_name,
           al.name AS airline_name, al.airline_code,
           at.model AS aircraft_model, al.logo_filename,
           ap_orig.latitude AS dep_lat, ap_orig.longitude AS dep_lon,
           ap_dest.latitude AS dest_lat, ap_dest.longitude AS dest_lon,
           ap_div.latitude  AS div_lat, ap_div.longitude  AS div_lon,
           CASE
             WHEN COALESCE(r.arrival_airport, ws.arrival_airport) = $1 THEN 'normal'
             WHEN COALESCE(r.departure_airport, ws.departure_airport) = $1
                  AND f.delay_reason = 'technical_air' THEN 'turnback'
             WHEN f.diversion_airport_code = $1 THEN 'diversion'
             ELSE 'normal'
           END AS view_type
    FROM flights f
    LEFT JOIN routes r        ON f.route_id = r.id
    LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
    LEFT JOIN airports ap_orig ON ap_orig.iata_code = COALESCE(r.departure_airport, ws.departure_airport)
    LEFT JOIN airports ap_dest ON ap_dest.iata_code = COALESCE(r.arrival_airport,   ws.arrival_airport)
    LEFT JOIN airports ap_div  ON ap_div.iata_code  = f.diversion_airport_code
    JOIN airlines al    ON f.airline_id = al.id
    JOIN aircraft ac    ON f.aircraft_id = ac.id
    JOIN aircraft_types at ON ac.aircraft_type_id = at.id
    WHERE f.status != 'cancelled' AND (
          (COALESCE(r.arrival_airport, ws.arrival_airport) = $1
            AND f.arrival_time >= NOW() - INTERVAL '1 minute'
            AND f.arrival_time <= NOW() + INTERVAL '3 days')
       OR (COALESCE(r.departure_airport, ws.departure_airport) = $1
            AND f.delay_reason = 'technical_air'
            AND f.status = 'in-flight')
       OR (f.diversion_airport_code = $1
            AND f.delay_reason = 'medical'
            AND f.status IN ('boarding','in-flight'))
      )
    ORDER BY f.arrival_time ASC
    LIMIT 30
  `, [code]);
  return result.rows.map(r => {
    // On the diversion airport's board, show when the flight actually lands
    // here, not the original destination arrival.
    let arrival_time = r.arrival_time;
    if (r.view_type === 'diversion') {
      const t = diversionStopTimes(r.departure_time, r.arrival_time, r.delay_minutes,
        r.dep_lat, r.dep_lon, r.dest_lat, r.dest_lon, r.div_lat, r.div_lon);
      if (t) arrival_time = t.arrival;
    }
    return {
      id: r.id, flight_number: r.flight_number,
      departure_time: r.departure_time, arrival_time,
      status: r.status, origin: r.origin, origin_name: r.origin_name,
      scheduled_dest: r.scheduled_dest,
      airline_name: r.airline_name, airline_code: r.airline_code,
      aircraft_model: r.aircraft_model, logo_filename: r.logo_filename ?? null,
      delay_reason: r.delay_reason,
      delay_minutes: r.delay_minutes,
      diversion_airport_code: r.diversion_airport_code,
      view_type: r.view_type,
    };
  });
}

async function queryAirlinesAt(code) {
  const result = await pool.query(`
    SELECT al.name, al.airline_code, COUNT(ws.id) AS weekly_departures, al.logo_filename
    FROM weekly_schedule ws
    JOIN aircraft ac ON ws.aircraft_id = ac.id
    JOIN airlines al ON ac.airline_id = al.id
    WHERE ws.departure_airport = $1
    GROUP BY al.id, al.name, al.airline_code, al.logo_filename
    ORDER BY weekly_departures DESC
  `, [code]);
  return result.rows.map(r => ({
    name: r.name, airline_code: r.airline_code,
    weekly_departures: parseInt(r.weekly_departures),
    logo_filename: r.logo_filename ?? null
  }));
}

// GET /api/airports/available — all airports with is_opened_by_airline flag (requires auth)
router.get('/available', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;

    const result = await pool.query(`
      SELECT ap.iata_code, ap.name, ap.country, ap.continent, ap.category, ap.runway_length_m,
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
      runway_length_m: r.runway_length_m,
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
             min_runway_takeoff_m, min_runway_landing_m,
             GREATEST(min_runway_takeoff_m, min_runway_landing_m) AS min_runway_required_m,
             wake_turbulence_category, image_filename
      FROM aircraft_types
      WHERE GREATEST(min_runway_takeoff_m, min_runway_landing_m) <= $1
      ORDER BY manufacturer ASC, display_order ASC, full_name ASC
    `, [runway]);

    const aircraft = result.rows.map(r => ({
      id: r.id, manufacturer: r.manufacturer, model: r.model, full_name: r.full_name,
      max_passengers: r.max_passengers, range_km: r.range_km,
      min_runway_takeoff_m: r.min_runway_takeoff_m,
      min_runway_landing_m: r.min_runway_landing_m,
      min_runway_required_m: r.min_runway_required_m,
      wake_turbulence_category: r.wake_turbulence_category,
      image_filename: r.image_filename
    }));
    res.json({ aircraft, runway_length_m: runway });
  } catch (error) {
    console.error('Get capable aircraft error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airports/:code/hover — lightweight data for airport hover popup (fees + capable aircraft)
router.get('/:code/hover', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const apResult = await pool.query(`
      SELECT iata_code, name, category, runway_length_m, latitude, longitude,
             landing_fee_light, landing_fee_medium, landing_fee_heavy,
             ground_handling_fee_light, ground_handling_fee_medium, ground_handling_fee_heavy
      FROM airports WHERE iata_code = $1
    `, [code]);
    if (!apResult.rows[0]) return res.status(404).json({ error: 'Airport not found' });
    const ap = apResult.rows[0];

    let aircraft = [];
    if (ap.runway_length_m) {
      const acResult = await pool.query(`
        SELECT full_name, max_passengers, image_filename, wake_turbulence_category
        FROM aircraft_types WHERE GREATEST(min_runway_takeoff_m, min_runway_landing_m) <= $1
        ORDER BY manufacturer ASC, display_order ASC, full_name ASC
      `, [ap.runway_length_m]);
      aircraft = acResult.rows.map(r => ({
        full_name: r.full_name, max_passengers: r.max_passengers,
        image_filename: r.image_filename, wake: r.wake_turbulence_category
      }));
    }

    res.json({
      iata_code: ap.iata_code, name: ap.name, category: ap.category,
      runway_length_m: ap.runway_length_m, latitude: ap.latitude, longitude: ap.longitude,
      fees: {
        landing_light: ap.landing_fee_light, landing_medium: ap.landing_fee_medium, landing_heavy: ap.landing_fee_heavy,
        handling_light: ap.ground_handling_fee_light, handling_medium: ap.ground_handling_fee_medium, handling_heavy: ap.ground_handling_fee_heavy,
      },
      aircraft,
    });
  } catch (error) {
    console.error('Airport hover error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airports/:code/board — merged departures + arrivals + airlines in a
// single request (the AirportPage always needs all three together).
router.get('/:code/board', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const [departures, arrivals, airlines] = await Promise.all([
      queryDepartures(code),
      queryArrivals(code),
      queryAirlinesAt(code),
    ]);
    res.json({ departures, arrivals, airlines });
  } catch (error) {
    console.error('Get airport board error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airports/:code/departures — next 30 departures (next 3 days)
router.get('/:code/departures', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const flights = await queryDepartures(code);
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
    const flights = await queryArrivals(code);
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
    const airlines = await queryAirlinesAt(code);
    res.json({ airlines });
  } catch (error) {
    console.error('Get airport airlines error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
