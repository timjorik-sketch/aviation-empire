import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

const CLASS_ORDER = `CASE class_type WHEN 'economy' THEN 1 WHEN 'business' THEN 2 WHEN 'first' THEN 3 ELSE 4 END`;

async function fetchClasses(profileId) {
  const result = await pool.query(
    `SELECT class_type, seat_type, seat_ratio, percentage, actual_capacity
     FROM airline_cabin_classes WHERE profile_id = $1 ORDER BY ${CLASS_ORDER}`,
    [profileId]
  );
  return result.rows.map(r => ({
    class_type: r.class_type,
    seat_type: r.seat_type,
    seat_ratio: r.seat_ratio,
    percentage: r.percentage,
    actual_capacity: r.actual_capacity
  }));
}

// ── GET /api/cabin-profiles ───────────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.json({ profiles: [] });

    const result = await pool.query(`
      SELECT p.id, p.name, p.aircraft_type_id, p.created_at,
             t.full_name AS aircraft_type_name, t.manufacturer, t.model, t.max_passengers
      FROM airline_cabin_profiles p
      JOIN aircraft_types t ON p.aircraft_type_id = t.id
      WHERE p.airline_id = $1
      ORDER BY t.manufacturer, t.max_passengers, t.full_name, p.created_at
    `, [req.airlineId]);

    const profiles = result.rows.map(r => ({
      id: r.id, name: r.name, aircraft_type_id: r.aircraft_type_id, created_at: r.created_at,
      aircraft_type_name: r.aircraft_type_name, manufacturer: r.manufacturer,
      model: r.model, max_passengers: r.max_passengers,
      classes: []
    }));

    for (const p of profiles) {
      p.classes = await fetchClasses(p.id);
      p.total_capacity = p.classes.reduce((s, c) => s + c.actual_capacity, 0);
    }

    res.json({ profiles });
  } catch (error) {
    console.error('Get cabin profiles error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/cabin-profiles/for-type/:type_id ─────────────────────────────────
router.get('/for-type/:type_id', authMiddleware, async (req, res) => {
  try {
    const typeId = parseInt(req.params.type_id);
    if (!req.airlineId) return res.json({ profiles: [] });

    const result = await pool.query(`
      SELECT p.id, p.name, t.max_passengers
      FROM airline_cabin_profiles p
      JOIN aircraft_types t ON p.aircraft_type_id = t.id
      WHERE p.airline_id = $1 AND p.aircraft_type_id = $2
      ORDER BY p.created_at
    `, [req.airlineId, typeId]);

    const profiles = result.rows.map(r => ({
      id: r.id, name: r.name, max_passengers: r.max_passengers, classes: []
    }));

    for (const p of profiles) {
      p.classes = await fetchClasses(p.id);
      p.total_capacity = p.classes.reduce((s, c) => s + c.actual_capacity, 0);
    }

    res.json({ profiles });
  } catch (error) {
    console.error('Get profiles for type error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/cabin-profiles/:id ───────────────────────────────────────────────
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const profileId = parseInt(req.params.id);

    const result = await pool.query(`
      SELECT p.id, p.name, p.aircraft_type_id, p.created_at,
             t.full_name, t.max_passengers
      FROM airline_cabin_profiles p
      JOIN aircraft_types t ON p.aircraft_type_id = t.id
      WHERE p.id = $1 AND p.airline_id = $2
    `, [profileId, req.airlineId]);

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    const r = result.rows[0];

    const profile = {
      id: r.id, name: r.name, aircraft_type_id: r.aircraft_type_id,
      created_at: r.created_at, aircraft_type_name: r.full_name,
      max_passengers: r.max_passengers, classes: []
    };
    profile.classes = await fetchClasses(profileId);
    profile.total_capacity = profile.classes.reduce((s, c) => s + c.actual_capacity, 0);

    res.json({ profile });
  } catch (error) {
    console.error('Get cabin profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/cabin-profiles ──────────────────────────────────────────────────
router.post('/', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
    const { name, aircraft_type_id, classes } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ error: 'Profile name is required' });
    if (!aircraft_type_id) return res.status(400).json({ error: 'Aircraft type is required' });
    if (!Array.isArray(classes) || classes.length === 0) {
      return res.status(400).json({ error: 'At least one cabin class is required' });
    }

    const typeResult = await pool.query('SELECT max_passengers FROM aircraft_types WHERE id = $1', [aircraft_type_id]);
    if (!typeResult.rows[0]) {
      return res.status(400).json({ error: 'Aircraft type not found' });
    }
    const maxPax = typeResult.rows[0].max_passengers;

    const insertResult = await pool.query(
      'INSERT INTO airline_cabin_profiles (airline_id, aircraft_type_id, name) VALUES ($1, $2, $3) RETURNING id',
      [req.airlineId, aircraft_type_id, name.trim()]
    );
    const profileId = insertResult.rows[0].id;

    const valid = ['economy', 'business', 'first'];
    for (const cls of classes) {
      if (!valid.includes(cls.class_type)) continue;
      const pct = Math.max(0, Math.min(100, parseFloat(cls.percentage) || 0));
      const ratio = parseFloat(cls.seat_ratio) || 1.0;
      const actual = Math.floor((pct / 100) * maxPax / ratio);
      await pool.query(
        'INSERT INTO airline_cabin_classes (profile_id, class_type, seat_type, seat_ratio, percentage, actual_capacity) VALUES ($1, $2, $3, $4, $5, $6)',
        [profileId, cls.class_type, cls.seat_type || cls.class_type, ratio, pct, actual]
      );
    }

    res.status(201).json({ message: 'Profile created', id: profileId });
  } catch (error) {
    console.error('Create cabin profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PUT /api/cabin-profiles/:id ───────────────────────────────────────────────
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const profileId = parseInt(req.params.id);
    const { name, classes } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ error: 'Profile name is required' });

    const checkResult = await pool.query(`
      SELECT p.id, t.max_passengers
      FROM airline_cabin_profiles p
      JOIN aircraft_types t ON p.aircraft_type_id = t.id
      WHERE p.id = $1 AND p.airline_id = $2
    `, [profileId, req.airlineId]);
    if (!checkResult.rows[0]) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    const maxPax = checkResult.rows[0].max_passengers;

    await pool.query('UPDATE airline_cabin_profiles SET name = $1 WHERE id = $2', [name.trim(), profileId]);
    await pool.query('DELETE FROM airline_cabin_classes WHERE profile_id = $1', [profileId]);

    if (Array.isArray(classes) && classes.length > 0) {
      const valid = ['economy', 'business', 'first'];
      for (const cls of classes) {
        if (!valid.includes(cls.class_type)) continue;
        const pct = Math.max(0, Math.min(100, parseFloat(cls.percentage) || 0));
        const ratio = parseFloat(cls.seat_ratio) || 1.0;
        const actual = Math.floor((pct / 100) * maxPax / ratio);
        await pool.query(
          'INSERT INTO airline_cabin_classes (profile_id, class_type, seat_type, seat_ratio, percentage, actual_capacity) VALUES ($1, $2, $3, $4, $5, $6)',
          [profileId, cls.class_type, cls.seat_type || cls.class_type, ratio, pct, actual]
        );
      }
    }

    res.json({ message: 'Profile updated' });
  } catch (error) {
    console.error('Update cabin profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/cabin-profiles/:id ───────────────────────────────────────────
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const profileId = parseInt(req.params.id);

    const checkResult = await pool.query(
      'SELECT id FROM airline_cabin_profiles WHERE id = $1 AND airline_id = $2',
      [profileId, req.airlineId]
    );
    if (!checkResult.rows[0]) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // Block deletion if any aircraft still use this profile
    const inUseResult = await pool.query(
      'SELECT COUNT(*) FROM aircraft WHERE airline_cabin_profile_id = $1',
      [profileId]
    );
    const inUseCount = parseInt(inUseResult.rows[0].count);
    if (inUseCount > 0) {
      return res.status(409).json({ error: `Cannot delete: ${inUseCount} aircraft still use this cabin profile. Reassign them first.` });
    }

    await pool.query('DELETE FROM airline_cabin_profiles WHERE id = $1', [profileId]);

    res.json({ message: 'Profile deleted' });
  } catch (error) {
    console.error('Delete cabin profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
