import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

export const DEPARTURES_PER_SLOT = 100;
const COST_PER_CATEGORY_POINT = 1_000_000;

export function getCurrentWeekStart() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon..6=Sat
  const daysToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + daysToMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0]; // YYYY-MM-DD
}

export function getNextMondayISO(weekStart) {
  const d = new Date(weekStart + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().split('T')[0];
}

// GET /api/airport-slots
router.get('/', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.json({ slots: [], week_start: getCurrentWeekStart(), departures_per_slot: DEPARTURES_PER_SLOT });
  try {
    const weekStart = getCurrentWeekStart();

    const result = await pool.query(`
      SELECT s.id, s.airport_code, ap.name, s.category, s.slots_count, s.cost_per_slot,
             COALESCE((
               SELECT su.departures_used FROM slot_usage su
               WHERE su.airline_id = s.airline_id AND su.airport_code = s.airport_code AND su.week_start = $1
             ), 0) AS week_usage
      FROM airport_slots s
      LEFT JOIN airports ap ON ap.iata_code = s.airport_code
      WHERE s.airline_id = $2
      ORDER BY s.airport_code
    `, [weekStart, req.airlineId]);

    const slots = result.rows.map(r => {
      const capacity = r.slots_count * DEPARTURES_PER_SLOT;
      return {
        id: r.id, airport_code: r.airport_code, airport_name: r.name,
        category: r.category, slots_count: r.slots_count, cost_per_slot: r.cost_per_slot,
        week_usage: parseInt(r.week_usage), capacity, week_start: weekStart,
      };
    });

    res.json({ slots, week_start: weekStart, departures_per_slot: DEPARTURES_PER_SLOT });
  } catch (error) {
    console.error('Get airport slots error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/airport-slots/purchase
router.post('/purchase', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const { airport_code } = req.body;
    if (!airport_code) return res.status(400).json({ error: 'airport_code required' });
    const code = airport_code.toUpperCase();

    // Airport exists + category
    const apResult = await pool.query('SELECT category FROM airports WHERE iata_code = $1', [code]);
    if (!apResult.rows[0]) return res.status(404).json({ error: 'Airport not found.' });
    const category = apResult.rows[0].category || 4;

    // Destination opened
    const destResult = await pool.query(
      'SELECT id FROM airline_destinations WHERE airline_id = $1 AND airport_code = $2',
      [req.airlineId, code]
    );
    if (!destResult.rows[0]) return res.status(400).json({ error: 'Open this destination first.' });

    const cost = category * COST_PER_CATEGORY_POINT;

    // Balance
    const balResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const balance = balResult.rows[0].balance;
    if (balance < cost) return res.status(400).json({ error: `Insufficient balance. One slot here costs $${cost.toLocaleString()}.` });

    // Deduct
    await pool.query('UPDATE airlines SET balance = balance - $1 WHERE id = $2', [cost, req.airlineId]);

    // Transaction
    await pool.query(
      "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'other', $2, $3)",
      [req.airlineId, -cost, `Airport slot purchased: ${code}`]
    );

    // Upsert slot
    const existResult = await pool.query(
      'SELECT id FROM airport_slots WHERE airline_id = $1 AND airport_code = $2',
      [req.airlineId, code]
    );
    if (existResult.rows[0]) {
      const slotId = existResult.rows[0].id;
      await pool.query(
        'UPDATE airport_slots SET slots_count = slots_count + 1, cost_per_slot = $1 WHERE id = $2',
        [cost, slotId]
      );
    } else {
      await pool.query(
        'INSERT INTO airport_slots (airline_id, airport_code, category, slots_count, cost_per_slot) VALUES ($1, $2, $3, 1, $4)',
        [req.airlineId, code, category, cost]
      );
    }

    // New balance
    const newBalResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const newBalance = newBalResult.rows[0].balance;

    res.json({ message: `Slot purchased at ${code}`, new_balance: newBalance });
  } catch (error) {
    console.error('Purchase airport slot error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airport-slots/usage/:airport_code
router.get('/usage/:airport_code', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const code = req.params.airport_code.toUpperCase();
    const weekStart = getCurrentWeekStart();

    const slotResult = await pool.query(
      'SELECT slots_count, category FROM airport_slots WHERE airline_id = $1 AND airport_code = $2',
      [req.airlineId, code]
    );
    if (!slotResult.rows[0]) {
      return res.json({ has_slots: false, capacity: 0, week_usage: 0, week_start: weekStart });
    }
    const slotRow = slotResult.rows[0];
    const capacity = slotRow.slots_count * DEPARTURES_PER_SLOT;

    const usageResult = await pool.query(
      'SELECT departures_used FROM slot_usage WHERE airline_id = $1 AND airport_code = $2 AND week_start = $3',
      [req.airlineId, code, weekStart]
    );
    const weekUsage = usageResult.rows[0] ? parseInt(usageResult.rows[0].departures_used) : 0;

    res.json({ has_slots: true, slots_count: slotRow.slots_count, capacity, week_usage: weekUsage, week_start: weekStart });
  } catch (error) {
    console.error('Slot usage error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
