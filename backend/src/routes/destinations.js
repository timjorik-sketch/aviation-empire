import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';
import { addGroundStaff, calcGroundStaff } from './personnel.js';
import { DEPARTURES_PER_LEVEL, SECONDARY_HUB_LEVEL, getTotalCostForLevel } from './expansions.js';

export const PRIMARY_HUB_LEVEL = 8;

const router = express.Router();

const OPEN_COST  = 10_000;

// Ensure home base destination exists (lazy init)
async function ensureHomeBase(airlineId) {
  const s = await pool.query('SELECT home_airport_code FROM airlines WHERE id = $1', [airlineId]);
  if (!s.rows[0]) return;
  const homeCode = s.rows[0].home_airport_code;

  const c = await pool.query(
    'SELECT id FROM airline_destinations WHERE airline_id = $1 AND airport_code = $2',
    [airlineId, homeCode]
  );
  if (!c.rows[0]) {
    await pool.query(
      'INSERT INTO airline_destinations (airline_id, airport_code, destination_type) VALUES ($1, $2, $3)',
      [airlineId, homeCode, 'home_base']
    );
  }
}

function effectiveType(destType) {
  return destType;
}

// GET /api/destinations
router.get('/', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.json({ destinations: [] });
  try {
    await ensureHomeBase(req.airlineId);

    const airlineRes = await pool.query('SELECT home_airport_code, primary_hub_airport_code FROM airlines WHERE id = $1', [req.airlineId]);
    const homeCode = airlineRes.rows[0]?.home_airport_code ?? null;
    const primaryHubCode = airlineRes.rows[0]?.primary_hub_airport_code ?? null;

    const result = await pool.query(`
      SELECT d.id, d.airport_code, d.destination_type, d.opened_at,
             ap.name, ap.country, ap.continent, ap.category,
             (SELECT COUNT(*) FROM weekly_schedule ws
              JOIN aircraft ac ON ws.aircraft_id = ac.id
              WHERE ac.airline_id = d.airline_id
              AND (ws.departure_airport = d.airport_code OR ws.arrival_airport = d.airport_code)
             ) AS weekly_flights,
             (SELECT COUNT(*) FROM routes r
              WHERE r.airline_id = d.airline_id
              AND (r.departure_airport = d.airport_code OR r.arrival_airport = d.airport_code)
             ) AS routes_count,
             COALESCE((SELECT ae.expansion_level FROM airport_expansions ae
              WHERE ae.airline_id = d.airline_id AND ae.airport_code = d.airport_code
             ), 0) AS expansion_level
      FROM airline_destinations d
      JOIN airports ap ON d.airport_code = ap.iata_code
      WHERE d.airline_id = $1
      ORDER BY
        CASE
          WHEN d.destination_type = 'home_base' THEN 0
          WHEN d.airport_code = $2 THEN 1
          WHEN d.destination_type = 'hub' THEN 2
          WHEN d.destination_type = 'hub_restricted' THEN 3
          ELSE 4
        END, ap.name ASC
    `, [req.airlineId, primaryHubCode || '']);

    const destinations = result.rows.map(r => {
      const wf = parseInt(r.weekly_flights) || 0;
      const rc = parseInt(r.routes_count) || 0;
      const dtype = r.destination_type;
      const expansionLevel = parseInt(r.expansion_level) || 0;
      const hasExpansion = expansionLevel > 0;
      const isPrimaryHub = primaryHubCode && r.airport_code === primaryHubCode;
      const groundStaff = calcGroundStaff(r.category, dtype, wf, expansionLevel);
      const displayType = dtype === 'home_base' ? 'home_base'
        : isPrimaryHub ? 'primary_hub'
        : hasExpansion ? 'hub_restricted'
        : dtype;
      return {
        id: r.id, airport_code: r.airport_code, destination_type: dtype,
        display_type: displayType,
        effective_type: effectiveType(displayType),
        opened_at: r.opened_at, airport_name: r.name, country: r.country,
        continent: r.continent, category: r.category, weekly_flights: wf,
        routes_count: rc,
        ground_staff: groundStaff, has_expansion: hasExpansion, expansion_level: expansionLevel,
        is_primary_hub: !!isPrimaryHub
      };
    });
    // Sync personnel table so payroll reflects the current calculated counts
    for (const d of destinations) {
      addGroundStaff(req.airlineId, d.airport_code, d.category, d.destination_type, d.weekly_flights, d.expansion_level).catch(() => {});
    }
    res.json({
      destinations,
      home_airport_code: homeCode,
      primary_hub_airport_code: primaryHubCode
    });
  } catch (error) {
    console.error('Get destinations error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/destinations/opened — all opened airports (for home base selection dropdowns)
router.get('/opened', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.json({ airports: [] });
  try {
    await ensureHomeBase(req.airlineId);

    const result = await pool.query(`
      SELECT ap.iata_code, ap.name, ap.country, d.destination_type
      FROM airline_destinations d
      JOIN airports ap ON d.airport_code = ap.iata_code
      WHERE d.airline_id = $1
      ORDER BY ap.country, ap.name
    `, [req.airlineId]);

    const airports = result.rows.map(r => ({
      iata_code: r.iata_code, name: r.name, country: r.country, destination_type: r.destination_type
    }));
    res.json({ airports });
  } catch (error) {
    console.error('Get opened destinations error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/destinations/available
router.get('/available', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.json({ airports: [] });
  try {
    const result = await pool.query(`
      SELECT ap.iata_code, ap.name, ap.country, ap.continent, ap.category
      FROM airports ap
      WHERE ap.iata_code NOT IN (
        SELECT airport_code FROM airline_destinations WHERE airline_id = $1
      )
      ORDER BY ap.continent, ap.country, ap.name
    `, [req.airlineId]);
    const airports = result.rows.map(r => ({
      iata_code: r.iata_code, name: r.name, country: r.country,
      continent: r.continent, category: r.category
    }));
    res.json({ airports });
  } catch (error) {
    console.error('Get available destinations error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/destinations/open — open a destination for $50,000
router.post('/open', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const { airport_code, destination_type = 'destination' } = req.body;
    if (!airport_code) return res.status(400).json({ error: 'airport_code required' });
    const code = airport_code.toUpperCase();
    const validTypes = ['home_base', 'hub', 'base', 'destination'];
    const type = validTypes.includes(destination_type) ? destination_type : 'destination';

    // Verify airport
    const apResult = await pool.query('SELECT iata_code FROM airports WHERE iata_code = $1', [code]);
    if (!apResult.rows[0]) return res.status(404).json({ error: 'Airport not found' });

    // Check not already opened
    const chkResult = await pool.query(
      'SELECT id FROM airline_destinations WHERE airline_id = $1 AND airport_code = $2',
      [req.airlineId, code]
    );
    if (chkResult.rows[0]) return res.status(400).json({ error: 'Destination already opened' });

    // Check balance
    const balResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const balance = balResult.rows[0].balance;

    if (balance < OPEN_COST) {
      return res.status(400).json({ error: `Insufficient balance. Opening a destination costs $${OPEN_COST.toLocaleString()}.` });
    }

    // Deduct cost
    await pool.query('UPDATE airlines SET balance = balance - $1 WHERE id = $2', [OPEN_COST, req.airlineId]);

    // Record transaction
    await pool.query(
      "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'other', $2, $3)",
      [req.airlineId, -OPEN_COST, `Opened destination: ${code}`]
    );

    // Insert destination
    await pool.query(
      'INSERT INTO airline_destinations (airline_id, airport_code, destination_type) VALUES ($1, $2, $3)',
      [req.airlineId, code, type]
    );

    // Auto-hire ground staff
    try {
      const apCatResult = await pool.query('SELECT category FROM airports WHERE iata_code = $1', [code]);
      if (apCatResult.rows[0]) {
        const category = apCatResult.rows[0].category;
        await addGroundStaff(req.airlineId, code, category || 4, type, 0, 0);
      }
    } catch (e) { console.error('Ground staff auto-hire error:', e); }

    // Get new balance
    const newBalResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const newBalance = newBalResult.rows[0].balance;

    res.status(201).json({ message: 'Destination opened successfully', new_balance: newBalance });
  } catch (error) {
    console.error('Open destination error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});


// Helper: gather everything needed to render the dissolve UI
async function getDissolvePreview(airlineId) {
  const airlineRes = await pool.query(
    'SELECT home_airport_code, primary_hub_airport_code, balance, level FROM airlines WHERE id = $1',
    [airlineId]
  );
  if (!airlineRes.rows[0]) return null;
  const { home_airport_code: homeCode, primary_hub_airport_code: primaryHub, balance, level } = airlineRes.rows[0];
  if (!primaryHub) return { primary_hub: null };

  // A route blocks dissolution only if its arrival is "non-privileged" — i.e.
  // not Homebase and not itself a Secondary Hub. Routes whose arrival has its
  // own expansion stay valid after dissolution (the Secondary Hub at the other
  // end satisfies the route validity rule), so they shouldn't be flagged.
  const blocking = await pool.query(`
    SELECT r.flight_number, r.arrival_airport
    FROM routes r
    WHERE r.airline_id = $1
      AND r.departure_airport = $2
      AND r.arrival_airport != $3
      AND NOT EXISTS (
        SELECT 1 FROM airport_expansions ae
        WHERE ae.airline_id = r.airline_id
          AND ae.airport_code = r.arrival_airport
          AND ae.expansion_level > 0
      )
    ORDER BY r.flight_number
  `, [airlineId, primaryHub, homeCode || '']);

  // Active flights from primary hub that would consume Secondary Hub slots after conversion
  // (i.e., arrival is not Homebase and arrival has no expansion of its own).
  const depRes = await pool.query(`
    SELECT COUNT(*) AS cnt FROM weekly_schedule ws
    JOIN aircraft ac ON ac.id = ws.aircraft_id
    WHERE ac.airline_id = $1 AND ac.is_active = 1
      AND ws.departure_airport = $2
      AND ws.arrival_airport != $3
      AND NOT EXISTS (
        SELECT 1 FROM airport_expansions ae
        WHERE ae.airline_id = ac.airline_id
          AND ae.airport_code = ws.arrival_airport
          AND ae.expansion_level > 0
      )
  `, [airlineId, primaryHub, homeCode || '']);
  const departures = parseInt(depRes.rows[0].cnt) || 0;

  const apRes = await pool.query('SELECT name, category FROM airports WHERE iata_code = $1', [primaryHub]);
  const category = apRes.rows[0]?.category ?? 4;

  const expRes = await pool.query(
    'SELECT expansion_level FROM airport_expansions WHERE airline_id = $1 AND airport_code = $2',
    [airlineId, primaryHub]
  );
  const existingLevel = expRes.rows[0]?.expansion_level ?? 0;
  const requiredLevel = Math.ceil(departures / DEPARTURES_PER_LEVEL);
  const targetLevel = Math.max(existingLevel, requiredLevel);
  const upgradeCost = targetLevel > existingLevel
    ? getTotalCostForLevel(category, targetLevel) - getTotalCostForLevel(category, existingLevel)
    : 0;

  return {
    primary_hub: primaryHub,
    airport_name: apRes.rows[0]?.name ?? primaryHub,
    category,
    home_airport_code: homeCode,
    balance,
    blocking_routes: blocking.rows.map(r => ({ flight_number: r.flight_number, arrival_airport: r.arrival_airport })),
    conversion: {
      departures_count: departures,
      current_level: existingLevel,
      required_level: requiredLevel,
      target_level: targetLevel,
      upgrade_cost: upgradeCost,
      affordable: balance >= upgradeCost,
      departures_per_level: DEPARTURES_PER_LEVEL,
      unlocked: (level ?? 1) >= SECONDARY_HUB_LEVEL,
      required_airline_level: SECONDARY_HUB_LEVEL,
      airline_level: level ?? 1
    }
  };
}

// GET /api/destinations/primary-hub/dissolve-preview — info for the dissolve UI
router.get('/primary-hub/dissolve-preview', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const preview = await getDissolvePreview(req.airlineId);
    if (!preview) return res.status(400).json({ error: 'No airline found' });
    if (!preview.primary_hub) return res.status(400).json({ error: 'No Primary Hub set.' });
    res.json(preview);
  } catch (error) {
    console.error('Dissolve preview error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/destinations/primary-hub/convert-to-secondary
// Dissolves Primary Hub by upgrading the airport's Secondary Hub level to cover
// current departures. Charges any incremental cost; routes can stay in place.
router.post('/primary-hub/convert-to-secondary', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const lvlRes = await pool.query('SELECT level FROM airlines WHERE id = $1', [req.airlineId]);
    const airlineLevel = lvlRes.rows[0]?.level ?? 1;
    if (airlineLevel < SECONDARY_HUB_LEVEL) {
      return res.status(400).json({ error: `Secondary Hubs unlock at level ${SECONDARY_HUB_LEVEL}. You are level ${airlineLevel}. Delete the routes departing from the Primary Hub instead, or wait until level ${SECONDARY_HUB_LEVEL}.` });
    }

    const preview = await getDissolvePreview(req.airlineId);
    if (!preview) return res.status(400).json({ error: 'No airline found' });
    if (!preview.primary_hub) return res.status(400).json({ error: 'No Primary Hub set.' });

    const { primary_hub: primaryHub, conversion, balance } = preview;
    const { current_level, target_level, upgrade_cost } = conversion;

    if (upgrade_cost > 0 && balance < upgrade_cost) {
      return res.status(400).json({
        error: `Insufficient balance. Conversion to Secondary Hub Level ${target_level} costs $${upgrade_cost.toLocaleString()}.`,
        ...preview
      });
    }

    if (upgrade_cost > 0) {
      await pool.query('UPDATE airlines SET balance = balance - $1 WHERE id = $2', [upgrade_cost, req.airlineId]);
      await pool.query(
        "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'other', $2, $3)",
        [req.airlineId, -upgrade_cost, `Primary→Secondary Hub conversion at ${primaryHub} (Level ${current_level}→${target_level})`]
      );
    }

    if (target_level > current_level) {
      const expRes = await pool.query(
        'SELECT id FROM airport_expansions WHERE airline_id = $1 AND airport_code = $2',
        [req.airlineId, primaryHub]
      );
      if (expRes.rows[0]) {
        await pool.query('UPDATE airport_expansions SET expansion_level = $1 WHERE id = $2',
          [target_level, expRes.rows[0].id]);
      } else {
        await pool.query('INSERT INTO airport_expansions (airline_id, airport_code, expansion_level) VALUES ($1, $2, $3)',
          [req.airlineId, primaryHub, target_level]);
      }
    }

    await pool.query('UPDATE airlines SET primary_hub_airport_code = NULL WHERE id = $1', [req.airlineId]);

    const newBal = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    res.json({
      message: target_level > 0
        ? `${primaryHub} converted to Secondary Hub at Level ${target_level}`
        : `Primary Hub at ${primaryHub} dissolved`,
      dissolved_airport_code: primaryHub,
      target_level,
      cost: upgrade_cost,
      new_balance: newBal.rows[0].balance
    });
  } catch (error) {
    console.error('Convert primary hub error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/destinations/primary-hub — set the airline's Primary Hub
router.post('/primary-hub', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const { airport_code } = req.body;
    if (!airport_code) return res.status(400).json({ error: 'airport_code required' });
    const code = airport_code.toUpperCase();

    const airlineRes = await pool.query(
      'SELECT home_airport_code, primary_hub_airport_code, level FROM airlines WHERE id = $1',
      [req.airlineId]
    );
    if (!airlineRes.rows[0]) return res.status(400).json({ error: 'No airline found' });
    const { home_airport_code: homeCode, primary_hub_airport_code: currentPrimary, level: airlineLevel } = airlineRes.rows[0];

    if ((airlineLevel ?? 1) < PRIMARY_HUB_LEVEL) {
      return res.status(400).json({ error: `Primary Hub unlocks at level ${PRIMARY_HUB_LEVEL}. Your airline is level ${airlineLevel ?? 1}.` });
    }
    if (currentPrimary) {
      return res.status(400).json({
        error: `You already have a Primary Hub at ${currentPrimary}. Dissolve it first to choose a new one.`
      });
    }
    if (code === homeCode) {
      return res.status(400).json({ error: 'Home Base already provides unlimited departures. Choose a different airport for your Primary Hub.' });
    }

    const dest = await pool.query(
      'SELECT id FROM airline_destinations WHERE airline_id = $1 AND airport_code = $2',
      [req.airlineId, code]
    );
    if (!dest.rows[0]) return res.status(400).json({ error: 'Open this airport as a destination first.' });

    await pool.query('UPDATE airlines SET primary_hub_airport_code = $1 WHERE id = $2', [code, req.airlineId]);

    res.json({ message: `${code} set as Primary Hub`, primary_hub_airport_code: code });
  } catch (error) {
    console.error('Set primary hub error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/destinations/primary-hub — dissolve the airline's Primary Hub
router.delete('/primary-hub', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const preview = await getDissolvePreview(req.airlineId);
    if (!preview) return res.status(400).json({ error: 'No airline found' });
    if (!preview.primary_hub) return res.status(400).json({ error: 'No Primary Hub set.' });

    const { primary_hub: currentPrimary, blocking_routes } = preview;

    if (blocking_routes.length > 0) {
      return res.status(400).json({
        error: `Cannot dissolve Primary Hub at ${currentPrimary}: ${blocking_routes.length} route${blocking_routes.length !== 1 ? 's' : ''} still depart from it. Delete these routes first (routes to your Homebase may remain) — or convert the airport to a Secondary Hub.`,
        ...preview
      });
    }

    await pool.query('UPDATE airlines SET primary_hub_airport_code = NULL WHERE id = $1', [req.airlineId]);

    res.json({ message: `Primary Hub at ${currentPrimary} dissolved`, dissolved_airport_code: currentPrimary });
  } catch (error) {
    console.error('Dissolve primary hub error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});


// DELETE /api/destinations/:code — close/remove a destination
router.delete('/:code', authMiddleware, async (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const code = req.params.code.toUpperCase();

    // Find destination
    const destResult = await pool.query(
      'SELECT id, destination_type FROM airline_destinations WHERE airline_id = $1 AND airport_code = $2',
      [req.airlineId, code]
    );
    if (!destResult.rows[0]) {
      return res.status(404).json({ error: 'Destination not found' });
    }
    const destId = destResult.rows[0].id;
    const destType = destResult.rows[0].destination_type;

    if (destType === 'home_base') {
      return res.status(400).json({ error: 'Cannot close your Home Base.' });
    }

    // Block close of the airport currently set as Primary Hub
    const airlineCheck = await pool.query('SELECT primary_hub_airport_code FROM airlines WHERE id = $1', [req.airlineId]);
    if (airlineCheck.rows[0]?.primary_hub_airport_code === code) {
      return res.status(400).json({ error: `Cannot close ${code}: it is your Primary Hub. Dissolve the Primary Hub first.` });
    }

    // Block deletion if any routes use this airport
    const routeResult = await pool.query(`
      SELECT flight_number FROM routes
      WHERE airline_id = $1 AND (departure_airport = $2 OR arrival_airport = $2)
      ORDER BY flight_number
    `, [req.airlineId, code]);

    const activeRoutes = routeResult.rows.map(r => r.flight_number);

    if (activeRoutes.length > 0) {
      return res.status(400).json({
        error: `Cannot close ${code}: active routes use this airport (${activeRoutes.join(', ')}). Delete those routes first.`
      });
    }

    // Delete
    await pool.query('DELETE FROM airline_destinations WHERE id = $1', [destId]);

    res.json({ message: `Destination ${code} closed` });
  } catch (error) {
    console.error('Delete destination error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
