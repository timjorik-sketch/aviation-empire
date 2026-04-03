import express from 'express';
import pool from '../database/postgres.js';
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
router.get('/', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.json({ expansions: [], week_start: getCurrentWeekStart(), departures_per_level: DEPARTURES_PER_LEVEL });
  try {
    const weekStart = getCurrentWeekStart();

    // Get home base
    const homeResult = await pool.query('SELECT home_airport_code FROM airlines WHERE id = $1', [req.airlineId]);
    const homeCode = homeResult.rows[0] ? homeResult.rows[0].home_airport_code : null;

    // Real-time usage
    const usageResult = await pool.query(`
      SELECT ws.departure_airport, COUNT(*) as cnt
      FROM weekly_schedule ws
      JOIN aircraft ac ON ac.id = ws.aircraft_id
      WHERE ac.airline_id = $1 AND ac.is_active = 1
        AND ws.departure_airport != $2
        AND ws.arrival_airport != $2
        AND NOT EXISTS (
          SELECT 1 FROM airport_expansions ae
          WHERE ae.airline_id = ac.airline_id
            AND ae.airport_code = ws.arrival_airport
            AND ae.expansion_level > 0
        )
      GROUP BY ws.departure_airport
    `, [req.airlineId, homeCode || '']);

    const usageMap = {};
    for (const r of usageResult.rows) {
      usageMap[r.departure_airport] = parseInt(r.cnt);
    }

    const result = await pool.query(`
      SELECT e.id, e.airport_code, ap.name, ap.category, e.expansion_level
      FROM airport_expansions e
      LEFT JOIN airports ap ON ap.iata_code = e.airport_code
      WHERE e.airline_id = $1 AND e.expansion_level > 0
      ORDER BY e.airport_code
    `, [req.airlineId]);

    const expansions = result.rows.map(r => {
      const level = r.expansion_level;
      const category = r.category || 4;
      const capacity = level * DEPARTURES_PER_LEVEL;
      const week_usage = usageMap[r.airport_code] || 0;
      return {
        id: r.id, airport_code: r.airport_code, airport_name: r.name,
        category, expansion_level: level,
        week_usage, capacity, week_start: weekStart,
        next_level_cost: getCostForNextLevel(category, level),
        next_level: level + 1,
        total_cost_paid: getTotalCostForLevel(category, level),
        refund_value: Math.floor(getTotalCostForLevel(category, level) / 2),
      };
    });

    res.json({ expansions, week_start: weekStart, departures_per_level: DEPARTURES_PER_LEVEL });
  } catch (error) {
    console.error('Get expansions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/expansions/purchase
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

    // Not home base
    const homeResult = await pool.query('SELECT home_airport_code FROM airlines WHERE id = $1', [req.airlineId]);
    const homeCode = homeResult.rows[0].home_airport_code;
    if (code === homeCode) return res.status(400).json({ error: 'Home Base already has unlimited departures.' });

    // Destination opened
    const destResult = await pool.query(
      'SELECT id FROM airline_destinations WHERE airline_id = $1 AND airport_code = $2',
      [req.airlineId, code]
    );
    if (!destResult.rows[0]) return res.status(400).json({ error: 'Open this destination first.' });

    // Get current expansion level
    const expResult = await pool.query(
      'SELECT id, expansion_level FROM airport_expansions WHERE airline_id = $1 AND airport_code = $2',
      [req.airlineId, code]
    );
    const expRow = expResult.rows[0] || null;
    const currentLevel = expRow ? expRow.expansion_level : 0;
    const isFirstExpansion = currentLevel === 0;
    const cost = getCostForNextLevel(category, currentLevel);

    // Balance check
    const balResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const balance = balResult.rows[0].balance;
    if (balance < cost) return res.status(400).json({ error: `Insufficient balance. Level ${currentLevel + 1} costs $${cost.toLocaleString()}.` });

    // Deduct
    await pool.query('UPDATE airlines SET balance = balance - $1 WHERE id = $2', [cost, req.airlineId]);

    // Transaction
    await pool.query(
      "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'other', $2, $3)",
      [req.airlineId, -cost, `Airport expansion Level ${currentLevel + 1} purchased: ${code}`]
    );

    // Upsert expansion record
    if (expRow) {
      await pool.query(
        'UPDATE airport_expansions SET expansion_level = expansion_level + 1 WHERE id = $1',
        [expRow.id]
      );
    } else {
      await pool.query(
        'INSERT INTO airport_expansions (airline_id, airport_code, expansion_level) VALUES ($1, $2, 1)',
        [req.airlineId, code]
      );
    }

    // First expansion: +20 ground staff bonus
    if (isFirstExpansion) {
      try { await addGroundStaff(req.airlineId, code, category, true); }
      catch (e) { console.error('Ground staff bonus error:', e); }
    }

    // New balance
    const newBalResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const newBalance = newBalResult.rows[0].balance;

    const newLevel = currentLevel + 1;
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
router.delete('/:airport_code', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const code = req.params.airport_code.toUpperCase();

    // Get expansion record
    const expResult = await pool.query(`
      SELECT e.id, e.expansion_level, ap.category
      FROM airport_expansions e
      LEFT JOIN airports ap ON ap.iata_code = e.airport_code
      WHERE e.airline_id = $1 AND e.airport_code = $2
    `, [req.airlineId, code]);
    if (!expResult.rows[0]) {
      return res.status(404).json({ error: 'No expansion found at this airport.' });
    }
    const expRow = expResult.rows[0];
    const expId = expRow.id;
    const level = expRow.expansion_level;
    const category = expRow.category || 4;

    // Get home base for exclusion check
    const homeResult = await pool.query('SELECT home_airport_code FROM airlines WHERE id = $1', [req.airlineId]);
    const homeCode2 = homeResult.rows[0] ? homeResult.rows[0].home_airport_code : '';

    // Check: no active flights FROM this airport that REQUIRE this expansion
    const activeFlightsResult = await pool.query(`
      SELECT COUNT(*) FROM weekly_schedule ws
      JOIN aircraft ac ON ac.id = ws.aircraft_id
      WHERE ac.airline_id = $1 AND ac.is_active = 1
        AND ws.departure_airport = $2
        AND ws.arrival_airport != $3
        AND NOT EXISTS (
          SELECT 1 FROM airport_expansions ae
          WHERE ae.airline_id = ac.airline_id
            AND ae.airport_code = ws.arrival_airport
            AND ae.expansion_level > 0
        )
    `, [req.airlineId, code, homeCode2]);
    const activeCount = parseInt(activeFlightsResult.rows[0].count);

    if (activeCount > 0) {
      return res.status(400).json({
        error: `Cannot sell hub: ${activeCount} active flight${activeCount !== 1 ? 's' : ''} from ${code} to non-expansion destinations. Ground those aircraft or reroute to expansion airports first.`,
      });
    }

    const totalCost = getTotalCostForLevel(category, level);
    const refund = Math.floor(totalCost / 2);

    // Credit refund
    await pool.query('UPDATE airlines SET balance = balance + $1 WHERE id = $2', [refund, req.airlineId]);

    // Transaction record
    await pool.query(
      "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'other', $2, $3)",
      [req.airlineId, refund, `Hub sold: ${code} (Level ${level}, 50% refund)`]
    );

    // Remove expansion record
    await pool.query('DELETE FROM airport_expansions WHERE id = $1', [expId]);

    // Clean up expansion_usage records
    await pool.query(
      'DELETE FROM expansion_usage WHERE airline_id = $1 AND airport_code = $2',
      [req.airlineId, code]
    );

    const newBalResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const newBalance = newBalResult.rows[0].balance;

    res.json({ message: `Hub at ${code} sold. Refund: $${refund.toLocaleString()}`, new_balance: newBalance, refund });
  } catch (error) {
    console.error('Sell expansion error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
