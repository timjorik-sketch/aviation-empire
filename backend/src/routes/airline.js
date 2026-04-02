import express from 'express';
import { body, validationResult } from 'express-validator';
import { getDatabase, saveDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';
import { getAirlineSatisfactionScore } from '../utils/satisfaction.js';
import { checkLevelUp, XP_THRESHOLDS } from './flights.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGOS_DIR = path.join(__dirname, '../../public/airline-logos');
if (!fs.existsSync(LOGOS_DIR)) fs.mkdirSync(LOGOS_DIR, { recursive: true });

const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LOGOS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `airline_${req.airlineId}_${Date.now()}${ext}`);
  },
});
const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only PNG, JPEG, WebP or SVG allowed'));
  },
});

const router = express.Router();

// Helper: read full airline row by id
function fetchAirlineById(db, id) {
  const stmt = db.prepare(
    'SELECT id, user_id, name, airline_code, home_airport_code, balance, image_score, level, total_points, created_at, logo_filename FROM airlines WHERE id = ?'
  );
  stmt.bind([id]);
  if (!stmt.step()) { stmt.free(); return null; }
  const row = stmt.get();
  stmt.free();
  return {
    id: row[0], user_id: row[1], name: row[2], airline_code: row[3],
    home_airport_code: row[4], balance: row[5], image_score: row[6],
    level: row[7], total_points: row[8], created_at: row[9],
    logo_filename: row[10] ?? null,
  };
}

