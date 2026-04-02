import express from 'express';
import { getDatabase, saveDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';
import { calcFlightSatisfaction } from '../utils/satisfaction.js';

const router = express.Router();

// ── GET /api/service-profiles/item-types ─────────────────────────────────────
// Public — returns the 15 global item type definitions
router.get('/item-types', (req, res) => {
  try {
    const db = getDatabase();
    const result = db.exec(
      'SELECT id, item_name, category, price_economy, price_business, price_first, sort_order, image_eco, image_bus, image_fir FROM service_item_types ORDER BY sort_order'
    );
    if (!result.length) return res.json({ item_types: [] });
    const item_types = result[0].values.map(r => ({
      id: r[0], item_name: r[1], category: r[2],
      price_economy: r[3], price_business: r[4], price_first: r[5],
      sort_order: r[6], image_eco: r[7], image_bus: r[8], image_fir: r[9]
    }));
    res.json({ item_types });
  } catch (error) {
    console.error('Get item types error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/service-profiles ────────────────────────────────────────────────
// List all profiles for the active airline with per-cabin cost totals
router.get('/', authMiddleware, (req, res) => {
  try {
    if (!req.airlineId) return res.json({ profiles: [] });
    const db = getDatabase();

    const stmt = db.prepare(`
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
      WHERE p.airline_id = ?
      ORDER BY p.created_at ASC
    `);
    stmt.bind([req.airlineId]);
    const profiles = [];
    while (stmt.step()) {
      const r = stmt.get();
      profiles.push({
        id: r[0], name: r[1], created_at: r[2],
        economy_cost: r[3], business_cost: r[4], first_cost: r[5]
      });
    }
    stmt.free();
    res.json({ profiles });
  } catch (error) {
    console.error('Get service profiles error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/service-profiles/:id ────────────────────────────────────────────
// Single profile with its selected items
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const profileId = parseInt(req.params.id);
    const db = getDatabase();

    const checkStmt = db.prepare(
      'SELECT id, name FROM airline_service_profiles WHERE id = ? AND airline_id = ?'
    );
    checkStmt.bind([profileId, req.airlineId]);
    if (!checkStmt.step()) {
      checkStmt.free();
      return res.status(404).json({ error: 'Profile not found' });
    }
    const profileRow = checkStmt.get();
    checkStmt.free();

    const itemsStmt = db.prepare(
      'SELECT item_type_id, cabin_class FROM service_profile_items WHERE profile_id = ?'
    );
    itemsStmt.bind([profileId]);
    const selected_items = [];
    while (itemsStmt.step()) {
      const r = itemsStmt.get();
      selected_items.push({ item_type_id: r[0], cabin_class: r[1] });
    }
    itemsStmt.free();

    res.json({ profile: { id: profileRow[0], name: profileRow[1] }, selected_items });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/service-profiles ───────────────────────────────────────────────
// Create a new profile
router.post('/', authMiddleware, (req, res) => {
  try {
    if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
    const { name, items } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Profile name is required' });

    const db = getDatabase();

    const insertStmt = db.prepare(
      'INSERT INTO airline_service_profiles (airline_id, name) VALUES (?, ?)'
    );
    insertStmt.bind([req.airlineId, name.trim()]);
    insertStmt.step();
    insertStmt.free();

    const idStmt = db.prepare('SELECT last_insert_rowid()');
    idStmt.step();
    const profileId = idStmt.get()[0];
    idStmt.free();

    if (Array.isArray(items) && items.length > 0) {
      const itemStmt = db.prepare(
        'INSERT OR IGNORE INTO service_profile_items (profile_id, item_type_id, cabin_class) VALUES (?, ?, ?)'
      );
      for (const item of items) {
        if (item.item_type_id && item.cabin_class) {
          itemStmt.bind([profileId, item.item_type_id, item.cabin_class]);
          itemStmt.step();
          itemStmt.reset();
        }
      }
      itemStmt.free();
    }

    saveDatabase();
    res.status(201).json({ message: 'Profile created', id: profileId });
  } catch (error) {
    console.error('Create profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PUT /api/service-profiles/:id ────────────────────────────────────────────
// Update profile name and replace all its items
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const profileId = parseInt(req.params.id);
    const { name, items } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Profile name is required' });

    const db = getDatabase();

    const checkStmt = db.prepare(
      'SELECT id FROM airline_service_profiles WHERE id = ? AND airline_id = ?'
    );
    checkStmt.bind([profileId, req.airlineId]);
    if (!checkStmt.step()) {
      checkStmt.free();
      return res.status(404).json({ error: 'Profile not found' });
    }
    checkStmt.free();

    const updateStmt = db.prepare(
      'UPDATE airline_service_profiles SET name = ? WHERE id = ?'
    );
    updateStmt.bind([name.trim(), profileId]);
    updateStmt.step();
    updateStmt.free();

    const deleteStmt = db.prepare(
      'DELETE FROM service_profile_items WHERE profile_id = ?'
    );
    deleteStmt.bind([profileId]);
    deleteStmt.step();
    deleteStmt.free();

    if (Array.isArray(items) && items.length > 0) {
      const itemStmt = db.prepare(
        'INSERT OR IGNORE INTO service_profile_items (profile_id, item_type_id, cabin_class) VALUES (?, ?, ?)'
      );
      for (const item of items) {
        if (item.item_type_id && item.cabin_class) {
          itemStmt.bind([profileId, item.item_type_id, item.cabin_class]);
          itemStmt.step();
          itemStmt.reset();
        }
      }
      itemStmt.free();
    }

    // Recalculate satisfaction_score for all future flights using this profile,
    // so changes take effect immediately (not just for newly generated flights)
    const futureFlightsStmt = db.prepare(`
      SELECT f.id, f.aircraft_id,
             COALESCE(r.distance_km, ws_r.distance_km, 1000) AS distance_km
      FROM flights f
      LEFT JOIN routes r ON f.route_id = r.id
      LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
      LEFT JOIN routes ws_r ON ws.route_id = ws_r.id
      WHERE f.service_profile_id = ? AND f.status IN ('scheduled', 'boarding')
    `);
    futureFlightsStmt.bind([profileId]);
    const toUpdate = [];
    while (futureFlightsStmt.step()) {
      const r = futureFlightsStmt.get();
      toUpdate.push({ id: r[0], aircraft_id: r[1], distance_km: r[2] || 1000 });
    }
    futureFlightsStmt.free();

    for (const f of toUpdate) {
      let ecoSeats = 0, bizSeats = 0, firstSeats = 0;
      let ecoSeatType = 'economy', bizSeatType = 'business', firstSeatType = 'first';
      let condition = 100;

      if (f.aircraft_id) {
        const acStmt = db.prepare(`
          SELECT ac.airline_cabin_profile_id, ac.condition, at.max_passengers
          FROM aircraft ac JOIN aircraft_types at ON ac.aircraft_type_id = at.id
          WHERE ac.id = ?
        `);
        acStmt.bind([f.aircraft_id]);
        let cabinProfileId = null, maxPax = 100;
        if (acStmt.step()) {
          const ar = acStmt.get();
          cabinProfileId = ar[0]; condition = ar[1] ?? 100; maxPax = ar[2] ?? 100;
        }
        acStmt.free();

        if (cabinProfileId) {
          const clStmt = db.prepare(
            'SELECT class_type, actual_capacity, seat_type FROM airline_cabin_classes WHERE profile_id = ?'
          );
          clStmt.bind([cabinProfileId]);
          while (clStmt.step()) {
            const cr = clStmt.get();
            if (cr[0] === 'economy')       { ecoSeats = cr[1]; if (cr[2]) ecoSeatType = cr[2]; }
            else if (cr[0] === 'business') { bizSeats = cr[1]; if (cr[2]) bizSeatType = cr[2]; }
            else if (cr[0] === 'first')    { firstSeats = cr[1]; if (cr[2]) firstSeatType = cr[2]; }
          }
          clStmt.free();
        }
        if (ecoSeats + bizSeats + firstSeats === 0) ecoSeats = maxPax;
      }

      const { score, violations } = calcFlightSatisfaction(db, {
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

      const updStmt = db.prepare(
        'UPDATE flights SET satisfaction_score = ?, violated_rules = ? WHERE id = ?'
      );
      updStmt.bind([score, JSON.stringify(violations), f.id]);
      updStmt.step();
      updStmt.free();
    }

    saveDatabase();
    res.json({ message: 'Profile updated', recalculated_flights: toUpdate.length });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/service-profiles/:id/usage ──────────────────────────────────────
router.get('/:id/usage', authMiddleware, (req, res) => {
  try {
    const profileId = parseInt(req.params.id);
    const db = getDatabase();

    const checkStmt = db.prepare(
      'SELECT id FROM airline_service_profiles WHERE id = ? AND airline_id = ?'
    );
    checkStmt.bind([profileId, req.airlineId]);
    if (!checkStmt.step()) {
      checkStmt.free();
      return res.status(404).json({ error: 'Profile not found' });
    }
    checkStmt.free();

    // Count routes using this profile
    const routeStmt = db.prepare(
      'SELECT COUNT(*) FROM routes WHERE service_profile_id = ? AND airline_id = ?'
    );
    routeStmt.bind([profileId, req.airlineId]);
    routeStmt.step();
    const route_count = routeStmt.get()[0];
    routeStmt.free();

    // Count weekly_schedule entries using this profile
    const schedStmt = db.prepare(`
      SELECT COUNT(*) FROM weekly_schedule ws
      JOIN aircraft ac ON ac.id = ws.aircraft_id
      WHERE ws.service_profile_id = ? AND ac.airline_id = ?
    `);
    schedStmt.bind([profileId, req.airlineId]);
    schedStmt.step();
    const schedule_count = schedStmt.get()[0];
    schedStmt.free();

    res.json({ route_count, schedule_count, in_use: (route_count + schedule_count) > 0 });
  } catch (error) {
    console.error('Profile usage error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/service-profiles/:id ─────────────────────────────────────────
// Optional body: { replacement_id: <number> } — migrates references before deleting
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const profileId = parseInt(req.params.id);
    const replacementId = req.body?.replacement_id ? parseInt(req.body.replacement_id) : null;
    const db = getDatabase();

    const checkStmt = db.prepare(
      'SELECT id FROM airline_service_profiles WHERE id = ? AND airline_id = ?'
    );
    checkStmt.bind([profileId, req.airlineId]);
    if (!checkStmt.step()) {
      checkStmt.free();
      return res.status(404).json({ error: 'Profile not found' });
    }
    checkStmt.free();

    if (replacementId) {
      // Validate replacement belongs to same airline
      const replStmt = db.prepare(
        'SELECT id FROM airline_service_profiles WHERE id = ? AND airline_id = ?'
      );
      replStmt.bind([replacementId, req.airlineId]);
      if (!replStmt.step()) {
        replStmt.free();
        return res.status(400).json({ error: 'Replacement profile not found' });
      }
      replStmt.free();

      // Migrate routes
      db.exec(`UPDATE routes SET service_profile_id = ${replacementId} WHERE service_profile_id = ${profileId} AND airline_id = ${req.airlineId}`);

      // Migrate weekly_schedule entries
      db.exec(`UPDATE weekly_schedule SET service_profile_id = ${replacementId} WHERE service_profile_id = ${profileId} AND aircraft_id IN (SELECT id FROM aircraft WHERE airline_id = ${req.airlineId})`);
    }

    const deleteStmt = db.prepare(
      'DELETE FROM airline_service_profiles WHERE id = ?'
    );
    deleteStmt.bind([profileId]);
    deleteStmt.step();
    deleteStmt.free();

    saveDatabase();
    res.json({ message: 'Profile deleted' });
  } catch (error) {
    console.error('Delete profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
