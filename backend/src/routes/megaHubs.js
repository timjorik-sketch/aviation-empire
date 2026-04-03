import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

const MAX_MEGA_HUBS = 5;
const HUB_BASE_COSTS = [2_000_000, 2_500_000, 3_000_000, 3_500_000, 4_000_000];
const DEPARTURES_PER_SLOT = 100;

export function calculateHubCost(hubNumber, category) {
  return category * HUB_BASE_COSTS[hubNumber - 1];
}

// GET /api/mega-hubs
router.get('/', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.json({ mega_hubs: [], home_base: null, next_hub_number: 1, max_hubs: MAX_MEGA_HUBS });
  try {
    // Home base info
    const homeResult = await pool.query(`
      SELECT a.home_airport_code, ap.name, ap.category
      FROM airlines a LEFT JOIN airports ap ON ap.iata_code = a.home_airport_code
      WHERE a.id = $1
    `, [req.airlineId]);

    let homeBase = null;
    if (homeResult.rows[0]) {
      const r = homeResult.rows[0];
      homeBase = { airport_code: r.home_airport_code, airport_name: r.name, category: r.category };
    }

    // Purchased mega hubs
    const result = await pool.query(`
      SELECT mh.id, mh.airport_code, ap.name, mh.hub_number, mh.category, mh.cost, mh.purchased_at
      FROM mega_hubs mh LEFT JOIN airports ap ON ap.iata_code = mh.airport_code
      WHERE mh.airline_id = $1
      ORDER BY mh.hub_number
    `, [req.airlineId]);

    const mega_hubs = result.rows.map(r => ({
      id: r.id, airport_code: r.airport_code, airport_name: r.name,
      hub_number: r.hub_number, category: r.category, cost: r.cost, purchased_at: r.purchased_at,
    }));

    const nextHubNumber = mega_hubs.length + 1;
    res.json({ mega_hubs, home_base: homeBase, next_hub_number: nextHubNumber, max_hubs: MAX_MEGA_HUBS });
  } catch (error) {
    console.error('Get mega hubs error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/mega-hubs/purchase
router.post('/purchase', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const { airport_code } = req.body;
    if (!airport_code) return res.status(400).json({ error: 'airport_code required' });
    const code = airport_code.toUpperCase();

    // Not home base
    const homeResult = await pool.query('SELECT home_airport_code FROM airlines WHERE id = $1', [req.airlineId]);
    const homeCode = homeResult.rows[0].home_airport_code;
    if (homeCode === code) return res.status(400).json({ error: 'Home Base already has Hub privileges.' });

    // Not already a mega hub
    const existResult = await pool.query(
      'SELECT id FROM mega_hubs WHERE airline_id = $1 AND airport_code = $2',
      [req.airlineId, code]
    );
    if (existResult.rows[0]) return res.status(400).json({ error: 'Already a Mega Hub.' });

    // Destination must be opened
    const destResult = await pool.query(
      'SELECT id FROM airline_destinations WHERE airline_id = $1 AND airport_code = $2',
      [req.airlineId, code]
    );
    if (!destResult.rows[0]) return res.status(400).json({ error: 'Open this destination first.' });

    // Count existing mega hubs
    const countResult = await pool.query('SELECT COUNT(*) FROM mega_hubs WHERE airline_id = $1', [req.airlineId]);
    const currentCount = parseInt(countResult.rows[0].count);
    if (currentCount >= MAX_MEGA_HUBS) return res.status(400).json({ error: `Maximum ${MAX_MEGA_HUBS} Mega Hubs allowed.` });

    const hubNumber = currentCount + 1;

    // Airport category
    const apResult = await pool.query('SELECT category FROM airports WHERE iata_code = $1', [code]);
    if (!apResult.rows[0]) return res.status(404).json({ error: 'Airport not found.' });
    const category = apResult.rows[0].category || 4;

    const cost = calculateHubCost(hubNumber, category);

    // Balance check
    const balResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const balance = balResult.rows[0].balance;
    if (balance < cost) return res.status(400).json({ error: `Insufficient balance. This Mega Hub costs $${cost.toLocaleString()}.` });

    // Deduct
    await pool.query('UPDATE airlines SET balance = balance - $1 WHERE id = $2', [cost, req.airlineId]);

    // Transaction
    await pool.query(
      "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'other', $2, $3)",
      [req.airlineId, -cost, `Mega Hub #${hubNumber} purchased: ${code}`]
    );

    // Insert
    await pool.query(
      'INSERT INTO mega_hubs (airline_id, airport_code, hub_number, category, cost) VALUES ($1, $2, $3, $4, $5)',
      [req.airlineId, code, hubNumber, category, cost]
    );

    // New balance
    const newBalResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const newBalance = newBalResult.rows[0].balance;

    res.json({ message: `${code} is now Mega Hub #${hubNumber}`, new_balance: newBalance });
  } catch (error) {
    console.error('Purchase mega hub error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/mega-hubs/cost-preview?airport_code=XXX
router.get('/cost-preview', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const code = (req.query.airport_code || '').toUpperCase();
    if (!code) return res.status(400).json({ error: 'airport_code required' });

    const apResult = await pool.query('SELECT category FROM airports WHERE iata_code = $1', [code]);
    if (!apResult.rows[0]) return res.status(404).json({ error: 'Airport not found.' });
    const category = apResult.rows[0].category || 4;

    const countResult = await pool.query('SELECT COUNT(*) FROM mega_hubs WHERE airline_id = $1', [req.airlineId]);
    const currentCount = parseInt(countResult.rows[0].count);

    const hubNumber = currentCount + 1;
    if (hubNumber > MAX_MEGA_HUBS) return res.json({ hub_number: hubNumber, cost: null, max_reached: true });

    const cost = calculateHubCost(hubNumber, category);
    res.json({ hub_number: hubNumber, category, cost, max_reached: false });
  } catch (error) {
    console.error('Hub cost preview error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
