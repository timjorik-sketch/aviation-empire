import express from 'express';
import { getDatabase, saveDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

const CLASS_ORDER = `CASE class_type WHEN 'economy' THEN 1 WHEN 'business' THEN 2 WHEN 'first' THEN 3 ELSE 4 END`;

function fetchClasses(db, profileId) {
  const stmt = db.prepare(
    `SELECT class_type, seat_type, seat_ratio, percentage, actual_capacity
     FROM airline_cabin_classes WHERE profile_id = ? ORDER BY ${CLASS_ORDER}`
  );
  stmt.bind([profileId]);
  const classes = [];
  while (stmt.step()) {
    const r = stmt.get();
    classes.push({ class_type: r[0], seat_type: r[1], seat_ratio: r[2], percentage: r[3], actual_capacity: r[4] });
  }
  stmt.free();
  return classes;
}

// ── GET /api/cabin-profiles ───────────────────────────────────────────────────
router.get('/', authMiddleware, (req, res) => {
  try {
    if (!req.airlineId) return res.json({ profiles: [] });
    const db = getDatabase();

    const stmt = db.prepare(`
      SELECT p.id, p.name, p.aircraft_type_id, p.created_at,
             t.full_name AS aircraft_type_name, t.manufacturer, t.model, t.max_passengers
      FROM airline_cabin_profiles p
      JOIN aircraft_types t ON p.aircraft_type_id = t.id
      WHERE p.airline_id = ?
      ORDER BY t.manufacturer, t.model, p.created_at
    `);
    stmt.bind([req.airlineId]);
    const profiles = [];
    while (stmt.step()) {
      const r = stmt.get();
      profiles.push({
        id: r[0], name: r[1], aircraft_type_id: r[2], created_at: r[3],
        aircraft_type_name: r[4], manufacturer: r[5], model: r[6], max_passengers: r[7],
        classes: []
      });
    }
    stmt.free();

    for (const p of profiles) {
      p.classes = fetchClasses(db, p.id);
      p.total_capacity = p.classes.reduce((s, c) => s + c.actual_capacity, 0);
    }

    res.json({ profiles });
  } catch (error) {
    console.error('Get cabin profiles error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/cabin-profiles/for-type/:type_id ─────────────────────────────────
router.get('/for-type/:type_id', authMiddleware, (req, res) => {
  try {
    const typeId = parseInt(req.params.type_id);
    if (!req.airlineId) return res.json({ profiles: [] });
    const db = getDatabase();

    const stmt = db.prepare(`
      SELECT p.id, p.name, t.max_passengers
      FROM airline_cabin_profiles p
      JOIN aircraft_types t ON p.aircraft_type_id = t.id
      WHERE p.airline_id = ? AND p.aircraft_type_id = ?
      ORDER BY p.created_at
    `);
    stmt.bind([req.airlineId, typeId]);
    const profiles = [];
    while (stmt.step()) {
      const r = stmt.get();
      profiles.push({ id: r[0], name: r[1], max_passengers: r[2], classes: [] });
    }
    stmt.free();

    for (const p of profiles) {
      p.classes = fetchClasses(db, p.id);
      p.total_capacity = p.classes.reduce((s, c) => s + c.actual_capacity, 0);
    }

    res.json({ profiles });
  } catch (error) {
    console.error('Get profiles for type error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/cabin-profiles/:id ───────────────────────────────────────────────
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const profileId = parseInt(req.params.id);
    const db = getDatabase();

    const stmt = db.prepare(`
      SELECT p.id, p.name, p.aircraft_type_id, p.created_at,
             t.full_name, t.max_passengers
      FROM airline_cabin_profiles p
      JOIN aircraft_types t ON p.aircraft_type_id = t.id
      WHERE p.id = ? AND p.airline_id = ?
    `);
    stmt.bind([profileId, req.airlineId]);
    if (!stmt.step()) {
      stmt.free();
      return res.status(404).json({ error: 'Profile not found' });
    }
    const r = stmt.get();
    stmt.free();

    const profile = {
      id: r[0], name: r[1], aircraft_type_id: r[2], created_at: r[3],
      aircraft_type_name: r[4], max_passengers: r[5], classes: []
    };
    profile.classes = fetchClasses(db, profileId);
    profile.total_capacity = profile.classes.reduce((s, c) => s + c.actual_capacity, 0);

    res.json({ profile });
  } catch (error) {
    console.error('Get cabin profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/cabin-profiles ──────────────────────────────────────────────────
router.post('/', authMiddleware, (req, res) => {
  try {
    if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
    const { name, aircraft_type_id, classes } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ error: 'Profile name is required' });
    if (!aircraft_type_id) return res.status(400).json({ error: 'Aircraft type is required' });
    if (!Array.isArray(classes) || classes.length === 0) {
      return res.status(400).json({ error: 'At least one cabin class is required' });
    }

    const db = getDatabase();

    const typeStmt = db.prepare('SELECT max_passengers FROM aircraft_types WHERE id = ?');
    typeStmt.bind([aircraft_type_id]);
    if (!typeStmt.step()) {
      typeStmt.free();
      return res.status(400).json({ error: 'Aircraft type not found' });
    }
    const maxPax = typeStmt.get()[0];
    typeStmt.free();

    const insertStmt = db.prepare(
      'INSERT INTO airline_cabin_profiles (airline_id, aircraft_type_id, name) VALUES (?, ?, ?)'
    );
    insertStmt.bind([req.airlineId, aircraft_type_id, name.trim()]);
    insertStmt.step();
    insertStmt.free();

    const idStmt = db.prepare('SELECT last_insert_rowid()');
    idStmt.step();
    const profileId = idStmt.get()[0];
    idStmt.free();

    const valid = ['economy', 'business', 'first'];
    const clsStmt = db.prepare(
      'INSERT INTO airline_cabin_classes (profile_id, class_type, seat_type, seat_ratio, percentage, actual_capacity) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const cls of classes) {
      if (!valid.includes(cls.class_type)) continue;
      const pct = Math.max(0, Math.min(100, parseFloat(cls.percentage) || 0));
      const ratio = parseFloat(cls.seat_ratio) || 1.0;
      const actual = Math.floor((pct / 100) * maxPax / ratio);
      clsStmt.bind([profileId, cls.class_type, cls.seat_type || cls.class_type, ratio, pct, actual]);
      clsStmt.step();
      clsStmt.reset();
    }
    clsStmt.free();

    saveDatabase();
    res.status(201).json({ message: 'Profile created', id: profileId });
  } catch (error) {
    console.error('Create cabin profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PUT /api/cabin-profiles/:id ───────────────────────────────────────────────
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const profileId = parseInt(req.params.id);
    const { name, classes } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ error: 'Profile name is required' });
    const db = getDatabase();

    const checkStmt = db.prepare(`
      SELECT p.id, t.max_passengers
      FROM airline_cabin_profiles p
      JOIN aircraft_types t ON p.aircraft_type_id = t.id
      WHERE p.id = ? AND p.airline_id = ?
    `);
    checkStmt.bind([profileId, req.airlineId]);
    if (!checkStmt.step()) {
      checkStmt.free();
      return res.status(404).json({ error: 'Profile not found' });
    }
    const maxPax = checkStmt.get()[1];
    checkStmt.free();

    const updateStmt = db.prepare('UPDATE airline_cabin_profiles SET name = ? WHERE id = ?');
    updateStmt.bind([name.trim(), profileId]);
    updateStmt.step();
    updateStmt.free();

    const delStmt = db.prepare('DELETE FROM airline_cabin_classes WHERE profile_id = ?');
    delStmt.bind([profileId]);
    delStmt.step();
    delStmt.free();

    if (Array.isArray(classes) && classes.length > 0) {
      const valid = ['economy', 'business', 'first'];
      const clsStmt = db.prepare(
        'INSERT INTO airline_cabin_classes (profile_id, class_type, seat_type, seat_ratio, percentage, actual_capacity) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const cls of classes) {
        if (!valid.includes(cls.class_type)) continue;
        const pct = Math.max(0, Math.min(100, parseFloat(cls.percentage) || 0));
        const ratio = parseFloat(cls.seat_ratio) || 1.0;
        const actual = Math.floor((pct / 100) * maxPax / ratio);
        clsStmt.bind([profileId, cls.class_type, cls.seat_type || cls.class_type, ratio, pct, actual]);
        clsStmt.step();
        clsStmt.reset();
      }
      clsStmt.free();
    }

    saveDatabase();
    res.json({ message: 'Profile updated' });
  } catch (error) {
    console.error('Update cabin profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/cabin-profiles/:id ───────────────────────────────────────────
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const profileId = parseInt(req.params.id);
    const db = getDatabase();

    const checkStmt = db.prepare('SELECT id FROM airline_cabin_profiles WHERE id = ? AND airline_id = ?');
    checkStmt.bind([profileId, req.airlineId]);
    if (!checkStmt.step()) {
      checkStmt.free();
      return res.status(404).json({ error: 'Profile not found' });
    }
    checkStmt.free();

    // Block deletion if any aircraft still use this profile
    const inUseStmt = db.prepare('SELECT COUNT(*) FROM aircraft WHERE airline_cabin_profile_id = ?');
    inUseStmt.bind([profileId]);
    inUseStmt.step();
    const inUseCount = inUseStmt.get()[0];
    inUseStmt.free();
    if (inUseCount > 0) {
      return res.status(409).json({ error: `Cannot delete: ${inUseCount} aircraft still use this cabin profile. Reassign them first.` });
    }

    const delStmt = db.prepare('DELETE FROM airline_cabin_profiles WHERE id = ?');
    delStmt.bind([profileId]);
    delStmt.step();
    delStmt.free();

    saveDatabase();
    res.json({ message: 'Profile deleted' });
  } catch (error) {
    console.error('Delete cabin profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
