import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';
import { calcFlightSatisfaction } from '../utils/satisfaction.js';

const router = express.Router();

// ── GET /api/service-profiles/item-types ─────────────────────────────────────
// Public — returns the 15 global item type definitions
router.get('/item-types', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, item_name, category, price_economy, price_business, price_first, sort_order, image_eco, image_bus, image_fir FROM service_item_types ORDER BY sort_order'
    );
    const item_types = result.rows.map(r => ({
      id: r.id, item_name: r.item_name, category: r.category,
      price_economy: r.price_economy, price_business: r.price_business, price_first: r.price_first,
      sort_order: r.sort_order, image_eco: r.image_eco, image_bus: r.image_bus, image_fir: r.image_fir
    }));
    res.json({ item_types });
  } catch (error) {
    console.error('Get item types error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/service-profiles ────────────────────────────────────────────────
// List all profiles for the active airline with per-cabin cost totals
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.json({ profiles: [] });

    const result = await pool.query(`
      SELECT
        p.id, p.name, p.created_at,
        COALESCE((
          SELECT SUM(t.price_economy) FROM service_profile_items i
          JOIN service_item_types t ON i.item_type_id = t.id
          WHERE i.profile_id = p.id AND i.cabin_class = 'economy'
        ), 0) AS economy_cost,
        COALESCE((
          SELECT SUM(t.price_business) FROM service_profile_items i
          JOIN service_item_types t ON i.item_type_id = t.id
          WHERE i.profile_id = p.id AND i.cabin_class = 'business'
        ), 0) AS business_cost,
        COALESCE((
          SELECT SUM(t.price_first) FROM service_profile_items i
          JOIN service_item_types t ON i.item_type_id = t.id
          WHERE i.profile_id = p.id AND i.cabin_class = 'first'
        ), 0) AS first_cost
      FROM airline_service_profiles p
      WHERE p.airline_id = $1
      ORDER BY p.created_at ASC
    `, [req.airlineId]);

    const profiles = result.rows.map(r => ({
      id: r.id, name: r.name, created_at: r.created_at,
      economy_cost: parseFloat(r.economy_cost),
      business_cost: parseFloat(r.business_cost),
      first_cost: parseFloat(r.first_cost)
    }));
    res.json({ profiles });
  } catch (error) {
    console.error('Get service profiles error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/service-profiles/:id ────────────────────────────────────────────
// Single profile with its selected items
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const profileId = parseInt(req.params.id);

    const checkResult = await pool.query(
      'SELECT id, name FROM airline_service_profiles WHERE id = $1 AND airline_id = $2',
      [profileId, req.airlineId]
    );
    if (!checkResult.rows[0]) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    const profileRow = checkResult.rows[0];

    const itemsResult = await pool.query(
      'SELECT item_type_id, cabin_class FROM service_profile_items WHERE profile_id = $1',
      [profileId]
    );
    const selected_items = itemsResult.rows.map(r => ({
      item_type_id: r.item_type_id, cabin_class: r.cabin_class
    }));

    res.json({ profile: { id: profileRow.id, name: profileRow.name }, selected_items });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/service-profiles ───────────────────────────────────────────────
// Create a new profile
router.post('/', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
    const { name, items } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Profile name is required' });

    const insertResult = await pool.query(
      'INSERT INTO airline_service_profiles (airline_id, name) VALUES ($1, $2) RETURNING id',
      [req.airlineId, name.trim()]
    );
    const profileId = insertResult.rows[0].id;

    if (Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        if (item.item_type_id && item.cabin_class) {
          await pool.query(
            'INSERT INTO service_profile_items (profile_id, item_type_id, cabin_class) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [profileId, item.item_type_id, item.cabin_class]
          );
        }
      }
    }

    res.status(201).json({ message: 'Profile created', id: profileId });
  } catch (error) {
    console.error('Create profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PUT /api/service-profiles/:id ────────────────────────────────────────────
// Update profile name and replace all its items
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const profileId = parseInt(req.params.id);
    const { name, items } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Profile name is required' });

    const checkResult = await pool.query(
      'SELECT id FROM airline_service_profiles WHERE id = $1 AND airline_id = $2',
      [profileId, req.airlineId]
    );
    if (!checkResult.rows[0]) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    await pool.query('UPDATE airline_service_profiles SET name = $1 WHERE id = $2', [name.trim(), profileId]);
    await pool.query('DELETE FROM service_profile_items WHERE profile_id = $1', [profileId]);

    if (Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        if (item.item_type_id && item.cabin_class) {
          await pool.query(
            'INSERT INTO service_profile_items (profile_id, item_type_id, cabin_class) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [profileId, item.item_type_id, item.cabin_class]
          );
        }
      }
    }

    // Recalculate satisfaction_score for all future flights using this profile
    const futureFlightsResult = await pool.query(`
      SELECT f.id, f.aircraft_id,
             COALESCE(r.distance_km, ws_r.distance_km, 1000) AS distance_km
      FROM flights f
      LEFT JOIN routes r ON f.route_id = r.id
      LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
      LEFT JOIN routes ws_r ON ws.route_id = ws_r.id
      WHERE f.service_profile_id = $1 AND f.status IN ('scheduled', 'boarding')
    `, [profileId]);

    const toUpdate = futureFlightsResult.rows.map(r => ({
      id: r.id, aircraft_id: r.aircraft_id, distance_km: parseInt(r.distance_km) || 1000
    }));

    for (const f of toUpdate) {
      let ecoSeats = 0, bizSeats = 0, firstSeats = 0;
      let ecoSeatType = 'economy', bizSeatType = 'business', firstSeatType = 'first';
      let condition = 100;

      if (f.aircraft_id) {
        const acResult = await pool.query(`
          SELECT ac.airline_cabin_profile_id, ac.condition, at.max_passengers
          FROM aircraft ac JOIN aircraft_types at ON ac.aircraft_type_id = at.id
          WHERE ac.id = $1
        `, [f.aircraft_id]);

        if (acResult.rows[0]) {
          const ar = acResult.rows[0];
          const cabinProfileId = ar.airline_cabin_profile_id;
          condition = ar.condition ?? 100;
          const maxPax = ar.max_passengers ?? 100;

          if (cabinProfileId) {
            const clResult = await pool.query(
              'SELECT class_type, actual_capacity, seat_type FROM airline_cabin_classes WHERE profile_id = $1',
              [cabinProfileId]
            );
            for (const cr of clResult.rows) {
              if (cr.class_type === 'economy')       { ecoSeats = cr.actual_capacity; if (cr.seat_type) ecoSeatType = cr.seat_type; }
              else if (cr.class_type === 'business') { bizSeats = cr.actual_capacity; if (cr.seat_type) bizSeatType = cr.seat_type; }
              else if (cr.class_type === 'first')    { firstSeats = cr.actual_capacity; if (cr.seat_type) firstSeatType = cr.seat_type; }
            }
          }
          if (ecoSeats + bizSeats + firstSeats === 0) ecoSeats = maxPax;
        }
      }

      const { score, violations } = await calcFlightSatisfaction({
        distKm: f.distance_km,
        serviceProfileId: profileId,
        condition,
        ecoSeats,
        bizSeats,
        firstSeats,
        ecoSeatType,
        bizSeatType,
        firstSeatType,
      });

      await pool.query(
        'UPDATE flights SET satisfaction_score = $1, violated_rules = $2 WHERE id = $3',
        [score, JSON.stringify(violations), f.id]
      );
    }

    res.json({ message: 'Profile updated', recalculated_flights: toUpdate.length });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/service-profiles/:id/usage ──────────────────────────────────────
router.get('/:id/usage', authMiddleware, async (req, res) => {
  try {
    const profileId = parseInt(req.params.id);

    const checkResult = await pool.query(
      'SELECT id FROM airline_service_profiles WHERE id = $1 AND airline_id = $2',
      [profileId, req.airlineId]
    );
    if (!checkResult.rows[0]) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // Count routes using this profile
    const routeResult = await pool.query(
      'SELECT COUNT(*) FROM routes WHERE service_profile_id = $1 AND airline_id = $2',
      [profileId, req.airlineId]
    );
    const route_count = parseInt(routeResult.rows[0].count);

    // Count weekly_schedule entries using this profile
    const schedResult = await pool.query(`
      SELECT COUNT(*) FROM weekly_schedule ws
      JOIN aircraft ac ON ac.id = ws.aircraft_id
      WHERE ws.service_profile_id = $1 AND ac.airline_id = $2
    `, [profileId, req.airlineId]);
    const schedule_count = parseInt(schedResult.rows[0].count);

    res.json({ route_count, schedule_count, in_use: (route_count + schedule_count) > 0 });
  } catch (error) {
    console.error('Profile usage error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/service-profiles/:id ─────────────────────────────────────────
// Optional body: { replacement_id: <number> } — migrates references before deleting
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const profileId = parseInt(req.params.id);
    const replacementId = req.body?.replacement_id ? parseInt(req.body.replacement_id) : null;

    const checkResult = await pool.query(
      'SELECT id FROM airline_service_profiles WHERE id = $1 AND airline_id = $2',
      [profileId, req.airlineId]
    );
    if (!checkResult.rows[0]) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    if (replacementId) {
      // Validate replacement belongs to same airline
      const replResult = await pool.query(
        'SELECT id FROM airline_service_profiles WHERE id = $1 AND airline_id = $2',
        [replacementId, req.airlineId]
      );
      if (!replResult.rows[0]) {
        return res.status(400).json({ error: 'Replacement profile not found' });
      }

      // Migrate routes
      await pool.query(
        'UPDATE routes SET service_profile_id = $1 WHERE service_profile_id = $2 AND airline_id = $3',
        [replacementId, profileId, req.airlineId]
      );

      // Migrate weekly_schedule entries
      await pool.query(
        'UPDATE weekly_schedule SET service_profile_id = $1 WHERE service_profile_id = $2 AND aircraft_id IN (SELECT id FROM aircraft WHERE airline_id = $3)',
        [replacementId, profileId, req.airlineId]
      );
    }

    await pool.query('DELETE FROM airline_service_profiles WHERE id = $1', [profileId]);

    res.json({ message: 'Profile deleted' });
  } catch (error) {
    console.error('Delete profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