// GET /api/airline — returns the currently active airline
router.get('/', authMiddleware, (req, res) => {
  try {
    if (!req.airlineId) return res.json({ airline: null });
    const db = getDatabase();
    const airline = fetchAirlineById(db, req.airlineId);
    res.json({ airline });
  } catch (error) {
    console.error('Get airline error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airline/active-routes — distinct routes on operating aircraft with airport coordinates
router.get('/active-routes', authMiddleware, (req, res) => {
  try {
    if (!req.airlineId) return res.json({ routes: [] });
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT DISTINCT
        ws.departure_airport, ws.arrival_airport,
        dep_ap.latitude  AS dep_lat, dep_ap.longitude  AS dep_lng,
        arr_ap.latitude  AS arr_lat, arr_ap.longitude  AS arr_lng
      FROM weekly_schedule ws
      JOIN aircraft ac      ON ac.id         = ws.aircraft_id
      JOIN airports dep_ap  ON dep_ap.iata_code = ws.departure_airport
      JOIN airports arr_ap  ON arr_ap.iata_code = ws.arrival_airport
      WHERE ac.airline_id = ? AND ac.is_active = 1
        AND dep_ap.latitude IS NOT NULL AND arr_ap.latitude IS NOT NULL
    `);
    stmt.bind([req.airlineId]);
    const routes = [];
    while (stmt.step()) {
      const r = stmt.get();
      routes.push({ dep: r[0], arr: r[1], depLat: r[2], depLng: r[3], arrLat: r[4], arrLng: r[5] });
    }
    stmt.free();
    res.json({ routes });
  } catch (error) {
    console.error('Active routes error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airline/all — returns all airlines for the user with fleet_count
router.get('/all', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();

    const stmt = db.prepare(`
      SELECT a.id, a.name, a.airline_code, a.home_airport_code, a.balance,
             a.image_score, a.level, a.total_points, a.created_at,
             ap.name AS home_airport_name,
             (SELECT COUNT(*) FROM aircraft ac WHERE ac.airline_id = a.id) AS fleet_count,
             a.logo_filename
      FROM airlines a
      LEFT JOIN airports ap ON a.home_airport_code = ap.iata_code
      WHERE a.user_id = ?
      ORDER BY a.created_at ASC
    `);
    stmt.bind([req.userId]);

    const airlines = [];
    while (stmt.step()) {
      const row = stmt.get();
      airlines.push({
        id: row[0],
        name: row[1],
        airline_code: row[2],
        home_airport_code: row[3],
        balance: row[4],
        image_score: row[5],
        level: row[6],
        total_points: row[7],
        created_at: row[8],
        home_airport_name: row[9],
        fleet_count: row[10],
        is_active: row[0] === req.airlineId,
        logo_filename: row[11] ?? null,
      });
    }
    stmt.free();

    res.json({ airlines });
  } catch (error) {
    console.error('Get all airlines error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/airline/select/:id — set the active airline for the user
router.post('/select/:id', authMiddleware, (req, res) => {
  try {
    const airlineId = parseInt(req.params.id);
    const db = getDatabase();

    // Verify this airline belongs to the user
    const checkStmt = db.prepare('SELECT id FROM airlines WHERE id = ? AND user_id = ?');
    checkStmt.bind([airlineId, req.userId]);
    if (!checkStmt.step()) {
      checkStmt.free();
      return res.status(404).json({ error: 'Airline not found' });
    }
    checkStmt.free();

    // Update active_airline_id
    const updateStmt = db.prepare('UPDATE users SET active_airline_id = ? WHERE id = ?');
    updateStmt.bind([airlineId, req.userId]);
    updateStmt.step();
    updateStmt.free();
    saveDatabase();

    const airline = fetchAirlineById(db, airlineId);
    res.json({ message: 'Active airline updated', airline });
  } catch (error) {
    console.error('Select airline error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/airline — create a new airline (max 3 per user)
router.post('/',
  authMiddleware,
  body('name').isLength({ min: 3, max: 50 }).trim().withMessage('Airline name must be 3-50 characters'),
  body('airline_code').matches(/^[A-Z]{2,3}$/).withMessage('Airline code must be 2-3 uppercase letters'),
  body('home_airport_code').matches(/^[A-Z]{3}$/).withMessage('Invalid airport code'),
  (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, airline_code, home_airport_code } = req.body;
      const db = getDatabase();

      // Check how many airlines this user already has
      const countStmt = db.prepare('SELECT COUNT(*) FROM airlines WHERE user_id = ?');
      countStmt.bind([req.userId]);
      countStmt.step();
      const count = countStmt.get()[0];
      countStmt.free();

      if (count >= 3) {
        return res.status(400).json({ error: 'Maximum of 3 airlines per user' });
      }

      // Check if airline code is taken
      const checkCodeStmt = db.prepare('SELECT id FROM airlines WHERE airline_code = ?');
      checkCodeStmt.bind([airline_code]);
      if (checkCodeStmt.step()) {
        checkCodeStmt.free();
        return res.status(400).json({ error: 'Airline code already taken' });
      }
      checkCodeStmt.free();

      // Verify airport exists
      const checkAirportStmt = db.prepare('SELECT iata_code FROM airports WHERE iata_code = ?');
      checkAirportStmt.bind([home_airport_code]);
      if (!checkAirportStmt.step()) {
        checkAirportStmt.free();
        return res.status(400).json({ error: 'Invalid airport code' });
      }
      checkAirportStmt.free();

      // Create airline
      const insertStmt = db.prepare(
        'INSERT INTO airlines (user_id, name, airline_code, home_airport_code) VALUES (?, ?, ?, ?)'
      );
      insertStmt.bind([req.userId, name, airline_code, home_airport_code]);
      insertStmt.step();
      insertStmt.free();

      // Fetch the new airline id
      const idStmt = db.prepare(
        'SELECT id FROM airlines WHERE user_id = ? AND airline_code = ?'
      );
      idStmt.bind([req.userId, airline_code]);
      idStmt.step();
      const newId = idStmt.get()[0];
      idStmt.free();

      // Set as active airline
      const activateStmt = db.prepare('UPDATE users SET active_airline_id = ? WHERE id = ?');
      activateStmt.bind([newId, req.userId]);
      activateStmt.step();
      activateStmt.free();

      // Seed 30 ground staff for the home base
      const groundStmt = db.prepare(
        "INSERT INTO personnel (airline_id, staff_type, airport_code, count, weekly_wage_per_person) VALUES (?, 'ground', ?, 30, 950)"
      );
      groundStmt.bind([newId, home_airport_code]);
      groundStmt.step();
      groundStmt.free();

      saveDatabase();

      const airline = fetchAirlineById(db, newId);

      res.status(201).json({
        message: 'Airline created successfully',
        airline
      });
    } catch (error) {
      console.error('Create airline error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /api/airline/departures — next 10 upcoming departures for the active airline
router.get('/departures', authMiddleware, (req, res) => {
  try {
    if (!req.airlineId) return res.json({ flights: [] });
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT f.flight_number, r.departure_airport, r.arrival_airport,
             f.departure_time, f.arrival_time, f.status,
             at.image_filename, at.model,
             ap_dep.name AS departure_airport_name,
             ap_arr.name AS arrival_airport_name,
             f.satisfaction_score
      FROM flights f
      JOIN routes r ON f.route_id = r.id
      JOIN aircraft ac ON f.aircraft_id = ac.id
      JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      LEFT JOIN airports ap_dep ON ap_dep.iata_code = r.departure_airport
      LEFT JOIN airports ap_arr ON ap_arr.iata_code = r.arrival_airport
      WHERE f.airline_id = ? AND f.status IN ('scheduled', 'boarding', 'in-flight')
      ORDER BY f.departure_time ASC
      LIMIT 15
    `);
    stmt.bind([req.airlineId]);
    const flights = [];
    while (stmt.step()) {
      const row = stmt.get();
      flights.push({
        flight_number: row[0],
        departure_airport: row[1],
        arrival_airport: row[2],
        departure_time: row[3],
        arrival_time: row[4],
        status: row[5],
        image_filename: row[6],
        aircraft_type: row[7],
        departure_airport_name: row[8],
        arrival_airport_name: row[9],
        satisfaction_score: row[10],
      });
    }
    stmt.free();
    res.json({ flights });
  } catch (error) {
    console.error('Departures error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airline/arrivals — next 10 upcoming arrivals for the active airline
router.get('/arrivals', authMiddleware, (req, res) => {
  try {
    if (!req.airlineId) return res.json({ flights: [] });
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT f.flight_number, r.departure_airport, r.arrival_airport,
             f.departure_time, f.arrival_time, f.status,
             at.image_filename, at.model,
             ap_dep.name AS departure_airport_name,
             ap_arr.name AS arrival_airport_name,
             f.satisfaction_score
      FROM flights f
      JOIN routes r ON f.route_id = r.id
      JOIN aircraft ac ON f.aircraft_id = ac.id
      JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      LEFT JOIN airports ap_dep ON ap_dep.iata_code = r.departure_airport
      LEFT JOIN airports ap_arr ON ap_arr.iata_code = r.arrival_airport
      WHERE f.airline_id = ? AND f.status IN ('scheduled', 'boarding', 'in-flight')
      ORDER BY f.arrival_time ASC
      LIMIT 15
    `);
    stmt.bind([req.airlineId]);
    const flights = [];
    while (stmt.step()) {
      const row = stmt.get();
      flights.push({
        flight_number: row[0],
        departure_airport: row[1],
        arrival_airport: row[2],
        departure_time: row[3],
        arrival_time: row[4],
        status: row[5],
        image_filename: row[6],
        aircraft_type: row[7],
        departure_airport_name: row[8],
        arrival_airport_name: row[9],
        satisfaction_score: row[10],
      });
    }
    stmt.free();
    res.json({ flights });
  } catch (error) {
    console.error('Arrivals error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airline/fleet-summary — aircraft types with counts for the active airline
router.get('/fleet-summary', authMiddleware, (req, res) => {
  try {
    if (!req.airlineId) return res.json({ fleet: [] });
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT at.full_name, at.image_filename, COUNT(*) AS count, at.manufacturer
      FROM aircraft ac
      JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      WHERE ac.airline_id = ?
      GROUP BY ac.aircraft_type_id
      ORDER BY at.manufacturer ASC, at.full_name ASC
    `);
    stmt.bind([req.airlineId]);
    const fleet = [];
    while (stmt.step()) {
      const row = stmt.get();
      fleet.push({ full_name: row[0], image_filename: row[1], count: row[2], manufacturer: row[3] });
    }
    stmt.free();
    res.json({ fleet });
  } catch (error) {
    console.error('Fleet summary error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airline/stats — network + financial summary for the dashboard
router.get('/stats', authMiddleware, (req, res) => {
  try {
    if (!req.airlineId) return res.json({ destinations_count: 0, hubs: [], weekly_revenue: 0 });
    const db = getDatabase();

    // Destinations count — unique airports actively served (have weekly_schedule entries on operating aircraft)
    const destStmt = db.prepare(`
      SELECT COUNT(*) FROM (
        SELECT ws.departure_airport AS airport
          FROM weekly_schedule ws
          JOIN aircraft ac ON ac.id = ws.aircraft_id
          WHERE ac.airline_id = ? AND ac.is_active = 1
        UNION
        SELECT ws.arrival_airport AS airport
          FROM weekly_schedule ws
          JOIN aircraft ac ON ac.id = ws.aircraft_id
          WHERE ac.airline_id = ? AND ac.is_active = 1
      )
    `);
    destStmt.bind([req.airlineId, req.airlineId]);
    destStmt.step();
    const destinations_count = destStmt.get()[0];
    destStmt.free();

    // Expansion airports (formerly hubs)
    const hubStmt = db.prepare(`
      SELECT e.airport_code, ap.name FROM airport_expansions e
      LEFT JOIN airports ap ON ap.iata_code = e.airport_code
      WHERE e.airline_id = ? AND e.expansion_level > 0
      ORDER BY e.airport_code
    `);
    hubStmt.bind([req.airlineId]);
    const hubs = [];
    while (hubStmt.step()) {
      const r = hubStmt.get();
      hubs.push({ code: r[0], name: r[1] });
    }
    hubStmt.free();

    // Weekly revenue (last 7 days by arrival_time)
    const revStmt = db.prepare(`
      SELECT COALESCE(SUM(revenue), 0) FROM flights
      WHERE airline_id = ? AND status = 'completed'
      AND arrival_time >= datetime('now', '-7 days')
    `);
    revStmt.bind([req.airlineId]);
    revStmt.step();
    const weekly_revenue = revStmt.get()[0];
    revStmt.free();

    const avg_satisfaction = getAirlineSatisfactionScore(db, req.airlineId);

    // Daily passengers (completed flights in last 24h)
    const dailyPaxStmt = db.prepare(`
      SELECT COALESCE(SUM(seats_sold), 0) FROM flights
      WHERE airline_id = ? AND status = 'completed'
        AND arrival_time >= datetime('now', '-1 day')
    `);
    dailyPaxStmt.bind([req.airlineId]);
    dailyPaxStmt.step();
    const daily_passengers = dailyPaxStmt.get()[0] || 0;
    dailyPaxStmt.free();

    // Total passengers (all completed flights)
    const totalPaxStmt = db.prepare(`
      SELECT COALESCE(SUM(seats_sold), 0) FROM flights
      WHERE airline_id = ? AND status = 'completed'
    `);
    totalPaxStmt.bind([req.airlineId]);
    totalPaxStmt.step();
    const total_passengers = totalPaxStmt.get()[0] || 0;
    totalPaxStmt.free();

    res.json({ destinations_count, hubs, weekly_revenue, avg_satisfaction, daily_passengers, total_passengers });
  } catch (error) {
    console.error('Airline stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airline/airports
router.get('/airports', (req, res) => {
  try {
    const db = getDatabase();
    const result = db.exec('SELECT iata_code, name, country FROM airports ORDER BY country, name');

    if (!result.length) {
      return res.json({ airports: [] });
    }

    const airports = result[0].values.map(row => ({
      iata_code: row[0],
      name: row[1],
      country: row[2]
    }));

    res.json({ airports });
  } catch (error) {
    console.error('Get airports error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id — delete an airline owned by the user
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const airlineId = parseInt(req.params.id);
    if (isNaN(airlineId)) return res.status(400).json({ error: 'Invalid airline ID' });
    const db = getDatabase();

    const ownStmt = db.prepare('SELECT id FROM airlines WHERE id = ? AND user_id = ?');
    ownStmt.bind([airlineId, req.userId]);
    if (!ownStmt.step()) { ownStmt.free(); return res.status(404).json({ error: 'Airline not found' }); }
    ownStmt.free();

    const delStmt = db.prepare('DELETE FROM airlines WHERE id = ? AND user_id = ?');
    delStmt.bind([airlineId, req.userId]);
    delStmt.step();
    delStmt.free();
    saveDatabase();

    res.json({ message: 'Airline deleted' });
  } catch (error) {
    console.error('Delete airline error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/airline/dev/add-points — DEV ONLY, delete before release
router.post('/dev/add-points', authMiddleware, (req, res) => {
  try {
    if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
    const amount = req.body.amount || 10_000;
    const db = getDatabase();
    const stmt = db.prepare('UPDATE airlines SET total_points = total_points + ? WHERE id = ?');
    stmt.bind([amount, req.airlineId]);
    stmt.step(); stmt.free();
    checkLevelUp(db, req.airlineId);
    const sel = db.prepare('SELECT total_points, level FROM airlines WHERE id = ?');
    sel.bind([req.airlineId]);
    sel.step();
    const [total_points, level] = sel.get();
    sel.free();
    saveDatabase();
    res.json({ total_points, level });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/airline/dev/add-money — DEV ONLY, delete before release
router.post('/dev/add-money', authMiddleware, (req, res) => {
  try {
    if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
    const amount = req.body.amount || 10_000_000;
    const db = getDatabase();
    const stmt = db.prepare('UPDATE airlines SET balance = balance + ? WHERE id = ?');
    stmt.bind([amount, req.airlineId]);
    stmt.step();
    stmt.free();
    const balStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    balStmt.bind([req.airlineId]);
    balStmt.step();
    const new_balance = balStmt.get()[0];
    balStmt.free();
    saveDatabase();
    res.json({ new_balance });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airline/xp — lightweight level + XP poll endpoint
router.get('/xp', authMiddleware, (req, res) => {
  try {
    if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
    const db = getDatabase();
    checkLevelUp(db, req.airlineId);
    const stmt = db.prepare('SELECT level, total_points FROM airlines WHERE id = ?');
    stmt.bind([req.airlineId]);
    if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: 'Airline not found' }); }
    const row = stmt.get();
    stmt.free();
    res.json({ level: row[0], total_points: row[1] });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/airline/logo — upload airline logo (480×120px enforced client-side)
router.post('/logo', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(403).json({ error: 'No active airline' });
  logoUpload.single('logo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const db = getDatabase();
    // Delete old logo file if present
    const oldStmt = db.prepare('SELECT logo_filename FROM airlines WHERE id = ?');
    oldStmt.bind([req.airlineId]);
    if (oldStmt.step()) {
      const old = oldStmt.get()[0];
      if (old) {
        const oldPath = path.join(LOGOS_DIR, old);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
    }
    oldStmt.free();

    const filename = req.file.filename;
    const updStmt = db.prepare('UPDATE airlines SET logo_filename = ? WHERE id = ?');
    updStmt.bind([filename, req.airlineId]);
    updStmt.step();
    updStmt.free();
    saveDatabase();

    res.json({ logo_filename: filename, logo_url: `/airline-logos/${filename}` });
  });
});

export default router;
