// Operations Control Center (OCC) routes — player-facing config + weekly report.
// All four contracts (wet lease, hotel partnership, maintenance program,
// ground handling level) are airline-wide single settings. The maintenance
// cost still scales with fleet size, and ground handling cost still scales
// with hub count — but the LEVEL is one choice for the whole airline.
import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';
import {
  MAINTENANCE_PROGRAMS,
  GROUND_HANDLING_LEVELS,
  WET_LEASE_CONTRACTS,
  HOTEL_PARTNERSHIPS,
  getAirlineHubCodes,
} from '../utils/delaySystem.js';

const router = express.Router();

// GET /api/occ — full configuration for the active airline
router.get('/', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const airlineRes = await pool.query(
      `SELECT id, wet_lease_contract, hotel_partnership,
              maintenance_program, ground_handling_level
       FROM airlines WHERE id = $1`,
      [req.airlineId]
    );
    const airline = airlineRes.rows[0];
    if (!airline) return res.status(404).json({ error: 'Airline not found' });

    const fleetCountRes = await pool.query(
      'SELECT COUNT(*)::int AS n FROM aircraft WHERE airline_id = $1',
      [req.airlineId]
    );
    const fleetCount = fleetCountRes.rows[0]?.n || 0;

    const hubCount = (await getAirlineHubCodes(req.airlineId)).size;

    res.json({
      wet_lease_contract:    airline.wet_lease_contract    || 'none',
      hotel_partnership:     airline.hotel_partnership     || 'none',
      maintenance_program:   airline.maintenance_program   || 'basic',
      ground_handling_level: airline.ground_handling_level || 'standard',
      fleet_count: fleetCount,
      hub_count:   hubCount,
      catalog: {
        maintenance_programs:   MAINTENANCE_PROGRAMS,
        ground_handling_levels: GROUND_HANDLING_LEVELS,
        wet_lease_contracts:    WET_LEASE_CONTRACTS,
        hotel_partnerships:     HOTEL_PARTNERSHIPS,
      },
    });
  } catch (err) {
    console.error('GET /api/occ error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/occ/wet-lease  { contract: 'none'|'basic'|'premium'|'unlimited' }
router.patch('/wet-lease', authMiddleware, async (req, res) => {
  const { contract } = req.body || {};
  if (!WET_LEASE_CONTRACTS[contract]) return res.status(400).json({ error: 'Invalid contract' });
  await pool.query('UPDATE airlines SET wet_lease_contract = $1 WHERE id = $2', [contract, req.airlineId]);
  res.json({ ok: true, contract });
});

// PATCH /api/occ/hotel-partnership { partnership: 'none'|'basic'|'premium'|'exclusive' }
router.patch('/hotel-partnership', authMiddleware, async (req, res) => {
  const { partnership } = req.body || {};
  if (!HOTEL_PARTNERSHIPS[partnership]) return res.status(400).json({ error: 'Invalid partnership' });
  await pool.query('UPDATE airlines SET hotel_partnership = $1 WHERE id = $2', [partnership, req.airlineId]);
  res.json({ ok: true, partnership });
});

// PATCH /api/occ/maintenance  { program: 'basic'|'enhanced'|'premium' }
router.patch('/maintenance', authMiddleware, async (req, res) => {
  const { program } = req.body || {};
  if (!MAINTENANCE_PROGRAMS[program]) return res.status(400).json({ error: 'Invalid program' });
  await pool.query('UPDATE airlines SET maintenance_program = $1 WHERE id = $2', [program, req.airlineId]);
  res.json({ ok: true, program });
});

// PATCH /api/occ/ground-handling  { level: 'standard'|'priority'|'premium' }
router.patch('/ground-handling', authMiddleware, async (req, res) => {
  const { level } = req.body || {};
  if (!GROUND_HANDLING_LEVELS[level]) return res.status(400).json({ error: 'Invalid level' });
  await pool.query('UPDATE airlines SET ground_handling_level = $1 WHERE id = $2', [level, req.airlineId]);
  res.json({ ok: true, level });
});

// GET /api/occ/weekly-report — aggregate of last 7 days
router.get('/weekly-report', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const sinceClause = "created_at >= NOW() - INTERVAL '7 days'";

    const flightsRes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('completed','cancelled')) AS finalized,
        COUNT(*) FILTER (WHERE status = 'completed' AND (delay_reason IS NULL OR delay_reason = '')) AS on_time,
        COUNT(*) FILTER (WHERE status = 'completed' AND delay_reason IS NOT NULL AND delay_reason <> '') AS delayed_completed,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled
      FROM flights
      WHERE airline_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
    `, [req.airlineId]);

    const eventsRes = await pool.query(`
      SELECT event_type, outcome, wet_leased,
             COUNT(*)::int AS count,
             COALESCE(SUM(cost), 0)::int AS total_cost,
             COALESCE(SUM(satisfaction_malus), 0)::int AS total_sat_malus,
             COALESCE(SUM(delay_minutes), 0)::int AS total_delay_min
      FROM flight_delay_events
      WHERE airline_id = $1 AND ${sinceClause}
      GROUP BY event_type, outcome, wet_leased
      ORDER BY event_type, outcome
    `, [req.airlineId]);

    const totalsRes = await pool.query(`
      SELECT
        COALESCE(SUM(cost), 0)::int AS total_disruption_cost,
        COALESCE(SUM(CASE WHEN wet_leased THEN cost ELSE 0 END), 0)::int AS wet_lease_cost,
        COALESCE(SUM(satisfaction_malus), 0)::int AS total_sat_malus,
        COUNT(*) FILTER (WHERE wet_leased) AS wet_lease_activations
      FROM flight_delay_events
      WHERE airline_id = $1 AND ${sinceClause}
    `, [req.airlineId]);

    const fl = flightsRes.rows[0] || {};
    const totals = totalsRes.rows[0] || {};
    const finalized = parseInt(fl.finalized) || 0;
    const onTime    = parseInt(fl.on_time) || 0;

    res.json({
      window: { days: 7, from: new Date(Date.now() - 7*86400e3).toISOString(), to: new Date().toISOString() },
      flights: {
        finalized,
        on_time: onTime,
        delayed_completed: parseInt(fl.delayed_completed) || 0,
        cancelled: parseInt(fl.cancelled) || 0,
        on_time_rate: finalized > 0 ? onTime / finalized : null,
      },
      totals: {
        disruption_cost: parseInt(totals.total_disruption_cost) || 0,
        wet_lease_cost:  parseInt(totals.wet_lease_cost) || 0,
        satisfaction_malus: parseInt(totals.total_sat_malus) || 0,
        wet_lease_activations: parseInt(totals.wet_lease_activations) || 0,
      },
      events: eventsRes.rows.map(r => ({
        event_type: r.event_type,
        outcome: r.outcome,
        wet_leased: r.wet_leased,
        count: r.count,
        total_cost: r.total_cost,
        total_sat_malus: r.total_sat_malus,
        total_delay_min: r.total_delay_min,
      })),
    });
  } catch (err) {
    console.error('GET /api/occ/weekly-report error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
