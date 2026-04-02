import express from 'express';
import { getDatabase, saveDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';
import { addGroundStaff } from './personnel.js';

const router = express.Router();

export const DEPARTURES_PER_LEVEL = 100;
const MULTIPLIERS = [1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0];

export function getCostForNextLevel(category, currentLevel) {
  const multiplier = currentLevel >= 9 ? 8.0 : MULTIPLIERS[currentLevel];
  return Math.round(category * multiplier * 1_000_000);
}

function getTotalCostForLevel(category, level) {
  let total = 0;
  for (let i = 0; i < level; i++) {
    const mult = i >= 9 ? 8.0 : MULTIPLIERS[i];
    total += Math.round(category * mult * 1_000_000);
  }
  return total;
}

export function getCurrentWeekStart() {
  const now = new Date();
  const day = now.getUTCDay();
  const daysToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + daysToMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0];
}

// GET /api/expansions
router.get('/', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.json({ expansions: [], week_start: getCurrentWeekStart(), departures_per_level: DEPARTURES_PER_LEVEL });
  try {
    const db = getDatabase();
    const weekStart = getCurrentWeekStart();

    // Get home base (departures from home base don't count toward capacity)
    const homeStmt = db.prepare('SELECT home_airport_code FROM airlines WHERE id = ?');
    homeStmt.bind([req.airlineId]);
    const homeCode = homeStmt.step() ? homeStmt.get()[0] : null;
    homeStmt.free();

    // Real-time usage: count departures FROM expansion airports only when:
    // - departure is NOT home base
    // - arrival is NOT home base
    // - arrival does NOT have its own expansion (Rule 2: exp→exp never counted; Rule 4: dest→exp never counted)
    const usageStmt = db.prepare(`
      SELECT ws.departure_airport, COUNT(*) as cnt
      FROM weekly_schedule ws
      JOIN aircraft ac ON ac.id = ws.aircraft_id
      WHERE ac.airline_id = ? AND ac.is_active = 1
        AND ws.departure_airport != ?
        AND ws.arrival_airport != ?
        AND NOT EXISTS (
          SELECT 1 FROM airport_expansions ae
          WHERE ae.airline_id = ac.airline_id
            AND ae.airport_code = ws.arrival_airport
            AND ae.expansion_level > 0
        )
      GROUP BY ws.departure_airport
    `);
    usageStmt.bind([req.airlineId, homeCode || '', homeCode || '']);
    const usageMap = {};
    while (usageStmt.step()) {
      const r = usageStmt.get();
      usageMap[r[0]] = r[1];
    }
    usageStmt.free();

    const stmt = db.prepare(`
      SELECT e.id, e.airport_code, ap.name, ap.category, e.expansion_level
      FROM airport_expansions e
      LEFT JOIN airports ap ON ap.iata_code = e.airport_code
      WHERE e.airline_id = ? AND e.expansion_level > 0
      ORDER BY e.airport_code
    `);
    stmt.bind([req.airlineId]);

    const expansions = [];
    while (stmt.step()) {
      const r = stmt.get();
      const level = r[4];
      const category = r[3] || 4;
      const capacity = level * DEPARTURES_PER_LEVEL;
      const week_usage = usageMap[r[1]] || 0;
      expansions.push({
        id: r[0], airport_code: r[1], airport_name: r[2],
        category, expansion_level: level,
        week_usage, capacity, week_start: weekStart,
        next_level_cost: getCostForNextLevel(category, level),
        next_level: level + 1,
        total_cost_paid: getTotalCostForLevel(category, level),
        refund_value: Math.floor(getTotalCostForLevel(category, level) / 2),
      });
    }
    stmt.free();

    res.json({ expansions, week_start: weekStart, departures_per_level: DEPARTURES_PER_LEVEL });
  } catch (error) {
    console.error('Get expansions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/expansions/purchase
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

    // Not home base
    const homeStmt = db.prepare('SELECT home_airport_code FROM airlines WHERE id = ?');
    homeStmt.bind([req.airlineId]);
    homeStmt.step();
    const homeCode = homeStmt.get()[0];
    homeStmt.free();
    if (code === homeCode) return res.status(400).json({ error: 'Home Base already has unlimited departures.' });

    // Destination opened
    const destStmt = db.prepare('SELECT id FROM airline_destinations WHERE airline_id = ? AND airport_code = ?');
    destStmt.bind([req.airlineId, code]);
    if (!destStmt.step()) { destStmt.free(); return res.status(400).json({ error: 'Open this destination first.' }); }
    destStmt.free();

    // Get current expansion level
    const expStmt = db.prepare('SELECT id, expansion_level FROM airport_expansions WHERE airline_id = ? AND airport_code = ?');
    expStmt.bind([req.airlineId, code]);
    const hasExpansion = expStmt.step();
    const expRow = hasExpansion ? expStmt.get() : null;
    expStmt.free();

    const currentLevel = expRow ? expRow[1] : 0;
    const isFirstExpansion = currentLevel === 0;
    const cost = getCostForNextLevel(category, currentLevel);

    // Balance check
    const balStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    balStmt.bind([req.airlineId]);
    balStmt.step();
    const balance = balStmt.get()[0];
    balStmt.free();
    if (balance < cost) return res.status(400).json({ error: `Insufficient balance. Level ${currentLevel + 1} costs $${cost.toLocaleString()}.` });

    // Deduct
    const deduct = db.prepare('UPDATE airlines SET balance = balance - ? WHERE id = ?');
    deduct.bind([cost, req.airlineId]);
    deduct.step(); deduct.free();

    // Transaction
    const tx = db.prepare("INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'other', ?, ?)");
    tx.bind([req.airlineId, -cost, `Airport expansion Level ${currentLevel + 1} purchased: ${code}`]);
    tx.step(); tx.free();

    // Upsert expansion record
    if (expRow) {
      const upd = db.prepare('UPDATE airport_expansions SET expansion_level = expansion_level + 1 WHERE id = ?');
      upd.bind([expRow[0]]);
      upd.step(); upd.free();
    } else {
      const ins = db.prepare('INSERT INTO airport_expansions (airline_id, airport_code, expansion_level) VALUES (?, ?, 1)');
      ins.bind([req.airlineId, code]);
      ins.step(); ins.free();
    }

    // First expansion: +20 ground staff bonus
    if (isFirstExpansion) {
      try { addGroundStaff(db, req.airlineId, code, category, true); }
      catch (e) { console.error('Ground staff bonus error:', e); }
    }

    // New balance
    const newBalStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    newBalStmt.bind([req.airlineId]);
    newBalStmt.step();
    const newBalance = newBalStmt.get()[0];
    newBalStmt.free();

    const newLevel = currentLevel + 1;
    saveDatabase();
    res.json({
      message: `Level ${newLevel} expansion purchased at ${code}`,
      new_balance: newBalance,
      expansion_level: newLevel,
      capacity: newLevel * DEPARTURES_PER_LEVEL,
      next_level_cost: getCostForNextLevel(category, newLevel),
    });
  } catch (error) {
    console.error('Purchase expansion error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/expansions/:airport_code — sell hub, refund 50%
router.delete('/:airport_code', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const code = req.params.airport_code.toUpperCase();
    const db = getDatabase();

    // Get expansion record
    const expStmt = db.prepare(`
      SELECT e.id, e.expansion_level, ap.category
      FROM airport_expansions e
      LEFT JOIN airports ap ON ap.iata_code = e.airport_code
      WHERE e.airline_id = ? AND e.airport_code = ?
    `);
    expStmt.bind([req.airlineId, code]);
    if (!expStmt.step()) {
      expStmt.free();
      return res.status(404).json({ error: 'No expansion found at this airport.' });
    }
    const expRow = expStmt.get();
    expStmt.free();
    const expId = expRow[0];
    const level = expRow[1];
    const category = expRow[2] || 4;

    // Get home base for exclusion check
    const homeStmt2 = db.prepare('SELECT home_airport_code FROM airlines WHERE id = ?');
    homeStmt2.bind([req.airlineId]);
    const homeCode2 = homeStmt2.step() ? homeStmt2.get()[0] : '';
    homeStmt2.free();

    // Check: no active flights FROM this airport that REQUIRE this expansion
    // (i.e., to destinations without their own expansion and not home base)
    // Rule 4 / Rule 2: flights to expansion airports don't require origin expansion → don't block
    const activeFlightsStmt = db.prepare(`
      SELECT COUNT(*) FROM weekly_schedule ws
      JOIN aircraft ac ON ac.id = ws.aircraft_id
      WHERE ac.airline_id = ? AND ac.is_active = 1
        AND ws.departure_airport = ?
        AND ws.arrival_airport != ?
        AND NOT EXISTS (
          SELECT 1 FROM airport_expansions ae
          WHERE ae.airline_id = ac.airline_id
            AND ae.airport_code = ws.arrival_airport
            AND ae.expansion_level > 0
        )
    `);
    activeFlightsStmt.bind([req.airlineId, code, homeCode2]);
    activeFlightsStmt.step();
    const activeCount = activeFlightsStmt.get()[0];
    activeFlightsStmt.free();

    if (activeCount > 0) {
      return res.status(400).json({
        error: `Cannot sell hub: ${activeCount} active flight${activeCount !== 1 ? 's' : ''} from ${code} to non-expansion destinations. Ground those aircraft or reroute to expansion airports first.`,
      });
    }

    const totalCost = getTotalCostForLevel(category, level);
    const refund = Math.floor(totalCost / 2);

    // Credit refund
    const creditStmt = db.prepare('UPDATE airlines SET balance = balance + ? WHERE id = ?');
    creditStmt.bind([refund, req.airlineId]);
    creditStmt.step(); creditStmt.free();

    // Transaction record
    const tx = db.prepare("INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'other', ?, ?)");
    tx.bind([req.airlineId, refund, `Hub sold: ${code} (Level ${level}, 50% refund)`]);
    tx.step(); tx.free();

    // Remove expansion record
    const delStmt = db.prepare('DELETE FROM airport_expansions WHERE id = ?');
    delStmt.bind([expId]);
    delStmt.step(); delStmt.free();

    // Clean up expansion_usage records
    const delUsage = db.prepare('DELETE FROM expansion_usage WHERE airline_id = ? AND airport_code = ?');
    delUsage.bind([req.airlineId, code]);
    delUsage.step(); delUsage.free();

    const newBalStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    newBalStmt.bind([req.airlineId]);
    newBalStmt.step();
    const newBalance = newBalStmt.get()[0];
    newBalStmt.free();

    saveDatabase();
    res.json({ message: `Hub at ${code} sold. Refund: $${refund.toLocaleString()}`, new_balance: newBalance, refund });
  } catch (error) {
    console.error('Sell expansion error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
