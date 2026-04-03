import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

const COCKPIT_COUNT = 4;
const COCKPIT_WAGE  = 3500;
const CABIN_WAGE    = 1200;
const GROUND_WAGE   = 950;

const GROUND_STAFF_BY_CAT = { 1: 2, 2: 4, 3: 7, 4: 10, 5: 14, 6: 18, 7: 22, 8: 25 };

// Calculate ground staff count based on destination type and context
export function calcGroundStaff(category, destType, weeklyFlights = 0, expansionLevel = 0) {
  const base = GROUND_STAFF_BY_CAT[category] || 10;
  if (destType === 'home_base') {
    return base + 10 + Math.floor(weeklyFlights / 2500) * 15;
  }
  if (expansionLevel > 0) {
    return base + expansionLevel * 2;
  }
  return base;
}

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
 * Returns how many were consumed.
 * For cockpit: pass typeRating to only consume matching pilots.
 */
async function consumeOrphanedStaff(airlineId, staffType, needed, typeRating = null) {
  let orphanedRows;
  if (staffType === 'ground') {
    const result = await pool.query(`
      SELECT id, count FROM personnel
      WHERE airline_id = $1 AND staff_type = 'ground'
        AND airport_code NOT IN (SELECT airport_code FROM airline_destinations WHERE airline_id = $1)
      ORDER BY count DESC
    `, [airlineId]);
    orphanedRows = result.rows;
  } else {
    let result;
    if (typeRating) {
      result = await pool.query(
        `SELECT id, count FROM personnel WHERE airline_id = $1 AND staff_type = $2 AND type_rating = $3 AND (aircraft_id IS NULL OR aircraft_id NOT IN (SELECT id FROM aircraft WHERE airline_id = $1 AND is_active = 1)) ORDER BY count DESC`,
        [airlineId, staffType, typeRating]
      );
    } else {
      result = await pool.query(
        `SELECT id, count FROM personnel WHERE airline_id = $1 AND staff_type = $2 AND (aircraft_id IS NULL OR aircraft_id NOT IN (SELECT id FROM aircraft WHERE airline_id = $1 AND is_active = 1)) ORDER BY count DESC`,
        [airlineId, staffType]
      );
    }
    orphanedRows = result.rows;
  }

  let remaining = needed;
  for (const row of orphanedRows) {
    if (remaining <= 0) break;
    if (row.count <= remaining) {
      await pool.query('DELETE FROM personnel WHERE id = $1', [row.id]);
      remaining -= row.count;
    } else {
      await pool.query('UPDATE personnel SET count = count - $1 WHERE id = $2', [remaining, row.id]);
      remaining = 0;
    }
  }
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
router.get('/', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.json({ ground: [], cabin: [], cockpit: [] });
  try {
    // Ground staff
    const gResult = await pool.query(`
      SELECT p.airport_code, ap.name as airport_name, p.count, p.weekly_wage_per_person
      FROM personnel p
      LEFT JOIN airports ap ON ap.iata_code = p.airport_code
      WHERE p.airline_id = $1 AND p.staff_type = 'ground'
      ORDER BY ap.name
    `, [req.airlineId]);
    const ground = gResult.rows.map(r => ({
      airport_code: r.airport_code, airport_name: r.airport_name,
      count: r.count, weekly_wage_per_person: r.weekly_wage_per_person
    }));

    // Undeployed ground staff
    const ugResult = await pool.query(`
      SELECT COALESCE(SUM(p.count), 0) as total
      FROM personnel p
      WHERE p.airline_id = $1 AND p.staff_type = 'ground'
        AND p.airport_code NOT IN (
          SELECT airport_code FROM airline_destinations WHERE airline_id = $1
        )
    `, [req.airlineId]);
    const undeployed_ground = parseInt(ugResult.rows[0].total) || 0;

    // Cabin crew
    const cResult = await pool.query(`
      SELECT p.aircraft_id, ac.registration, p.count, p.weekly_wage_per_person
      FROM personnel p
      LEFT JOIN aircraft ac ON ac.id = p.aircraft_id
      WHERE p.airline_id = $1 AND p.staff_type = 'cabin'
      ORDER BY ac.registration
    `, [req.airlineId]);
    const cabin = cResult.rows.map(r => ({
      aircraft_id: r.aircraft_id, registration: r.registration,
      count: r.count, weekly_wage_per_person: r.weekly_wage_per_person
    }));

    // Undeployed cabin crew
    const ucResult = await pool.query(`
      SELECT COALESCE(SUM(p.count), 0) as total
      FROM personnel p
      WHERE p.airline_id = $1 AND p.staff_type = 'cabin'
        AND (p.aircraft_id IS NULL OR p.aircraft_id NOT IN (
          SELECT id FROM aircraft WHERE airline_id = $1 AND is_active = 1
        ))
    `, [req.airlineId]);
    const undeployed_cabin = parseInt(ucResult.rows[0].total) || 0;

    // Cockpit crew grouped by type rating
    const kResult = await pool.query(`
      SELECT p.aircraft_id, ac.registration, at.manufacturer, at.model, p.count, p.weekly_wage_per_person, p.type_rating
      FROM personnel p
      LEFT JOIN aircraft ac ON ac.id = p.aircraft_id
      LEFT JOIN aircraft_types at ON at.id = ac.aircraft_type_id
      WHERE p.airline_id = $1 AND p.staff_type = 'cockpit'
    `, [req.airlineId]);
    const cockpitByRating = {};
    for (const r of kResult.rows) {
      const rating = r.manufacturer ? getTypeRating(r.manufacturer, r.model) : (r.type_rating || 'Unassigned');
      if (!cockpitByRating[rating]) cockpitByRating[rating] = { type_rating: rating, count: 0, weekly_wage_per_person: r.weekly_wage_per_person };
      cockpitByRating[rating].count += r.count;
    }

    // Undeployed cockpit crew
    const ukResult = await pool.query(`
      SELECT COALESCE(SUM(p.count), 0) as total
      FROM personnel p
      WHERE p.airline_id = $1 AND p.staff_type = 'cockpit'
        AND (p.aircraft_id IS NULL OR p.aircraft_id NOT IN (
          SELECT id FROM aircraft WHERE airline_id = $1 AND is_active = 1
        ))
    `, [req.airlineId]);
    const undeployed_cockpit = parseInt(ukResult.rows[0].total) || 0;

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
    // Verify aircraft belongs to airline
    const acResult = await pool.query(`
      SELECT ac.id, ac.crew_assigned, ac.airline_cabin_profile_id,
             at.manufacturer, at.model
      FROM aircraft ac
      JOIN aircraft_types at ON at.id = ac.aircraft_type_id
      WHERE ac.id = $1 AND ac.airline_id = $2
    `, [aircraftId, req.airlineId]);
    if (!acResult.rows[0]) return res.status(404).json({ error: 'Aircraft not found' });
    const acRow = acResult.rows[0];
    const { crew_assigned: crewAssigned, airline_cabin_profile_id: cabinProfileId, manufacturer, model } = acRow;

    if (crewAssigned) return res.status(400).json({ error: 'Crew already assigned' });
    if (!cabinProfileId) return res.status(400).json({ error: 'Assign a cabin profile first' });

    // Get cabin classes to compute cabin crew count
    const clsResult = await pool.query(
      'SELECT class_type, actual_capacity FROM airline_cabin_classes WHERE profile_id = $1',
      [cabinProfileId]
    );
    const classes = clsResult.rows.map(r => ({ class_type: r.class_type, actual_capacity: r.actual_capacity }));

    const cabinCount = calcCabinCrew(classes);
    const typeRating = getTypeRating(manufacturer, model);

    // Use orphaned cabin crew first, then assign new record
    await consumeOrphanedStaff(req.airlineId, 'cabin', cabinCount);
    await pool.query(
      'INSERT INTO personnel (airline_id, staff_type, aircraft_id, count, weekly_wage_per_person, type_rating) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.airlineId, 'cabin', aircraftId, cabinCount, CABIN_WAGE, typeRating]
    );

    // Use orphaned cockpit crew of same type rating first, then assign new record
    await consumeOrphanedStaff(req.airlineId, 'cockpit', COCKPIT_COUNT, typeRating);
    await pool.query(
      'INSERT INTO personnel (airline_id, staff_type, aircraft_id, count, weekly_wage_per_person, type_rating) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.airlineId, 'cockpit', aircraftId, COCKPIT_COUNT, COCKPIT_WAGE, typeRating]
    );

    // Mark aircraft as crew assigned
    await pool.query('UPDATE aircraft SET crew_assigned = 1 WHERE id = $1', [aircraftId]);

    res.json({ message: 'Crew hired and assigned', cabin_count: cabinCount, cockpit_count: COCKPIT_COUNT });
  } catch (err) {
    console.error('Personnel hire error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/personnel/dismiss/:aircraft_id — dismiss crew
router.delete('/dismiss/:aircraft_id', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  const aircraftId = parseInt(req.params.aircraft_id);
  try {
    // Verify ownership
    const chkResult = await pool.query(
      'SELECT id FROM aircraft WHERE id = $1 AND airline_id = $2',
      [aircraftId, req.airlineId]
    );
    if (!chkResult.rows[0]) return res.status(404).json({ error: 'Aircraft not found' });

    await pool.query(
      "DELETE FROM personnel WHERE airline_id = $1 AND aircraft_id = $2 AND staff_type IN ('cabin', 'cockpit')",
      [req.airlineId, aircraftId]
    );

    await pool.query(
      'UPDATE aircraft SET crew_assigned = 0, is_active = 0 WHERE id = $1',
      [aircraftId]
    );

    res.json({ message: 'Crew dismissed', is_active: 0 });
  } catch (err) {
    console.error('Personnel dismiss error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/personnel/dismiss-undeployed/:type — dismiss staff with no active deployment
router.delete('/dismiss-undeployed/:type', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  const type = req.params.type;
  if (!['ground', 'cabin', 'cockpit'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  try {
    if (type === 'ground') {
      await pool.query(`
        DELETE FROM personnel
        WHERE airline_id = $1 AND staff_type = 'ground'
          AND airport_code NOT IN (
            SELECT airport_code FROM airline_destinations WHERE airline_id = $1
          )
      `, [req.airlineId]);
    } else {
      await pool.query(`
        DELETE FROM personnel
        WHERE airline_id = $1 AND staff_type = $2
          AND (aircraft_id IS NULL OR aircraft_id NOT IN (
            SELECT id FROM aircraft WHERE airline_id = $1 AND is_active = 1
          ))
      `, [req.airlineId, type]);
    }
    res.json({ message: 'Undeployed staff dismissed' });
  } catch (err) {
    console.error('dismiss-undeployed error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Payroll processor ────────────────────────────────────────────────────────

async function processPayroll() {
  try {
    // Airlines where payroll is due: last_payroll_at IS NULL or >= 7 days ago
    const dueResult = await pool.query(`
      SELECT id, name, balance
      FROM airlines
      WHERE last_payroll_at IS NULL
         OR last_payroll_at + INTERVAL '7 days' <= NOW()
    `);

    if (dueResult.rows.length === 0) return;

    let processed = 0;
    for (const airline of dueResult.rows) {
      // Sum all weekly personnel costs for this airline
      const costResult = await pool.query(`
        SELECT COALESCE(SUM(count * weekly_wage_per_person), 0) as total
        FROM personnel
        WHERE airline_id = $1
      `, [airline.id]);
      const totalCost = Math.round(parseFloat(costResult.rows[0].total) || 0);

      // Always update last_payroll_at, even if cost is 0
      await pool.query(
        'UPDATE airlines SET last_payroll_at = NOW(), balance = balance - $1 WHERE id = $2',
        [totalCost, airline.id]
      );

      if (totalCost > 0) {
        await pool.query(
          "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'other', $2, $3)",
          [airline.id, -totalCost, `Wöchentliche Personalkosten`]
        );
        console.log(`[Payroll] ${airline.name}: -$${totalCost.toLocaleString()} weekly payroll`);
      }
      processed++;
    }

    if (processed > 0) console.log(`[Payroll] Processed ${processed} airline(s)`);
  } catch (err) {
    console.error('processPayroll error:', err);
  }
}

export function startPayrollProcessor() {
  // Run immediately on start (triggers for airlines with last_payroll_at = NULL)
  processPayroll();
  // Schedule re-checks at :13 each hour; only deducts when >= 7 days have passed
  const now = new Date();
  let minsUntil = (13 - now.getMinutes() + 60) % 60;
  if (minsUntil === 0) minsUntil = 60;
  const msUntil = minsUntil * 60000 - now.getSeconds() * 1000 - now.getMilliseconds();
  setTimeout(() => {
    processPayroll();
    setInterval(processPayroll, 60 * 60 * 1000);
  }, msUntil);
  console.log(`[Payroll] Payroll processor started — next check in ${Math.round(msUntil / 60000)} min (at :13)`);
}

// Upsert ground staff for an airport with a specific count
export async function addGroundStaff(airlineId, airportCode, category, destType = 'destination', weeklyFlights = 0, expansionLevel = 0) {
  const count = calcGroundStaff(category, destType, weeklyFlights, expansionLevel);

  const existing = await pool.query(
    "SELECT id, count FROM personnel WHERE airline_id = $1 AND staff_type = 'ground' AND airport_code = $2",
    [airlineId, airportCode]
  );

  if (existing.rows[0]) {
    await pool.query('UPDATE personnel SET count = $1 WHERE id = $2', [count, existing.rows[0].id]);
  } else {
    await consumeOrphanedStaff(airlineId, 'ground', count);
    await pool.query(
      'INSERT INTO personnel (airline_id, staff_type, airport_code, count, weekly_wage_per_person) VALUES ($1, $2, $3, $4, $5)',
      [airlineId, 'ground', airportCode, count, GROUND_WAGE]
    );
  }
}

export default router;
