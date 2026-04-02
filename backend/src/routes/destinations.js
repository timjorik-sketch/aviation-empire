import express from 'express';
import { getDatabase, saveDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';
import { addGroundStaff } from './personnel.js';

const router = express.Router();

const OPEN_COST  = 50_000;
const HUB_COST   = 10_000_000;
const HUB_THRESHOLD = 600; // weekly schedule entries

// Ensure home base destination exists (lazy init)
function ensureHomeBase(db, airlineId) {
  const s = db.prepare('SELECT home_airport_code FROM airlines WHERE id = ?');
  s.bind([airlineId]);
  if (!s.step()) { s.free(); return; }
  const homeCode = s.get()[0];
  s.free();

  const c = db.prepare('SELECT id FROM airline_destinations WHERE airline_id = ? AND airport_code = ?');
  c.bind([airlineId, homeCode]);
  const exists = c.step();
  c.free();
  if (!exists) {
    const i = db.prepare('INSERT INTO airline_destinations (airline_id, airport_code, destination_type) VALUES (?, ?, ?)');
    i.bind([airlineId, homeCode, 'home_base']);
    i.step(); i.free();
    saveDatabase();
  }
}

function effectiveType(destType, weeklyFlights) {
  if (destType === 'destination' && weeklyFlights >= HUB_THRESHOLD) return 'base';
  return destType;
}

// GET /api/destinations
router.get('/', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.json({ destinations: [] });
  try {
    const db = getDatabase();
    ensureHomeBase(db, req.airlineId);

    const stmt = db.prepare(`
      SELECT d.id, d.airport_code, d.destination_type, d.opened_at,
             ap.name, ap.country, ap.continent, ap.category,
             (SELECT COUNT(*) FROM weekly_schedule ws
              JOIN aircraft ac ON ws.aircraft_id = ac.id
              WHERE ac.airline_id = d.airline_id
              AND (ws.departure_airport = d.airport_code OR ws.arrival_airport = d.airport_code)
             ) AS weekly_flights,
             COALESCE((SELECT p.count FROM personnel p
              WHERE p.airline_id = d.airline_id AND p.staff_type = 'ground' AND p.airport_code = d.airport_code
             ), 0) AS ground_staff,
             CASE WHEN EXISTS (
               SELECT 1 FROM airport_expansions ae
               WHERE ae.airline_id = d.airline_id AND ae.airport_code = d.airport_code AND ae.expansion_level > 0
             ) THEN 1 ELSE 0 END AS has_expansion
      FROM airline_destinations d
      JOIN airports ap ON d.airport_code = ap.iata_code
      WHERE d.airline_id = ?
      ORDER BY
        CASE d.destination_type
          WHEN 'home_base'      THEN 0
          WHEN 'hub'            THEN 1
          WHEN 'hub_restricted' THEN 2
          ELSE 3
        END, ap.name ASC
    `);
    stmt.bind([req.airlineId]);

    const destinations = [];
    while (stmt.step()) {
      const r = stmt.get();
      const wf = r[8];
      const dtype = r[2];
      const hasExpansion = r[10] === 1;
      const groundStaff = dtype === 'home_base' ? 30 : r[9];
      const displayType = dtype === 'home_base' ? 'home_base'
        : hasExpansion ? 'hub_restricted'
        : dtype;
      destinations.push({
        id: r[0], airport_code: r[1], destination_type: dtype,
        display_type: displayType,
        effective_type: effectiveType(displayType, wf),
        opened_at: r[3], airport_name: r[4], country: r[5],
        continent: r[6], category: r[7], weekly_flights: wf,
        ground_staff: groundStaff, has_expansion: hasExpansion
      });
    }
    stmt.free();
    res.json({ destinations });
  } catch (error) {
    console.error('Get destinations error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/destinations/opened — all opened airports (for home base selection dropdowns)
router.get('/opened', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.json({ airports: [] });
  try {
    const db = getDatabase();
    ensureHomeBase(db, req.airlineId);

    const stmt = db.prepare(`
      SELECT ap.iata_code, ap.name, ap.country, d.destination_type
      FROM airline_destinations d
      JOIN airports ap ON d.airport_code = ap.iata_code
      WHERE d.airline_id = ?
      ORDER BY ap.country, ap.name
    `);
    stmt.bind([req.airlineId]);

    const airports = [];
    while (stmt.step()) {
      const r = stmt.get();
      airports.push({ iata_code: r[0], name: r[1], country: r[2], destination_type: r[3] });
    }
    stmt.free();
    res.json({ airports });
  } catch (error) {
    console.error('Get opened destinations error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/destinations/available
router.get('/available', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.json({ airports: [] });
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT ap.iata_code, ap.name, ap.country, ap.continent, ap.category
      FROM airports ap
      WHERE ap.iata_code NOT IN (
        SELECT airport_code FROM airline_destinations WHERE airline_id = ?
      )
      ORDER BY ap.continent, ap.country, ap.name
    `);
    stmt.bind([req.airlineId]);
    const airports = [];
    while (stmt.step()) {
      const r = stmt.get();
      airports.push({ iata_code: r[0], name: r[1], country: r[2], continent: r[3], category: r[4] });
    }
    stmt.free();
    res.json({ airports });
  } catch (error) {
    console.error('Get available destinations error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/destinations/open — open a destination for $50,000
router.post('/open', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const { airport_code, destination_type = 'destination' } = req.body;
    if (!airport_code) return res.status(400).json({ error: 'airport_code required' });
    const code = airport_code.toUpperCase();
    const validTypes = ['home_base', 'hub', 'base', 'destination'];
    const type = validTypes.includes(destination_type) ? destination_type : 'destination';

    const db = getDatabase();

    // Verify airport
    const apStmt = db.prepare('SELECT iata_code FROM airports WHERE iata_code = ?');
    apStmt.bind([code]);
    if (!apStmt.step()) { apStmt.free(); return res.status(404).json({ error: 'Airport not found' }); }
    apStmt.free();

    // Check not already opened
    const chk = db.prepare('SELECT id FROM airline_destinations WHERE airline_id = ? AND airport_code = ?');
    chk.bind([req.airlineId, code]);
    if (chk.step()) { chk.free(); return res.status(400).json({ error: 'Destination already opened' }); }
    chk.free();

    // Check balance
    const balStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    balStmt.bind([req.airlineId]);
    balStmt.step();
    const balance = balStmt.get()[0];
    balStmt.free();

    if (balance < OPEN_COST) {
      return res.status(400).json({ error: `Insufficient balance. Opening a destination costs $${OPEN_COST.toLocaleString()}.` });
    }

    // Deduct cost
    const deduct = db.prepare('UPDATE airlines SET balance = balance - ? WHERE id = ?');
    deduct.bind([OPEN_COST, req.airlineId]);
    deduct.step(); deduct.free();

    // Record transaction
    const tx = db.prepare("INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'other', ?, ?)");
    tx.bind([req.airlineId, -OPEN_COST, `Opened destination: ${code}`]);
    tx.step(); tx.free();

    // Insert destination
    const ins = db.prepare('INSERT INTO airline_destinations (airline_id, airport_code, destination_type) VALUES (?, ?, ?)');
    ins.bind([req.airlineId, code, type]);
    ins.step(); ins.free();

    // Auto-hire ground staff
    try {
      const apCatStmt = db.prepare('SELECT category FROM airports WHERE iata_code = ?');
      apCatStmt.bind([code]);
      if (apCatStmt.step()) {
        const category = apCatStmt.get()[0];
        apCatStmt.free();
        addGroundStaff(db, req.airlineId, code, category || 4, false);
      } else { apCatStmt.free(); }
    } catch (e) { console.error('Ground staff auto-hire error:', e); }

    // Get new balance
    const newBalStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    newBalStmt.bind([req.airlineId]);
    newBalStmt.step();
    const newBalance = newBalStmt.get()[0];
    newBalStmt.free();

    saveDatabase();
    res.status(201).json({ message: 'Destination opened successfully', new_balance: newBalance });
  } catch (error) {
    console.error('Open destination error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/destinations/upgrade-hub — upgrade destination to Hub for $10,000,000
router.post('/upgrade-hub', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const { airport_code } = req.body;
    if (!airport_code) return res.status(400).json({ error: 'airport_code required' });
    const code = airport_code.toUpperCase();
    const db = getDatabase();

    // Find current destination entry
    const destStmt = db.prepare('SELECT id, destination_type FROM airline_destinations WHERE airline_id = ? AND airport_code = ?');
    destStmt.bind([req.airlineId, code]);
    if (!destStmt.step()) {
      destStmt.free();
      return res.status(404).json({ error: 'Destination not found. Open it first.' });
    }
    const [destId, currentType] = destStmt.get();
    destStmt.free();

    if (currentType === 'home_base') {
      return res.status(400).json({ error: 'Home Base already has Hub privileges.' });
    }
    if (currentType === 'hub') {
      return res.status(400).json({ error: 'Already a Hub.' });
    }

    // Check balance
    const balStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    balStmt.bind([req.airlineId]);
    balStmt.step();
    const balance = balStmt.get()[0];
    balStmt.free();

    if (balance < HUB_COST) {
      return res.status(400).json({ error: `Insufficient balance. Hub upgrade costs $${HUB_COST.toLocaleString()}.` });
    }

    // Deduct cost
    const deduct = db.prepare('UPDATE airlines SET balance = balance - ? WHERE id = ?');
    deduct.bind([HUB_COST, req.airlineId]);
    deduct.step(); deduct.free();

    // Record transaction
    const tx = db.prepare("INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'other', ?, ?)");
    tx.bind([req.airlineId, -HUB_COST, `Upgraded to Hub: ${code}`]);
    tx.step(); tx.free();

    // Upgrade
    const upd = db.prepare('UPDATE airline_destinations SET destination_type = ? WHERE id = ?');
    upd.bind(['hub', destId]);
    upd.step(); upd.free();

    // Add hub bonus ground staff
    try {
      const apCatStmt2 = db.prepare('SELECT category FROM airports WHERE iata_code = ?');
      apCatStmt2.bind([code]);
      if (apCatStmt2.step()) {
        const category = apCatStmt2.get()[0];
        apCatStmt2.free();
        addGroundStaff(db, req.airlineId, code, category || 4, true);
      } else { apCatStmt2.free(); }
    } catch (e) { console.error('Hub ground staff error:', e); }

    // Get new balance
    const newBalStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    newBalStmt.bind([req.airlineId]);
    newBalStmt.step();
    const newBalance = newBalStmt.get()[0];
    newBalStmt.free();

    saveDatabase();
    res.json({ message: `${code} upgraded to Hub`, new_balance: newBalance });
  } catch (error) {
    console.error('Upgrade hub error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/destinations/:code — close/remove a destination
router.delete('/:code', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const code = req.params.code.toUpperCase();
    const db = getDatabase();

    // Find destination
    const destStmt = db.prepare('SELECT id, destination_type FROM airline_destinations WHERE airline_id = ? AND airport_code = ?');
    destStmt.bind([req.airlineId, code]);
    if (!destStmt.step()) {
      destStmt.free();
      return res.status(404).json({ error: 'Destination not found' });
    }
    const [destId, destType] = destStmt.get();
    destStmt.free();

    if (destType === 'home_base') {
      return res.status(400).json({ error: 'Cannot close your Home Base.' });
    }

    // Block deletion if any routes use this airport
    const routeStmt = db.prepare(`
      SELECT flight_number FROM routes
      WHERE airline_id = ? AND (departure_airport = ? OR arrival_airport = ?)
      ORDER BY flight_number
    `);
    routeStmt.bind([req.airlineId, code, code]);
    const activeRoutes = [];
    while (routeStmt.step()) activeRoutes.push(routeStmt.get()[0]);
    routeStmt.free();

    if (activeRoutes.length > 0) {
      return res.status(400).json({
        error: `Cannot close ${code}: active routes use this airport (${activeRoutes.join(', ')}). Delete those routes first.`
      });
    }

    // Delete
    const del = db.prepare('DELETE FROM airline_destinations WHERE id = ?');
    del.bind([destId]);
    del.step(); del.free();

    saveDatabase();
    res.json({ message: `Destination ${code} closed` });
  } catch (error) {
    console.error('Delete destination error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
