import express from 'express';
import { body, validationResult } from 'express-validator';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';
import { getAirlineSatisfactionScore } from '../utils/satisfaction.js';
import { addGroundStaff } from './personnel.js';
import { XP_THRESHOLDS } from './flights.js';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const BUCKET = 'airline-logos';

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only PNG, JPEG, WebP or SVG allowed'));
  },
});

const router = express.Router();

// Helper: read full airline row by id
async function fetchAirlineById(id) {
  const result = await pool.query(
    'SELECT id, user_id, name, airline_code, home_airport_code, balance, image_score, level, total_points, created_at, logo_filename FROM airlines WHERE id = $1',
    [id]
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    airline_code: row.airline_code,
    home_airport_code: row.home_airport_code,
    balance: row.balance,
    image_score: row.image_score,
    level: row.level,
    total_points: row.total_points,
    created_at: row.created_at,
    logo_filename: row.logo_filename ?? null,
  };
}

// Helper: check and apply level-up for an airline (PostgreSQL version)
async function checkLevelUpPg(airlineId) {
  const result = await pool.query('SELECT level, total_points FROM airlines WHERE id = $1', [airlineId]);
  if (!result.rows[0]) return { leveledUp: false };
  const { level: currentLevel, total_points: totalPoints } = result.rows[0];
  let newLevel = currentLevel;
  while (newLevel < XP_THRESHOLDS.length - 1 && totalPoints >= XP_THRESHOLDS[newLevel + 1]) {
    newLevel++;
  }
  if (newLevel !== currentLevel) {
    await pool.query('UPDATE airlines SET level = $1 WHERE id = $2', [newLevel, airlineId]);
    return { leveledUp: true, newLevel };
  }
  return { leveledUp: false };
}

