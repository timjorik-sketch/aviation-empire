// Operations Control Center (OCC) routes — player-facing config + weekly report.
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
      'SELECT id, wet_lease_contract, hotel_partnership FROM airlines WHERE id = $1',
      [req.airlineId]
    );
    const airline = airlineRes.rows[0];
    if (!airline) return res.status(404).json({ error: 'Airline not found' });

    // Aircraft list with maintenance programs
    const acRes = await pool.query(`
      SELECT a.id, a.registration, a.name, a.maintenance_program, a.home_airport,
             t.full_name AS type_name, t.wake_turbulence_category AS wake_cat
      FROM aircraft a
      LEFT JOIN aircraft_types t ON a.aircraft_type_id = t.id
      WHERE a.airline_id = $1
      ORDER BY a.registration
    `, [req.airlineId]);

    // Hub list (home_base + primary_hub + secondary hubs)
    const hubCodes = [...await getAirlineHubCodes(req.airlineId)];
    let hubs = [];
    if (hubCodes.length) {
      const hubRes = await pool.query(`
        SELECT iata_code, name, country, category
        FROM airports WHERE iata_code = ANY($1::text[])
        ORDER BY iata_code
      `, [hubCodes]);
      const ghRes = await pool.query(
        "SELECT airport_code, level FROM airline_ground_handling WHERE airline_id = $1",
        [req.airlineId]
      );
      const ghLevelByCode = new Map(ghRes.rows.map(r => [r.airport_code, r.level]));
      hubs = hubRes.rows.map(r => ({
        iata_code: r.iata_code,
        name: r.name,
        country: r.country,
        category: r.category,
        ground_handling_level: ghLevelByCode.get(r.iata_code) || 'standard',
      }));
    }

    res.json({
      wet_lease_contract: airline.wet_lease_contract || 'none',
      hotel_partnership:  airline.hotel_partnership  || 'none',
      aircraft: acRes.rows.map(a => ({
        id: a.id,
        registration: a.registration,
        name: a.name,
        type_name: a.type_name,
        wake_cat: a.wake_cat,
        home_airport: a.home_airport,
        maintenance_program: a.maintenance_program || 'basic',
      })),
      hubs,
      catalog: {
        maintenance_programs: MAINTENANCE_PROGRAMS,
        ground_handling_levels: GROUND_HANDLING_LEVELS,
        wet_lease_contracts: WET_LEASE_CONTRACTS,
        hotel_partnerships: HOTEL_PARTNERSHIPS,
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

// PATCH /api/occ/aircraft/:id/maintenance  { program: 'basic'|'enhanced'|'premium' }
router.patch('/aircraft/:id/maintenance', authMiddleware, async (req, res) => {
  const { program } = req.body || {};
  if (!MAINTENANCE_PROGRAMS[program]) return res.status(400).json({ error: 'Invalid program' });
  // Verify aircraft belongs to this airline
  const own = await pool.query('SELECT id FROM aircraft WHERE id = $1 AND airline_id = $2', [req.params.id, req.airlineId]);
  if (!own.rows[0]) return res.status(404).json({ error: 'Aircraft not found' });
  await pool.query('UPDATE aircraft SET maintenance_program = $1 WHERE id = $2', [program, req.params.id]);
  res.json({ ok: true, program });
});

// PATCH /api/occ/hub/:code/ground-handling  { level: 'standard'|'priority'|'premium' }
router.patch('/hub/:code/ground-handling', authMiddleware, async (req, res) => {
  const { level } = req.body || {};
  if (!GROUND_HANDLING_LEVELS[level]) return res.status(400).json({ error: 'Invalid level' });
  // Verify the airport is actually a hub for this airline
  const hubCodes = await getAirlineHubCodes(req.airlineId);
  if (!hubCodes.has(req.params.code)) return res.status(403).json({ error: 'Not a hub for this airline' });
  await pool.query(`
    INSERT INTO airline_ground_handling (airline_id, airport_code, level)
    VALUES ($1, $2, $3)
    ON CONFLICT (airline_id, airport_code) DO UPDATE SET level = EXCLUDED.level
  `, [req.airlineId, req.params.code, level]);
  res.json({ ok: true, level });
});

// GET /api/occ/weekly-report — aggregate of last 7 days
router.get('/weekly-report', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const sinceClause = "created_at >= NOW() - INTERVAL '7 days'";

    // Total flights this week (all statuses)
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
