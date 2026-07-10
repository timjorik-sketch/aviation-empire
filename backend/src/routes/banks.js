import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// A "bank" is a reusable hub wave: an arrival window and a departure window at a
// hub airport, so the planner can align a long-haul aircraft's departures and
// return arrivals onto the hub's wave structure. All four times are stored as
// minutes-since-midnight (0..1439) in the hub's local schedule clock.

function clampMin(v) {
  const n = parseInt(v);
  if (isNaN(n)) return null;
  return Math.max(0, Math.min(1439, n));
}

function validateBank(body) {
  const name = (body.name || '').trim();
  if (!name) return { error: 'Bank name is required' };
  const hub = (body.hub_airport_code || '').trim().toUpperCase();
  if (!hub) return { error: 'Hub airport is required' };

  const ea = clampMin(body.earliest_arrival);
  const la = clampMin(body.latest_arrival);
  const ed = clampMin(body.earliest_departure);
  const ld = clampMin(body.latest_departure);
  if (ea === null || la === null || ed === null || ld === null) {
    return { error: 'All four times (earliest/latest arrival & departure) are required as minutes 0–1439' };
  }
  if (la < ea) return { error: 'Latest arrival must be ≥ earliest arrival' };
  if (ld < ed) return { error: 'Latest departure must be ≥ earliest departure' };

  return {
    value: {
      name, hub_airport_code: hub,
      earliest_arrival: ea, latest_arrival: la,
      earliest_departure: ed, latest_departure: ld,
    },
  };
}

// ── GET /api/banks ────────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.json({ banks: [] });
    const result = await pool.query(
      `SELECT id, name, hub_airport_code, earliest_arrival, latest_arrival,
              earliest_departure, latest_departure, created_at
       FROM airline_banks WHERE airline_id = $1
       ORDER BY hub_airport_code, earliest_arrival, created_at`,
      [req.airlineId]
    );
    res.json({ banks: result.rows });
  } catch (error) {
    console.error('Get banks error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/banks ───────────────────────────────────────────────────────────
router.post('/', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
    const v = validateBank(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const b = v.value;

    const result = await pool.query(
      `INSERT INTO airline_banks
        (airline_id, name, hub_airport_code, earliest_arrival, latest_arrival, earliest_departure, latest_departure)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.airlineId, b.name, b.hub_airport_code, b.earliest_arrival, b.latest_arrival, b.earliest_departure, b.latest_departure]
    );
    res.status(201).json({ message: 'Bank created', id: result.rows[0].id });
  } catch (error) {
    console.error('Create bank error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PUT /api/banks/:id ────────────────────────────────────────────────────────
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const check = await pool.query('SELECT id FROM airline_banks WHERE id = $1 AND airline_id = $2', [id, req.airlineId]);
    if (!check.rows[0]) return res.status(404).json({ error: 'Bank not found' });

    const v = validateBank(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const b = v.value;

    await pool.query(
      `UPDATE airline_banks SET name = $1, hub_airport_code = $2,
        earliest_arrival = $3, latest_arrival = $4, earliest_departure = $5, latest_departure = $6
       WHERE id = $7`,
      [b.name, b.hub_airport_code, b.earliest_arrival, b.latest_arrival, b.earliest_departure, b.latest_departure, id]
    );
    res.json({ message: 'Bank updated' });
  } catch (error) {
    console.error('Update bank error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/banks/:id ─────────────────────────────────────────────────────
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const check = await pool.query('SELECT id FROM airline_banks WHERE id = $1 AND airline_id = $2', [id, req.airlineId]);
    if (!check.rows[0]) return res.status(404).json({ error: 'Bank not found' });
    await pool.query('DELETE FROM airline_banks WHERE id = $1', [id]);
    res.json({ message: 'Bank deleted' });
  } catch (error) {
    console.error('Delete bank error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
