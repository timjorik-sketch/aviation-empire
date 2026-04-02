import express from 'express';
import { getDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// GET /api/airports/available — all airports with is_opened_by_airline flag (requires auth)
router.get('/available', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();
    const airlineId = req.airlineId;

    const stmt = db.prepare(`
      SELECT ap.iata_code, ap.name, ap.country, ap.continent, ap.category,
             CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END AS is_opened
      FROM airports ap
      LEFT JOIN airline_destinations d
        ON d.airport_code = ap.iata_code AND d.airline_id = ?
      ORDER BY ap.iata_code ASC
    `);
    stmt.bind([airlineId]);

    const airports = [];
    while (stmt.step()) {
      const r = stmt.get();
      airports.push({
        iata_code: r[0], name: r[1], country: r[2],
        continent: r[3], category: r[4], is_opened: r[5] === 1
      });
    }
    stmt.free();
    res.json({ airports });
  } catch (error) {
    console.error('Available airports error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airports — list all airports (used for dropdowns, no auth)
router.get('/', (req, res) => {
  try {
    const db = getDatabase();
    const result = db.exec(
      'SELECT iata_code, name, country FROM airports ORDER BY country, name'
    );
    if (!result.length) return res.json({ airports: [] });
    const airports = result[0].values.map(r => ({
      iata_code: r[0], name: r[1], country: r[2]
    }));
    res.json({ airports });
  } catch (error) {
    console.error('List airports error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airports/:code/airline-status — this airline's destination status for this airport
router.get('/:code/airline-status', authMiddleware, (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const airlineId = req.airlineId;
    if (!airlineId) return res.json({ is_opened: false, destination_type: null, effective_type: null, weekly_flights: 0 });

    const db = getDatabase();

    // Check if it's the home base
    const homeStmt = db.prepare('SELECT home_airport_code FROM airlines WHERE id = ?');
    homeStmt.bind([airlineId]);
    let isHomeBase = false;
    if (homeStmt.step()) isHomeBase = homeStmt.get()[0] === code;
    homeStmt.free();

    // Helper queries used for both home_base and opened destinations
    const aircraftStmt = db.prepare(
      'SELECT COUNT(*) FROM aircraft WHERE airline_id = ? AND home_airport = ?'
    );
    aircraftStmt.bind([airlineId, code]);
    aircraftStmt.step();
    const aircraftBased = aircraftStmt.get()[0] || 0;
    aircraftStmt.free();

    const staffStmt = db.prepare(
      "SELECT count FROM personnel WHERE airline_id = ? AND staff_type = 'ground' AND airport_code = ?"
    );
    staffStmt.bind([airlineId, code]);
    const groundStaff = staffStmt.step() ? (staffStmt.get()[0] || 0) : 0;
    staffStmt.free();

    const completedStmt = db.prepare(`
      SELECT COUNT(*) FROM flights f
      JOIN routes r ON f.route_id = r.id
      WHERE f.airline_id = ? AND (r.departure_airport = ? OR r.arrival_airport = ?) AND f.status = 'completed'
    `);
    completedStmt.bind([airlineId, code, code]);
    completedStmt.step();
    const completedFlights = completedStmt.get()[0] || 0;
    completedStmt.free();

    if (isHomeBase) {
      const wfHomeStmt = db.prepare(`
        SELECT COUNT(*) FROM weekly_schedule ws
        JOIN aircraft ac ON ws.aircraft_id = ac.id
        WHERE ac.airline_id = ? AND (ws.departure_airport = ? OR ws.arrival_airport = ?)
      `);
      wfHomeStmt.bind([airlineId, code, code]);
      wfHomeStmt.step();
      const weeklyFlightsHome = wfHomeStmt.get()[0] || 0;
      wfHomeStmt.free();

      return res.json({
        is_opened: true, destination_type: 'home_base', effective_type: 'home_base',
        weekly_flights: weeklyFlightsHome,
        aircraft_based: aircraftBased,
        ground_staff: groundStaff,
        completed_flights: completedFlights
      });
    }

    const destStmt = db.prepare(`
      SELECT d.destination_type,
             (SELECT COUNT(*) FROM weekly_schedule ws
              JOIN aircraft ac ON ws.aircraft_id = ac.id
              WHERE ac.airline_id = ? AND (ws.departure_airport = ? OR ws.arrival_airport = ?)
             ) AS weekly_flights
      FROM airline_destinations d
      WHERE d.airline_id = ? AND d.airport_code = ?
    `);
    destStmt.bind([airlineId, code, code, airlineId, code]);

    if (!destStmt.step()) {
      destStmt.free();
      // Not formally opened — check if airline has any schedule entries here
      const wfCheckStmt = db.prepare(`
        SELECT COUNT(*) FROM weekly_schedule ws
        JOIN aircraft ac ON ws.aircraft_id = ac.id
        WHERE ac.airline_id = ? AND (ws.departure_airport = ? OR ws.arrival_airport = ?)
      `);
      wfCheckStmt.bind([airlineId, code, code]);
      wfCheckStmt.step();
      const wfCount = wfCheckStmt.get()[0] || 0;
      wfCheckStmt.free();
      if (wfCount > 0) {
        const etype2 = wfCount >= 600 ? 'base' : 'destination';
        return res.json({
          is_opened: true, destination_type: 'destination', effective_type: etype2,
          weekly_flights: wfCount, aircraft_based: aircraftBased,
          ground_staff: groundStaff, completed_flights: completedFlights
        });
      }
      return res.json({ is_opened: false, destination_type: null, effective_type: null, weekly_flights: 0 });
    }
    const r = destStmt.get();
    destStmt.free();

    const dtype = r[0];
    const wf = r[1];
    const etype = (dtype === 'destination' && wf >= 600) ? 'base' : dtype;
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
router.get('/:code', (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT iata_code, name, country, registration_prefix,
             landing_fee_light, landing_fee_medium, landing_fee_heavy,
             ground_handling_fee, ground_handling_fee_light, ground_handling_fee_medium, ground_handling_fee_heavy,
             category, continent, state, runway_length_m, latitude, longitude
      FROM airports WHERE iata_code = ?
    `);
    stmt.bind([code]);
    if (!stmt.step()) {
      stmt.free();
      return res.status(404).json({ error: 'Airport not found' });
    }
    const r = stmt.get();
    stmt.free();
    res.json({
      airport: {
        iata_code: r[0], name: r[1], country: r[2], registration_prefix: r[3],
        landing_fee_light: r[4], landing_fee_medium: r[5], landing_fee_heavy: r[6],
        ground_handling_fee: r[7],
        ground_handling_fee_light: r[8], ground_handling_fee_medium: r[9], ground_handling_fee_heavy: r[10],
        category: r[11], continent: r[12], state: r[13], runway_length_m: r[14],
        latitude: r[15], longitude: r[16]
      }
    });
  } catch (error) {
    console.error('Get airport error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airports/:code/capable-aircraft — aircraft types that can land at this airport
router.get('/:code/capable-aircraft', (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const db = getDatabase();

    // Get runway length
    const apStmt = db.prepare('SELECT runway_length_m FROM airports WHERE iata_code = ?');
    apStmt.bind([code]);
    if (!apStmt.step()) { apStmt.free(); return res.status(404).json({ error: 'Airport not found' }); }
    const runway = apStmt.get()[0];
    apStmt.free();

    if (!runway) return res.json({ aircraft: [], runway_length_m: null });

    const stmt = db.prepare(`
      SELECT id, manufacturer, model, full_name, max_passengers, range_km,
             min_runway_landing_m, wake_turbulence_category, image_filename
      FROM aircraft_types
      WHERE min_runway_landing_m <= ?
      ORDER BY min_runway_landing_m DESC, max_passengers DESC
    `);
    stmt.bind([runway]);
    const aircraft = [];
    while (stmt.step()) {
      const r = stmt.get();
      aircraft.push({
        id: r[0], manufacturer: r[1], model: r[2], full_name: r[3],
        max_passengers: r[4], range_km: r[5],
        min_runway_landing_m: r[6], wake_turbulence_category: r[7],
        image_filename: r[8]
      });
    }
    stmt.free();
    res.json({ aircraft, runway_length_m: runway });
  } catch (error) {
    console.error('Get capable aircraft error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airports/:code/departures — next 30 departures (next 3 days)
router.get('/:code/departures', (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT f.id, f.flight_number, f.departure_time, f.arrival_time, f.status,
             r.arrival_airport AS destination,
             ap_dest.name AS destination_name,
             al.name AS airline_name, al.airline_code,
             at.model AS aircraft_model, al.logo_filename
      FROM flights f
      JOIN routes r ON f.route_id = r.id
      JOIN airports ap_dest ON ap_dest.iata_code = r.arrival_airport
      JOIN airlines al ON f.airline_id = al.id
      JOIN aircraft ac ON f.aircraft_id = ac.id
      JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      WHERE r.departure_airport = ?
        AND f.departure_time >= datetime('now', '-1 minute')
        AND f.departure_time <= datetime('now', '+3 days')
        AND f.status != 'cancelled'
      ORDER BY f.departure_time ASC
      LIMIT 30
    `);
    stmt.bind([code]);
    const flights = [];
    while (stmt.step()) {
      const r = stmt.get();
      flights.push({
        id: r[0], flight_number: r[1], departure_time: r[2], arrival_time: r[3], status: r[4],
        destination: r[5], destination_name: r[6], airline_name: r[7], airline_code: r[8],
        aircraft_model: r[9], logo_filename: r[10] ?? null
      });
    }
    stmt.free();
    res.json({ flights });
  } catch (error) {
    console.error('Get departures error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airports/:code/arrivals — next 30 arrivals (next 3 days)
router.get('/:code/arrivals', (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT f.id, f.flight_number, f.departure_time, f.arrival_time, f.status,
             r.departure_airport AS origin,
             ap_orig.name AS origin_name,
             al.name AS airline_name, al.airline_code,
             at.model AS aircraft_model, al.logo_filename
      FROM flights f
      JOIN routes r ON f.route_id = r.id
      JOIN airports ap_orig ON ap_orig.iata_code = r.departure_airport
      JOIN airlines al ON f.airline_id = al.id
      JOIN aircraft ac ON f.aircraft_id = ac.id
      JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      WHERE r.arrival_airport = ?
        AND f.arrival_time >= datetime('now', '-1 minute')
        AND f.arrival_time <= datetime('now', '+3 days')
        AND f.status != 'cancelled'
      ORDER BY f.arrival_time ASC
      LIMIT 30
    `);
    stmt.bind([code]);
    const flights = [];
    while (stmt.step()) {
      const r = stmt.get();
      flights.push({
        id: r[0], flight_number: r[1], departure_time: r[2], arrival_time: r[3], status: r[4],
        origin: r[5], origin_name: r[6], airline_name: r[7], airline_code: r[8],
        aircraft_model: r[9], logo_filename: r[10] ?? null
      });
    }
    stmt.free();
    res.json({ flights });
  } catch (error) {
    console.error('Get arrivals error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airports/:code/airlines — airlines operating at airport with weekly departure counts
router.get('/:code/airlines', (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT al.name, al.airline_code, COUNT(ws.id) AS weekly_departures, al.logo_filename
      FROM weekly_schedule ws
      JOIN aircraft ac ON ws.aircraft_id = ac.id
      JOIN airlines al ON ac.airline_id = al.id
      WHERE ws.departure_airport = ?
      GROUP BY al.id
      ORDER BY weekly_departures DESC
    `);
    stmt.bind([code]);
    const airlines = [];
    while (stmt.step()) {
      const r = stmt.get();
      airlines.push({ name: r[0], airline_code: r[1], weekly_departures: r[2], logo_filename: r[3] ?? null });
    }
    stmt.free();
    res.json({ airlines });
  } catch (error) {
    console.error('Get airport airlines error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
