import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';
import { addGroundStaff } from './personnel.js';

const router = express.Router();

const OPEN_COST  = 50_000;
const HUB_COST   = 10_000_000;
const HUB_THRESHOLD = 600; // weekly schedule entries

// Ensure home base destination exists (lazy init)
async function ensureHomeBase(airlineId) {
  const s = await pool.query('SELECT home_airport_code FROM airlines WHERE id = $1', [airlineId]);
  if (!s.rows[0]) return;
  const homeCode = s.rows[0].home_airport_code;

  const c = await pool.query(
    'SELECT id FROM airline_destinations WHERE airline_id = $1 AND airport_code = $2',
    [airlineId, homeCode]
  );
  if (!c.rows[0]) {
    await pool.query(
      'INSERT INTO airline_destinations (airline_id, airport_code, destination_type) VALUES ($1, $2, $3)',
      [airlineId, homeCode, 'home_base']
    );
  }
}

function effectiveType(destType, weeklyFlights) {
  if (destType === 'destination' && weeklyFlights >= HUB_THRESHOLD) return 'base';
  return destType;
}

// GET /api/destinations
router.get('/', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.json({ destinations: [] });
  try {
    await ensureHomeBase(req.airlineId);

    const result = await pool.query(`
      SELECT d.id, d.airport_code, d.destination_type, d.opened_at,
             ap.name, ap.country, ap.continent, ap.category,
             (SELECT COUNT(*) FROM weekly_schedule ws
              JOIN aircraft ac ON ws.aircraft_id = ac.id
              WHERE ac.airline_id = d.airline_id
              AND (ws.departure_airport = d.airport_code OR ws.arrival_airport = d.airport_code)
             ) AS weekly_flights,
             COALESCE((SELECT p.count FROM personnel p
              WHERE p.airline_id = d.airline_id AND p.staff_type = 'ground' AND p.airport_code = d.airport_code
             ), 0) AS ground_staff,
             CASE WHEN EXISTS (
               SELECT 1 FROM airport_expansions ae
               WHERE ae.airline_id = d.airline_id AND ae.airport_code = d.airport_code AND ae.expansion_level > 0
             ) THEN 1 ELSE 0 END AS has_expansion
      FROM airline_destinations d
      JOIN airports ap ON d.airport_code = ap.iata_code
      WHERE d.airline_id = $1
      ORDER BY
        CASE d.destination_type
          WHEN 'home_base'      THEN 0
          WHEN 'hub'            THEN 1
          WHEN 'hub_restricted' THEN 2
          ELSE 3
        END, ap.name ASC
    `, [req.airlineId]);

    const destinations = result.rows.map(r => {
      const wf = parseInt(r.weekly_flights) || 0;
      const dtype = r.destination_type;
      const hasExpansion = r.has_expansion === 1 || r.has_expansion === true;
      const groundStaff = dtype === 'home_base' ? 30 : parseInt(r.ground_staff) || 0;
      const displayType = dtype === 'home_base' ? 'home_base'
        : hasExpansion ? 'hub_restricted'
        : dtype;
      return {
        id: r.id, airport_code: r.airport_code, destination_type: dtype,
        display_type: displayType,
        effective_type: effectiveType(displayType, wf),
        opened_at: r.opened_at, airport_name: r.name, country: r.country,
        continent: r.continent, category: r.category, weekly_flights: wf,
        ground_staff: groundStaff, has_expansion: hasExpansion
      };
    });
    res.json({ destinations });
  } catch (error) {
    console.error('Get destinations error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/destinations/opened — all opened airports (for home base selection dropdowns)
router.get('/opened', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.json({ airports: [] });
  try {
    await ensureHomeBase(req.airlineId);

    const result = await pool.query(`
      SELECT ap.iata_code, ap.name, ap.country, d.destination_type
      FROM airline_destinations d
      JOIN airports ap ON d.airport_code = ap.iata_code
      WHERE d.airline_id = $1
      ORDER BY ap.country, ap.name
    `, [req.airlineId]);

    const airports = result.rows.map(r => ({
      iata_code: r.iata_code, name: r.name, country: r.country, destination_type: r.destination_type
    }));
    res.json({ airports });
  } catch (error) {
    console.error('Get opened destinations error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/destinations/available
router.get('/available', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.json({ airports: [] });
  try {
    const result = await pool.query(`
      SELECT ap.iata_code, ap.name, ap.country, ap.continent, ap.category
      FROM airports ap
      WHERE ap.iata_code NOT IN (
        SELECT airport_code FROM airline_destinations WHERE airline_id = $1
      )
      ORDER BY ap.continent, ap.country, ap.name
    `, [req.airlineId]);
    const airports = result.rows.map(r => ({
      iata_code: r.iata_code, name: r.name, country: r.country,
      continent: r.continent, category: r.category
    }));
    res.json({ airports });
  } catch (error) {
    console.error('Get available destinations error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/destinations/open — open a destination for $50,000
router.post('/open', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const { airport_code, destination_type = 'destination' } = req.body;
    if (!airport_code) return res.status(400).json({ error: 'airport_code required' });
    const code = airport_code.toUpperCase();
    const validTypes = ['home_base', 'hub', 'base', 'destination'];
    const type = validTypes.includes(destination_type) ? destination_type : 'destination';

    // Verify airport
    const apResult = await pool.query('SELECT iata_code FROM airports WHERE iata_code = $1', [code]);
    if (!apResult.rows[0]) return res.status(404).json({ error: 'Airport not found' });

    // Check not already opened
    const chkResult = await pool.query(
      'SELECT id FROM airline_destinations WHERE airline_id = $1 AND airport_code = $2',
      [req.airlineId, code]
    );
    if (chkResult.rows[0]) return res.status(400).json({ error: 'Destination already opened' });

    // Check balance
    const balResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const balance = balResult.rows[0].balance;

    if (balance < OPEN_COST) {
      return res.status(400).json({ error: `Insufficient balance. Opening a destination costs $${OPEN_COST.toLocaleString()}.` });
    }

    // Deduct cost
    await pool.query('UPDATE airlines SET balance = balance - $1 WHERE id = $2', [OPEN_COST, req.airlineId]);

    // Record transaction
    await pool.query(
      "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'other', $2, $3)",
      [req.airlineId, -OPEN_COST, `Opened destination: ${code}`]
    );

    // Insert destination
    await pool.query(
      'INSERT INTO airline_destinations (airline_id, airport_code, destination_type) VALUES ($1, $2, $3)',
      [req.airlineId, code, type]
    );

    // Auto-hire ground staff
    try {
      const apCatResult = await pool.query('SELECT category FROM airports WHERE iata_code = $1', [code]);
      if (apCatResult.rows[0]) {
        const category = apCatResult.rows[0].category;
        await addGroundStaff(req.airlineId, code, category || 4, false);
      }
    } catch (e) { console.error('Ground staff auto-hire error:', e); }

    // Get new balance
    const newBalResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const newBalance = newBalResult.rows[0].balance;

    res.status(201).json({ message: 'Destination opened successfully', new_balance: newBalance });
  } catch (error) {
    console.error('Open destination error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/destinations/upgrade-hub — upgrade destination to Hub for $10,000,000
router.post('/upgrade-hub', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const { airport_code } = req.body;
    if (!airport_code) return res.status(400).json({ error: 'airport_code required' });
    const code = airport_code.toUpperCase();

    // Find current destination entry
    const destResult = await pool.query(
      'SELECT id, destination_type FROM airline_destinations WHERE airline_id = $1 AND airport_code = $2',
      [req.airlineId, code]
    );
    if (!destResult.rows[0]) {
      return res.status(404).json({ error: 'Destination not found. Open it first.' });
    }
    const destId = destResult.rows[0].id;
    const currentType = destResult.rows[0].destination_type;

    if (currentType === 'home_base') {
      return res.status(400).json({ error: 'Home Base already has Hub privileges.' });
    }
    if (currentType === 'hub') {
      return res.status(400).json({ error: 'Already a Hub.' });
    }

    // Check balance
    const balResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const balance = balResult.rows[0].balance;

    if (balance < HUB_COST) {
      return res.status(400).json({ error: `Insufficient balance. Hub upgrade costs $${HUB_COST.toLocaleString()}.` });
    }

    // Deduct cost
    await pool.query('UPDATE airlines SET balance = balance - $1 WHERE id = $2', [HUB_COST, req.airlineId]);

    // Record transaction
    await pool.query(
      "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'other', $2, $3)",
      [req.airlineId, -HUB_COST, `Upgraded to Hub: ${code}`]
    );

    // Upgrade
    await pool.query('UPDATE airline_destinations SET destination_type = $1 WHERE id = $2', ['hub', destId]);

    // Add hub bonus ground staff
    try {
      const apCatResult = await pool.query('SELECT category FROM airports WHERE iata_code = $1', [code]);
      if (apCatResult.rows[0]) {
        const category = apCatResult.rows[0].category;
        await addGroundStaff(req.airlineId, code, category || 4, true);
      }
    } catch (e) { console.error('Hub ground staff error:', e); }

    // Get new balance
    const newBalResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const newBalance = newBalResult.rows[0].balance;

    res.json({ message: `${code} upgraded to Hub`, new_balance: newBalance });
  } catch (error) {
    console.error('Upgrade hub error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/destinations/:code — close/remove a destination
router.delete('/:code', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const code = req.params.code.toUpperCase();

    // Find destination
    const destResult = await pool.query(
      'SELECT id, destination_type FROM airline_destinations WHERE airline_id = $1 AND airport_code = $2',
      [req.airlineId, code]
    );
    if (!destResult.rows[0]) {
      return res.status(404).json({ error: 'Destination not found' });
    }
    const destId = destResult.rows[0].id;
    const destType = destResult.rows[0].destination_type;

    if (destType === 'home_base') {
      return res.status(400).json({ error: 'Cannot close your Home Base.' });
    }

    // Block deletion if any routes use this airport
    const routeResult = await pool.query(`
      SELECT flight_number FROM routes
      WHERE airline_id = $1 AND (departure_airport = $2 OR arrival_airport = $2)
      ORDER BY flight_number
    `, [req.airlineId, code]);

    const activeRoutes = routeResult.rows.map(r => r.flight_number);

    if (activeRoutes.length > 0) {
      return res.status(400).json({
        error: `Cannot close ${code}: active routes use this airport (${activeRoutes.join(', ')}). Delete those routes first.`
      });
    }

    // Delete
    await pool.query('DELETE FROM airline_destinations WHERE id = $1', [destId]);

    res.json({ message: `Destination ${code} closed` });
  } catch (error) {
    console.error('Delete destination error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
