import express from 'express';
import { getDatabase, saveDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

const COCKPIT_COUNT = 4;
const COCKPIT_WAGE  = 3500;
const CABIN_WAGE    = 1200;
const GROUND_WAGE   = 950;
const HUB_BONUS = 20;

const GROUND_STAFF_BY_CAT = { 1: 2, 2: 4, 3: 7, 4: 10, 5: 14, 6: 18, 7: 22, 8: 25 };

const CABIN_CREW_RATIOS = {
  economy: 30,
  premium_economy: 30,
  business: 12,
  first: 6,
  first_suite: 4,
};

function getTypeRating(manufacturer, model) {
  const mfr = (manufacturer || '').toUpperCase();
  const mod = (model || '').toUpperCase();
  if (mfr.includes('AIRBUS')) {
    if (mod.includes('318') || mod.includes('319') || mod.includes('320') || mod.includes('321')) return 'Airbus A320 Family';
    if (mod.includes('330')) return 'Airbus A330';
    if (mod.includes('340')) return 'Airbus A340';
    if (mod.includes('350')) return 'Airbus A350';
    if (mod.includes('380')) return 'Airbus A380';
  }
  if (mfr.includes('BOEING')) {
    if (mod.includes('737')) return 'Boeing 737';
    if (mod.includes('747')) return 'Boeing 747';
    if (mod.includes('757')) return 'Boeing 757';
    if (mod.includes('767')) return 'Boeing 767';
    if (mod.includes('777')) return 'Boeing 777';
    if (mod.includes('787')) return 'Boeing 787';
  }
  if (mfr.includes('BOMBARDIER') || mod.includes('CRJ')) return 'Bombardier CRJ';
  if (mfr.includes('EMBRAER') || mod.startsWith('E17') || mod.startsWith('E19') || mod.includes('ERJ')) {
    if (mod.includes('-E2') || (mod.includes('E2') && !mod.match(/E1[79]/))) return 'Embraer E2-Jet';
    if (mod.includes('ERJ')) return 'Embraer ERJ';
    return 'Embraer E-Jet';
  }
  if (mfr.includes('ATR')) return 'ATR';
  return `${manufacturer} ${model}`;
}

/**
 * Consume up to `needed` staff from orphaned records of the given type.
 * Returns how many were available (so caller knows how many are still needed).
 * For cockpit: pass typeRating to only consume matching pilots.
 * Deletes/reduces orphaned records in-place.
 */
function consumeOrphanedStaff(db, airlineId, staffType, needed, typeRating = null) {
  let orphanedRows;
  if (staffType === 'ground') {
    const s = db.prepare(`
      SELECT id, count FROM personnel
      WHERE airline_id = ? AND staff_type = 'ground'
        AND airport_code NOT IN (SELECT airport_code FROM airline_destinations WHERE airline_id = ?)
      ORDER BY count DESC
    `);
    s.bind([airlineId, airlineId]);
    orphanedRows = [];
    while (s.step()) { const r = s.get(); orphanedRows.push({ id: r[0], count: r[1] }); }
    s.free();
  } else {
    const s = typeRating
      ? db.prepare(`SELECT id, count FROM personnel WHERE airline_id = ? AND staff_type = ? AND type_rating = ? AND (aircraft_id IS NULL OR aircraft_id NOT IN (SELECT id FROM aircraft WHERE airline_id = ? AND is_active = 1)) ORDER BY count DESC`)
      : db.prepare(`SELECT id, count FROM personnel WHERE airline_id = ? AND staff_type = ? AND (aircraft_id IS NULL OR aircraft_id NOT IN (SELECT id FROM aircraft WHERE airline_id = ? AND is_active = 1)) ORDER BY count DESC`);
    typeRating ? s.bind([airlineId, staffType, typeRating, airlineId]) : s.bind([airlineId, staffType, airlineId]);
    orphanedRows = [];
    while (s.step()) { const r = s.get(); orphanedRows.push({ id: r[0], count: r[1] }); }
    s.free();
  }

  let remaining = needed;
  for (const row of orphanedRows) {
    if (remaining <= 0) break;
    if (row.count <= remaining) {
      const d = db.prepare('DELETE FROM personnel WHERE id = ?');
      d.bind([row.id]); d.step(); d.free();
      remaining -= row.count;
    } else {
      const u = db.prepare('UPDATE personnel SET count = count - ? WHERE id = ?');
      u.bind([remaining, row.id]); u.step(); u.free();
      remaining = 0;
    }
  }
  // Returns how many were consumed (needed - remaining)
  return needed - remaining;
}

function calcCabinCrew(classes) {
  if (!classes || classes.length === 0) return 5;
  let total = 0;
  for (const cls of classes) {
    const ratio = CABIN_CREW_RATIOS[cls.class_type] || 50;
    total += Math.ceil((cls.actual_capacity || 0) / ratio);
  }
  return Math.max(3, Math.min(30, total));
}

// GET /api/personnel — summary
router.get('/', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.json({ ground: [], cabin: [], cockpit: [] });
  try {
    const db = getDatabase();

    // Ground staff
    const gStmt = db.prepare(`
      SELECT p.airport_code, ap.name as airport_name, p.count, p.weekly_wage_per_person
      FROM personnel p
      LEFT JOIN airports ap ON ap.iata_code = p.airport_code
      WHERE p.airline_id = ? AND p.staff_type = 'ground'
      ORDER BY ap.name
    `);
    gStmt.bind([req.airlineId]);
    const ground = [];
    while (gStmt.step()) {
      const r = gStmt.get();
      ground.push({ airport_code: r[0], airport_name: r[1], count: r[2], weekly_wage_per_person: r[3] });
    }
    gStmt.free();

    // Undeployed ground staff: airport no longer in airline_destinations
    const ugStmt = db.prepare(`
      SELECT COALESCE(SUM(p.count), 0)
      FROM personnel p
      WHERE p.airline_id = ? AND p.staff_type = 'ground'
        AND p.airport_code NOT IN (
          SELECT airport_code FROM airline_destinations WHERE airline_id = ?
        )
    `);
    ugStmt.bind([req.airlineId, req.airlineId]);
    ugStmt.step();
    const undeployed_ground = ugStmt.get()[0] || 0;
    ugStmt.free();

    // Cabin crew (LEFT JOIN so aircraft_id = NULL undeployed pool is included)
    const cStmt = db.prepare(`
      SELECT p.aircraft_id, ac.registration, p.count, p.weekly_wage_per_person
      FROM personnel p
      LEFT JOIN aircraft ac ON ac.id = p.aircraft_id
      WHERE p.airline_id = ? AND p.staff_type = 'cabin'
      ORDER BY ac.registration
    `);
    cStmt.bind([req.airlineId]);
    const cabin = [];
    while (cStmt.step()) {
      const r = cStmt.get();
      cabin.push({ aircraft_id: r[0], registration: r[1], count: r[2], weekly_wage_per_person: r[3] });
    }
    cStmt.free();

    // Undeployed cabin crew: aircraft not in fleet OR aircraft inactive (is_active = 0)
    const ucStmt = db.prepare(`
      SELECT COALESCE(SUM(p.count), 0)
      FROM personnel p
      WHERE p.airline_id = ? AND p.staff_type = 'cabin'
        AND (p.aircraft_id IS NULL OR p.aircraft_id NOT IN (
          SELECT id FROM aircraft WHERE airline_id = ? AND is_active = 1
        ))
    `);
    ucStmt.bind([req.airlineId, req.airlineId]);
    ucStmt.step();
    const undeployed_cabin = ucStmt.get()[0] || 0;
    ucStmt.free();

    // Cockpit crew grouped by type rating (LEFT JOINs so aircraft_id = NULL pool is included)
    const kStmt = db.prepare(`
      SELECT p.aircraft_id, ac.registration, at.manufacturer, at.model, p.count, p.weekly_wage_per_person, p.type_rating
      FROM personnel p
      LEFT JOIN aircraft ac ON ac.id = p.aircraft_id
      LEFT JOIN aircraft_types at ON at.id = ac.aircraft_type_id
      WHERE p.airline_id = ? AND p.staff_type = 'cockpit'
    `);
    kStmt.bind([req.airlineId]);
    const cockpitByRating = {};
    while (kStmt.step()) {
      const r = kStmt.get();
      // Use derived rating when aircraft exists, fall back to stored type_rating for unassigned pool
      const rating = r[2] ? getTypeRating(r[2], r[3]) : (r[6] || 'Unassigned');
      if (!cockpitByRating[rating]) cockpitByRating[rating] = { type_rating: rating, count: 0, weekly_wage_per_person: r[5] };
      cockpitByRating[rating].count += r[4];
    }
    kStmt.free();

    // Undeployed cockpit crew: aircraft not in fleet OR aircraft inactive
    const ukStmt = db.prepare(`
      SELECT COALESCE(SUM(p.count), 0)
      FROM personnel p
      WHERE p.airline_id = ? AND p.staff_type = 'cockpit'
        AND (p.aircraft_id IS NULL OR p.aircraft_id NOT IN (
          SELECT id FROM aircraft WHERE airline_id = ? AND is_active = 1
        ))
    `);
    ukStmt.bind([req.airlineId, req.airlineId]);
    ukStmt.step();
    const undeployed_cockpit = ukStmt.get()[0] || 0;
    ukStmt.free();

    res.json({
      ground,
      cabin,
      cockpit: Object.values(cockpitByRating).sort((a, b) => a.type_rating.localeCompare(b.type_rating)),
      undeployed_ground,
      undeployed_cabin,
      undeployed_cockpit,
    });
  } catch (err) {
    console.error('Personnel GET error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/personnel/hire/:aircraft_id — hire cabin + cockpit crew
router.post('/hire/:aircraft_id', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  const aircraftId = parseInt(req.params.aircraft_id);
  try {
    const db = getDatabase();

    // Verify aircraft belongs to airline
    const acStmt = db.prepare(`
      SELECT ac.id, ac.crew_assigned, ac.airline_cabin_profile_id,
             at.manufacturer, at.model
      FROM aircraft ac
      JOIN aircraft_types at ON at.id = ac.aircraft_type_id
      WHERE ac.id = ? AND ac.airline_id = ?
    `);
    acStmt.bind([aircraftId, req.airlineId]);
    if (!acStmt.step()) { acStmt.free(); return res.status(404).json({ error: 'Aircraft not found' }); }
    const acRow = acStmt.get();
    acStmt.free();
    const [, crewAssigned, cabinProfileId, manufacturer, model] = acRow;

    if (crewAssigned) return res.status(400).json({ error: 'Crew already assigned' });
    if (!cabinProfileId) return res.status(400).json({ error: 'Assign a cabin profile first' });

    // Get cabin classes to compute cabin crew count
    const clsStmt = db.prepare(`
      SELECT class_type, actual_capacity FROM airline_cabin_classes WHERE profile_id = ?
    `);
    clsStmt.bind([cabinProfileId]);
    const classes = [];
    while (clsStmt.step()) {
      const r = clsStmt.get();
      classes.push({ class_type: r[0], actual_capacity: r[1] });
    }
    clsStmt.free();

    const cabinCount = calcCabinCrew(classes);
    const typeRating = getTypeRating(manufacturer, model);

    // Use orphaned cabin crew first (not type-specific), then hire the rest
    consumeOrphanedStaff(db, req.airlineId, 'cabin', cabinCount);
    const insC = db.prepare(`
      INSERT OR REPLACE INTO personnel (airline_id, staff_type, aircraft_id, count, weekly_wage_per_person, type_rating)
      VALUES (?, 'cabin', ?, ?, ?, ?)
    `);
    insC.bind([req.airlineId, aircraftId, cabinCount, CABIN_WAGE, typeRating]);
    insC.step(); insC.free();

    // Use orphaned cockpit crew of same type rating first, then hire the rest
    consumeOrphanedStaff(db, req.airlineId, 'cockpit', COCKPIT_COUNT, typeRating);
    const insK = db.prepare(`
      INSERT OR REPLACE INTO personnel (airline_id, staff_type, aircraft_id, count, weekly_wage_per_person, type_rating)
      VALUES (?, 'cockpit', ?, ?, ?, ?)
    `);
    insK.bind([req.airlineId, aircraftId, COCKPIT_COUNT, COCKPIT_WAGE, typeRating]);
    insK.step(); insK.free();

    // Mark aircraft as crew assigned
    const upd = db.prepare('UPDATE aircraft SET crew_assigned = 1 WHERE id = ?');
    upd.bind([aircraftId]);
    upd.step(); upd.free();

    saveDatabase();
    res.json({ message: 'Crew hired and assigned', cabin_count: cabinCount, cockpit_count: COCKPIT_COUNT });
  } catch (err) {
    console.error('Personnel hire error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/personnel/dismiss/:aircraft_id — dismiss crew
router.delete('/dismiss/:aircraft_id', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  const aircraftId = parseInt(req.params.aircraft_id);
  try {
    const db = getDatabase();

    // Verify ownership
    const chk = db.prepare('SELECT id FROM aircraft WHERE id = ? AND airline_id = ?');
    chk.bind([aircraftId, req.airlineId]);
    if (!chk.step()) { chk.free(); return res.status(404).json({ error: 'Aircraft not found' }); }
    chk.free();

    const del = db.prepare("DELETE FROM personnel WHERE airline_id = ? AND aircraft_id = ? AND staff_type IN ('cabin', 'cockpit')");
    del.bind([req.airlineId, aircraftId]);
    del.step(); del.free();

    const upd = db.prepare('UPDATE aircraft SET crew_assigned = 0, is_active = 0 WHERE id = ?');
    upd.bind([aircraftId]);
    upd.step(); upd.free();

    saveDatabase();
    res.json({ message: 'Crew dismissed', is_active: 0 });
  } catch (err) {
    console.error('Personnel dismiss error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/personnel/dismiss-undeployed/:type — dismiss staff with no active deployment
router.delete('/dismiss-undeployed/:type', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  const type = req.params.type;
  if (!['ground', 'cabin', 'cockpit'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  try {
    const db = getDatabase();
    let del;
    if (type === 'ground') {
      del = db.prepare(`
        DELETE FROM personnel
        WHERE airline_id = ? AND staff_type = 'ground'
          AND airport_code NOT IN (
            SELECT airport_code FROM airline_destinations WHERE airline_id = ?
          )
      `);
      del.bind([req.airlineId, req.airlineId]);
    } else {
      // Delete undeployed staff: aircraft_id IS NULL (pool) or aircraft is inactive
      del = db.prepare(`
        DELETE FROM personnel
        WHERE airline_id = ? AND staff_type = ?
          AND (aircraft_id IS NULL OR aircraft_id NOT IN (
            SELECT id FROM aircraft WHERE airline_id = ? AND is_active = 1
          ))
      `);
      del.bind([req.airlineId, type, req.airlineId]);
    }
    del.step(); del.free();
    saveDatabase();
    res.json({ message: 'Undeployed staff dismissed' });
  } catch (err) {
    console.error('dismiss-undeployed error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Payroll processor ────────────────────────────────────────────────────────

function processPayroll() {
  try {
    const db = getDatabase();
    if (!db) return;

    // Airlines where payroll is due: last_payroll_at IS NULL or >= 7 days ago
    const dueStmt = db.prepare(`
      SELECT id, name, balance
      FROM airlines
      WHERE last_payroll_at IS NULL
         OR datetime(last_payroll_at, '+7 days') <= datetime('now')
    `);
    const dueAirlines = [];
    while (dueStmt.step()) {
      const r = dueStmt.get();
      dueAirlines.push({ id: r[0], name: r[1], balance: r[2] });
    }
    dueStmt.free();

    if (dueAirlines.length === 0) return;

    let processed = 0;
    for (const airline of dueAirlines) {
      // Sum all weekly personnel costs for this airline
      const costStmt = db.prepare(`
        SELECT COALESCE(SUM(count * weekly_wage_per_person), 0)
        FROM personnel
        WHERE airline_id = ?
      `);
      costStmt.bind([airline.id]);
      costStmt.step();
      const totalCost = Math.round(costStmt.get()[0] || 0);
      costStmt.free();

      // Always update last_payroll_at, even if cost is 0
      const updStmt = db.prepare(
        "UPDATE airlines SET last_payroll_at = datetime('now'), balance = balance - ? WHERE id = ?"
      );
      updStmt.bind([totalCost, airline.id]);
      updStmt.step();
      updStmt.free();

      if (totalCost > 0) {
        const txStmt = db.prepare(
          "INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'other', ?, ?)"
        );
        txStmt.bind([airline.id, -totalCost, `Wöchentliche Personalkosten`]);
        txStmt.step();
        txStmt.free();
        console.log(`[Payroll] ${airline.name}: -$${totalCost.toLocaleString()} weekly payroll`);
      }
      processed++;
    }

    if (processed > 0) saveDatabase();
  } catch (err) {
    console.error('processPayroll error:', err);
  }
}

export function startPayrollProcessor() {
  // Run immediately on start (triggers for airlines with last_payroll_at = NULL)
  processPayroll();
  // Re-check every hour; only deducts when >= 7 days have passed
  setInterval(processPayroll, 60 * 60 * 1000);
  console.log('[Payroll] Payroll processor started (weekly, check interval: 1h)');
}

// POST /api/personnel/ground — add/update ground staff for an airport (internal helper, called by destinations)
export function addGroundStaff(db, airlineId, airportCode, category, isMegaHub = false) {
  const baseCount = GROUND_STAFF_BY_CAT[category] || 10;
  const count = isMegaHub ? baseCount + HUB_BONUS : baseCount;

  const existing = db.prepare('SELECT id, count FROM personnel WHERE airline_id = ? AND staff_type = ? AND airport_code = ?');
  existing.bind([airlineId, 'ground', airportCode]);
  if (existing.step()) {
    const row = existing.get();
    existing.free();
    if (isMegaHub && row[1] < count) {
      const extra = count - row[1];
      // Use orphaned ground staff first before adding net-new headcount
      consumeOrphanedStaff(db, airlineId, 'ground', extra);
      const upd = db.prepare('UPDATE personnel SET count = ? WHERE id = ?');
      upd.bind([count, row[0]]);
      upd.step(); upd.free();
    }
  } else {
    existing.free();
    // Use orphaned ground staff first
    consumeOrphanedStaff(db, airlineId, 'ground', count);
    const ins = db.prepare('INSERT INTO personnel (airline_id, staff_type, airport_code, count, weekly_wage_per_person) VALUES (?, ?, ?, ?, ?)');
    ins.bind([airlineId, 'ground', airportCode, count, GROUND_WAGE]);
    ins.step(); ins.free();
  }
}

export default router;