// GET /api/airline — returns the currently active airline
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.json({ airline: null });
    const airline = await fetchAirlineById(req.airlineId);
    res.json({ airline });
  } catch (error) {
    console.error('Get airline error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airline/active-routes — distinct routes on operating aircraft with airport coordinates
router.get('/active-routes', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.json({ routes: [] });
    const result = await pool.query(`
      SELECT DISTINCT
        ws.departure_airport, ws.arrival_airport,
        dep_ap.latitude  AS dep_lat, dep_ap.longitude  AS dep_lng,
        arr_ap.latitude  AS arr_lat, arr_ap.longitude  AS arr_lng
      FROM weekly_schedule ws
      JOIN aircraft ac      ON ac.id         = ws.aircraft_id
      JOIN airports dep_ap  ON dep_ap.iata_code = ws.departure_airport
      JOIN airports arr_ap  ON arr_ap.iata_code = ws.arrival_airport
      WHERE ac.airline_id = $1 AND ac.is_active = 1
        AND dep_ap.latitude IS NOT NULL AND arr_ap.latitude IS NOT NULL
    `, [req.airlineId]);
    const routes = result.rows.map(r => ({
      dep: r.departure_airport, arr: r.arrival_airport,
      depLat: r.dep_lat, depLng: r.dep_lng,
      arrLat: r.arr_lat, arrLng: r.arr_lng
    }));
    res.json({ routes });
  } catch (error) {
    console.error('Active routes error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airline/all — returns all airlines for the user with fleet_count
router.get('/all', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.id, a.name, a.airline_code, a.home_airport_code, a.balance,
             a.image_score, a.level, a.total_points, a.created_at,
             ap.name AS home_airport_name,
             (SELECT COUNT(*) FROM aircraft ac WHERE ac.airline_id = a.id) AS fleet_count,
             a.logo_filename
      FROM airlines a
      LEFT JOIN airports ap ON a.home_airport_code = ap.iata_code
      WHERE a.user_id = $1
      ORDER BY a.created_at ASC
    `, [req.userId]);

    const airlines = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      airline_code: row.airline_code,
      home_airport_code: row.home_airport_code,
      balance: row.balance,
      image_score: row.image_score,
      level: row.level,
      total_points: row.total_points,
      created_at: row.created_at,
      home_airport_name: row.home_airport_name,
      fleet_count: parseInt(row.fleet_count),
      is_active: row.id === req.airlineId,
      logo_filename: row.logo_filename ?? null,
    }));

    res.json({ airlines });
  } catch (error) {
    console.error('Get all airlines error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/airline/select/:id — set the active airline for the user
router.post('/select/:id', authMiddleware, async (req, res) => {
  try {
    const airlineId = parseInt(req.params.id);

    // Verify this airline belongs to the user
    const checkResult = await pool.query(
      'SELECT id FROM airlines WHERE id = $1 AND user_id = $2',
      [airlineId, req.userId]
    );
    if (!checkResult.rows[0]) {
      return res.status(404).json({ error: 'Airline not found' });
    }

    // Update active_airline_id
    await pool.query('UPDATE users SET active_airline_id = $1 WHERE id = $2', [airlineId, req.userId]);

    const airline = await fetchAirlineById(airlineId);
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
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, airline_code, home_airport_code } = req.body;

      // Check how many airlines this user already has
      const countResult = await pool.query('SELECT COUNT(*) FROM airlines WHERE user_id = $1', [req.userId]);
      const count = parseInt(countResult.rows[0].count);

      if (count >= 3) {
        return res.status(400).json({ error: 'Maximum of 3 airlines per user' });
      }

      // Check if airline code is taken
      const checkCodeResult = await pool.query('SELECT id FROM airlines WHERE airline_code = $1', [airline_code]);
      if (checkCodeResult.rows[0]) {
        return res.status(400).json({ error: 'Airline code already taken' });
      }

      // Verify airport exists
      const checkAirportResult = await pool.query('SELECT iata_code FROM airports WHERE iata_code = $1', [home_airport_code]);
      if (!checkAirportResult.rows[0]) {
        return res.status(400).json({ error: 'Invalid airport code' });
      }

      // Create airline with RETURNING
      const insertResult = await pool.query(
        'INSERT INTO airlines (user_id, name, airline_code, home_airport_code) VALUES ($1, $2, $3, $4) RETURNING id',
        [req.userId, name, airline_code, home_airport_code]
      );
      const newId = insertResult.rows[0].id;

      // Set as active airline
      await pool.query('UPDATE users SET active_airline_id = $1 WHERE id = $2', [newId, req.userId]);

      // Seed ground staff for the home base based on airport category (0 weekly flights at creation)
      const apCatResult = await pool.query('SELECT category FROM airports WHERE iata_code = $1', [home_airport_code]);
      const homeCategory = apCatResult.rows[0]?.category || 4;
      await addGroundStaff(newId, home_airport_code, homeCategory, 'home_base', 0, 0);

      const airline = await fetchAirlineById(newId);

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
router.get('/departures', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.json({ flights: [] });
    const result = await pool.query(`
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
      WHERE f.airline_id = $1 AND f.status IN ('scheduled', 'boarding', 'in-flight')
      ORDER BY f.departure_time ASC
      LIMIT 15
    `, [req.airlineId]);
    const flights = result.rows.map(row => ({
      flight_number: row.flight_number,
      departure_airport: row.departure_airport,
      arrival_airport: row.arrival_airport,
      departure_time: row.departure_time,
      arrival_time: row.arrival_time,
      status: row.status,
      image_filename: row.image_filename,
      aircraft_type: row.model,
      departure_airport_name: row.departure_airport_name,
      arrival_airport_name: row.arrival_airport_name,
      satisfaction_score: row.satisfaction_score,
    }));
    res.json({ flights });
  } catch (error) {
    console.error('Departures error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airline/arrivals — next 10 upcoming arrivals for the active airline
router.get('/arrivals', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.json({ flights: [] });
    const result = await pool.query(`
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
      WHERE f.airline_id = $1 AND f.status IN ('scheduled', 'boarding', 'in-flight')
      ORDER BY f.arrival_time ASC
      LIMIT 15
    `, [req.airlineId]);
    const flights = result.rows.map(row => ({
      flight_number: row.flight_number,
      departure_airport: row.departure_airport,
      arrival_airport: row.arrival_airport,
      departure_time: row.departure_time,
      arrival_time: row.arrival_time,
      status: row.status,
      image_filename: row.image_filename,
      aircraft_type: row.model,
      departure_airport_name: row.departure_airport_name,
      arrival_airport_name: row.arrival_airport_name,
      satisfaction_score: row.satisfaction_score,
    }));
    res.json({ flights });
  } catch (error) {
    console.error('Arrivals error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airline/fleet-summary — aircraft types with counts for the active airline
router.get('/fleet-summary', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.json({ fleet: [] });
    const result = await pool.query(`
      SELECT at.full_name, at.image_filename, COUNT(*) AS count, at.manufacturer
      FROM aircraft ac
      JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      WHERE ac.airline_id = $1
      GROUP BY ac.aircraft_type_id, at.full_name, at.image_filename, at.manufacturer
      ORDER BY at.manufacturer ASC, at.full_name ASC
    `, [req.airlineId]);
    const fleet = result.rows.map(row => ({
      full_name: row.full_name,
      image_filename: row.image_filename,
      count: parseInt(row.count),
      manufacturer: row.manufacturer
    }));
    res.json({ fleet });
  } catch (error) {
    console.error('Fleet summary error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airline/stats — network + financial summary for the dashboard
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.json({ destinations_count: 0, hubs: [], weekly_revenue: 0 });

    // Destinations count — unique airports actively served
    const destResult = await pool.query(`
      SELECT COUNT(*) FROM (
        SELECT ws.departure_airport AS airport
          FROM weekly_schedule ws
          JOIN aircraft ac ON ac.id = ws.aircraft_id
          WHERE ac.airline_id = $1 AND ac.is_active = 1
        UNION
        SELECT ws.arrival_airport AS airport
          FROM weekly_schedule ws
          JOIN aircraft ac ON ac.id = ws.aircraft_id
          WHERE ac.airline_id = $1 AND ac.is_active = 1
      ) sub
    `, [req.airlineId]);
    const destinations_count = parseInt(destResult.rows[0].count);

    // Expansion airports (formerly hubs)
    const hubResult = await pool.query(`
      SELECT e.airport_code, ap.name FROM airport_expansions e
      LEFT JOIN airports ap ON ap.iata_code = e.airport_code
      WHERE e.airline_id = $1 AND e.expansion_level > 0
      ORDER BY e.airport_code
    `, [req.airlineId]);
    const hubs = hubResult.rows.map(r => ({ code: r.airport_code, name: r.name }));

    // Weekly revenue (last 7 days by arrival_time)
    const revResult = await pool.query(`
      SELECT COALESCE(SUM(revenue), 0) FROM flights
      WHERE airline_id = $1 AND status = 'completed'
      AND arrival_time >= NOW() - INTERVAL '7 days'
    `, [req.airlineId]);
    const weekly_revenue = parseFloat(revResult.rows[0].coalesce) || 0;

    const avg_satisfaction = await getAirlineSatisfactionScore(req.airlineId);

    // Daily passengers (completed flights in last 24h)
    const dailyPaxResult = await pool.query(`
      SELECT COALESCE(SUM(seats_sold), 0) FROM flights
      WHERE airline_id = $1 AND status = 'completed'
        AND arrival_time >= NOW() - INTERVAL '1 day'
    `, [req.airlineId]);
    const daily_passengers = parseInt(dailyPaxResult.rows[0].coalesce) || 0;

    // Total passengers (all completed flights)
    const totalPaxResult = await pool.query(`
      SELECT COALESCE(SUM(seats_sold), 0) FROM flights
      WHERE airline_id = $1 AND status = 'completed'
    `, [req.airlineId]);
    const total_passengers = parseInt(totalPaxResult.rows[0].coalesce) || 0;

    res.json({ destinations_count, hubs, weekly_revenue, avg_satisfaction, daily_passengers, total_passengers });
  } catch (error) {
    console.error('Airline stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airline/airports
router.get('/airports', async (req, res) => {
  try {
    const result = await pool.query('SELECT iata_code, name, country FROM airports ORDER BY country, name');
    const airports = result.rows.map(row => ({
      iata_code: row.iata_code,
      name: row.name,
      country: row.country
    }));
    res.json({ airports });
  } catch (error) {
    console.error('Get airports error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id — delete an airline owned by the user
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const airlineId = parseInt(req.params.id);
    if (isNaN(airlineId)) return res.status(400).json({ error: 'Invalid airline ID' });

    const ownResult = await pool.query(
      'SELECT id FROM airlines WHERE id = $1 AND user_id = $2',
      [airlineId, req.userId]
    );
    if (!ownResult.rows[0]) return res.status(404).json({ error: 'Airline not found' });

    await pool.query('DELETE FROM airlines WHERE id = $1 AND user_id = $2', [airlineId, req.userId]);

    res.json({ message: 'Airline deleted' });
  } catch (error) {
    console.error('Delete airline error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/airline/dev/add-points — DEV ONLY, delete before release
router.post('/dev/add-points', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
    const amount = req.body.amount || 10_000;
    await pool.query('UPDATE airlines SET total_points = total_points + $1 WHERE id = $2', [amount, req.airlineId]);
    await checkLevelUpPg(req.airlineId);
    const result = await pool.query('SELECT total_points, level FROM airlines WHERE id = $1', [req.airlineId]);
    const { total_points, level } = result.rows[0];
    res.json({ total_points, level });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/airline/dev/add-money — DEV ONLY, delete before release
router.post('/dev/add-money', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
    const amount = req.body.amount || 10_000_000;
    const result = await pool.query(
      'UPDATE airlines SET balance = balance + $1 WHERE id = $2 RETURNING balance',
      [amount, req.airlineId]
    );
    const new_balance = result.rows[0].balance;
    res.json({ new_balance });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airline/xp — lightweight level + XP poll endpoint
router.get('/xp', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
    await checkLevelUpPg(req.airlineId);
    const result = await pool.query('SELECT level, total_points FROM airlines WHERE id = $1', [req.airlineId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Airline not found' });
    const { level, total_points } = result.rows[0];
    res.json({ level, total_points });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/airline/logo — upload airline logo (480×120px enforced client-side)
router.post('/logo', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(403).json({ error: 'No active airline' });
  logoUpload.single('logo')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
      // Delete old logo from Supabase Storage if present
      const oldResult = await pool.query('SELECT logo_filename FROM airlines WHERE id = $1', [req.airlineId]);
      const oldVal = oldResult.rows[0]?.logo_filename;
      if (oldVal) {
        // logo_filename may be a full URL or just a path
        const oldPath = oldVal.startsWith('http') ? oldVal.split(`/${BUCKET}/`)[1] : oldVal;
        if (oldPath) await supabase.storage.from(BUCKET).remove([oldPath]);
      }

      // Upload new logo to Supabase Storage
      const ext = req.file.mimetype.split('/')[1].replace('svg+xml', 'svg');
      const storagePath = `airline_${req.airlineId}_${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);

      // Store full public URL so frontend can use it directly
      await pool.query('UPDATE airlines SET logo_filename = $1 WHERE id = $2', [publicUrl, req.airlineId]);

      res.json({ logo_filename: publicUrl, logo_url: publicUrl });
    } catch (error) {
      console.error('Logo upload error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });
});

export default router;
