import express from 'express';
import { getDatabase, saveDatabase } from '../database/db.js';
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
router.get('/', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.json({ slots: [], week_start: getCurrentWeekStart(), departures_per_slot: DEPARTURES_PER_SLOT });
  try {
    const db = getDatabase();
    const weekStart = getCurrentWeekStart();

    const stmt = db.prepare(`
      SELECT s.id, s.airport_code, ap.name, s.category, s.slots_count, s.cost_per_slot,
             COALESCE((
               SELECT su.departures_used FROM slot_usage su
               WHERE su.airline_id = s.airline_id AND su.airport_code = s.airport_code AND su.week_start = ?
             ), 0) AS week_usage
      FROM airport_slots s
      LEFT JOIN airports ap ON ap.iata_code = s.airport_code
      WHERE s.airline_id = ?
      ORDER BY s.airport_code
    `);
    stmt.bind([weekStart, req.airlineId]);

    const slots = [];
    while (stmt.step()) {
      const r = stmt.get();
      const capacity = r[4] * DEPARTURES_PER_SLOT;
      slots.push({
        id: r[0], airport_code: r[1], airport_name: r[2],
        category: r[3], slots_count: r[4], cost_per_slot: r[5],
        week_usage: r[6], capacity, week_start: weekStart,
      });
    }
    stmt.free();

    res.json({ slots, week_start: weekStart, departures_per_slot: DEPARTURES_PER_SLOT });
  } catch (error) {
    console.error('Get airport slots error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/airport-slots/purchase
router.post('/purchase', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const { airport_code } = req.body;
    if (!airport_code) return res.status(400).json({ error: 'airport_code required' });
    const code = airport_code.toUpperCase();
    const db = getDatabase();

    // Airport exists + category
    const apStmt = db.prepare('SELECT category FROM airports WHERE iata_code = ?');
    apStmt.bind([code]);
    if (!apStmt.step()) { apStmt.free(); return res.status(404).json({ error: 'Airport not found.' }); }
    const category = apStmt.get()[0] || 4;
    apStmt.free();

    // Destination opened
    const destStmt = db.prepare('SELECT id FROM airline_destinations WHERE airline_id = ? AND airport_code = ?');
    destStmt.bind([req.airlineId, code]);
    if (!destStmt.step()) { destStmt.free(); return res.status(400).json({ error: 'Open this destination first.' }); }
    destStmt.free();

    const cost = category * COST_PER_CATEGORY_POINT;

    // Balance
    const balStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    balStmt.bind([req.airlineId]);
    balStmt.step();
    const balance = balStmt.get()[0];
    balStmt.free();
    if (balance < cost) return res.status(400).json({ error: `Insufficient balance. One slot here costs $${cost.toLocaleString()}.` });

    // Deduct
    const deduct = db.prepare('UPDATE airlines SET balance = balance - ? WHERE id = ?');
    deduct.bind([cost, req.airlineId]);
    deduct.step(); deduct.free();

    // Transaction
    const tx = db.prepare("INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'other', ?, ?)");
    tx.bind([req.airlineId, -cost, `Airport slot purchased: ${code}`]);
    tx.step(); tx.free();

    // Upsert slot
    const existStmt = db.prepare('SELECT id FROM airport_slots WHERE airline_id = ? AND airport_code = ?');
    existStmt.bind([req.airlineId, code]);
    const isFirstSlot = !existStmt.step();
    if (!isFirstSlot) {
      const slotId = existStmt.get()[0];
      existStmt.free();
      const upd = db.prepare('UPDATE airport_slots SET slots_count = slots_count + 1, cost_per_slot = ? WHERE id = ?');
      upd.bind([cost, slotId]);
      upd.step(); upd.free();
    } else {
      existStmt.free();
      const ins = db.prepare('INSERT INTO airport_slots (airline_id, airport_code, category, slots_count, cost_per_slot) VALUES (?, ?, ?, 1, ?)');
      ins.bind([req.airlineId, code, category, cost]);
      ins.step(); ins.free();
    }

    // New balance
    const newBalStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    newBalStmt.bind([req.airlineId]);
    newBalStmt.step();
    const newBalance = newBalStmt.get()[0];
    newBalStmt.free();

    saveDatabase();
    res.json({ message: `Slot purchased at ${code}`, new_balance: newBalance });
  } catch (error) {
    console.error('Purchase airport slot error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/airport-slots/usage/:airport_code
router.get('/usage/:airport_code', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const code = req.params.airport_code.toUpperCase();
    const db = getDatabase();
    const weekStart = getCurrentWeekStart();

    const slotStmt = db.prepare('SELECT slots_count, category FROM airport_slots WHERE airline_id = ? AND airport_code = ?');
    slotStmt.bind([req.airlineId, code]);
    if (!slotStmt.step()) {
      slotStmt.free();
      return res.json({ has_slots: false, capacity: 0, week_usage: 0, week_start: weekStart });
    }
    const slotRow = slotStmt.get();
    slotStmt.free();
    const capacity = slotRow[0] * DEPARTURES_PER_SLOT;

    const usageStmt = db.prepare('SELECT departures_used FROM slot_usage WHERE airline_id = ? AND airport_code = ? AND week_start = ?');
    usageStmt.bind([req.airlineId, code, weekStart]);
    const weekUsage = usageStmt.step() ? usageStmt.get()[0] : 0;
    usageStmt.free();

    res.json({ has_slots: true, slots_count: slotRow[0], capacity, week_usage: weekUsage, week_start: weekStart });
  } catch (error) {
    console.error('Slot usage error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
