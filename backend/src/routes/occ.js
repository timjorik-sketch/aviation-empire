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
  HOTEL_PARTNERSHIPS,
  getAirlineHubCodes,
} from '../utils/delaySystem.js';

const router = express.Router();

// GET /api/occ — full configuration for the active airline
router.get('/', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const airlineRes = await pool.query(
      `SELECT id, hotel_partnership,
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
      hotel_partnership:     airline.hotel_partnership     || 'none',
      maintenance_program:   airline.maintenance_program   || 'basic',
      ground_handling_level: airline.ground_handling_level || 'standard',
      fleet_count: fleetCount,
      hub_count:   hubCount,
      catalog: {
        maintenance_programs:   MAINTENANCE_PROGRAMS,
        ground_handling_levels: GROUND_HANDLING_LEVELS,
        hotel_partnerships:     HOTEL_PARTNERSHIPS,
      },
    });
  } catch (err) {
    console.error('GET /api/occ error:', err);
    res.status(500).json({ error: 'Server error' });
  }
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

    // "Stability" is the share of all finalized flights that completed
    // on time AND uncancelled. It deliberately includes cancellations in
    // the denominator — a player with many cancels has low stability.
    const flightsRes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('completed','cancelled')) AS finalized,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'completed' AND (delay_reason IS NULL OR delay_reason = '')) AS on_time,
        COUNT(*) FILTER (WHERE status = 'completed' AND delay_reason IS NOT NULL AND delay_reason <> '') AS delayed_completed,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled
      FROM flights
      WHERE airline_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
    `, [req.airlineId]);

    // Per-event listing (last 200) so the player can see exactly which flight
    // and aircraft each disruption hit.
    const eventsRes = await pool.query(`
      SELECT fde.id, fde.event_type, fde.outcome, fde.wet_leased,
             fde.delay_minutes, fde.cost, fde.satisfaction_malus,
             fde.diversion_airport, fde.created_at,
             fde.aircraft_id,
             f.flight_number,
             a.registration AS aircraft_reg,
             COALESCE(r.departure_airport, ws.departure_airport) AS dep_airport,
             COALESCE(r.arrival_airport,   ws.arrival_airport)   AS arr_airport
      FROM flight_delay_events fde
      LEFT JOIN flights f          ON fde.flight_id   = f.id
      LEFT JOIN aircraft a         ON fde.aircraft_id = a.id
      LEFT JOIN routes r           ON f.route_id      = r.id
      LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
      WHERE fde.airline_id = $1 AND fde.${sinceClause}
      ORDER BY fde.created_at DESC
      LIMIT 200
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
    const completed = parseInt(fl.completed) || 0;
    const onTime    = parseInt(fl.on_time) || 0;
    const cancelled = parseInt(fl.cancelled) || 0;

    res.json({
      window: { days: 7, from: new Date(Date.now() - 7*86400e3).toISOString(), to: new Date().toISOString() },
      flights: {
        finalized,
        completed,
        on_time: onTime,
        delayed_completed: parseInt(fl.delayed_completed) || 0,
        cancelled,
        // Stability = share of finalized flights that ran AND ran on time.
        // Cancelled flights count against stability.
        stability:         finalized > 0 ? onTime / finalized : null,
        cancellation_rate: finalized > 0 ? cancelled / finalized : null,
      },
      totals: {
        disruption_cost: parseInt(totals.total_disruption_cost) || 0,
        wet_lease_cost:  parseInt(totals.wet_lease_cost) || 0,
        satisfaction_malus: parseInt(totals.total_sat_malus) || 0,
        wet_lease_activations: parseInt(totals.wet_lease_activations) || 0,
      },
      events: eventsRes.rows.map(r => ({
        id: r.id,
        created_at: r.created_at,
        event_type: r.event_type,
        outcome: r.outcome,
        wet_leased: r.wet_leased,
        delay_minutes: r.delay_minutes,
        cost: r.cost,
        satisfaction_malus: r.satisfaction_malus,
        diversion_airport: r.diversion_airport,
        flight_number: r.flight_number,
        aircraft_id: r.aircraft_id,
        aircraft_reg: r.aircraft_reg,
        dep_airport: r.dep_airport,
        arr_airport: r.arr_airport,
      })),
    });
  } catch (err) {
    console.error('GET /api/occ/weekly-report error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
