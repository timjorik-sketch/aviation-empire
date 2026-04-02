import express from 'express';
import { body, validationResult } from 'express-validator';
import { getDatabase, saveDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// Calculate distance between two airports using Haversine formula
// Reads coordinates from the database (airports.latitude / airports.longitude)
function calculateDistance(db, dep, arr) {
  const stmt = db.prepare('SELECT iata_code, latitude, longitude FROM airports WHERE iata_code IN (?, ?)');
  stmt.bind([dep, arr]);
  const coords = {};
  while (stmt.step()) {
    const row = stmt.get();
    coords[row[0]] = { lat: row[1], lon: row[2] };
  }
  stmt.free();

  const depCoords = coords[dep];
  const arrCoords = coords[arr];

  if (!depCoords || !arrCoords || depCoords.lat == null || arrCoords.lat == null) {
    return null;
  }

  const R = 6371; // Earth's radius in km
  const dLat = (arrCoords.lat - depCoords.lat) * Math.PI / 180;
  const dLon = (arrCoords.lon - depCoords.lon) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(depCoords.lat * Math.PI / 180) * Math.cos(arrCoords.lat * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

// Determine the hub tier of an airport for an airline
function getAirportTier(db, airlineId, airportCode) {
  const homeStmt = db.prepare('SELECT home_airport_code FROM airlines WHERE id = ?');
  homeStmt.bind([airlineId]);
  let homeCode = null;
  if (homeStmt.step()) homeCode = homeStmt.get()[0];
  homeStmt.free();
  if (homeCode === airportCode) return 'home_base';

  const destStmt = db.prepare('SELECT destination_type FROM airline_destinations WHERE airline_id = ? AND airport_code = ?');
  destStmt.bind([airlineId, airportCode]);
  if (destStmt.step()) {
    const type = destStmt.get()[0];
    destStmt.free();
    return type; // 'hub', 'base', or 'destination'
  }
  destStmt.free();
  return 'not_opened';
}

// Check if airport has expansion levels purchased
function getExpansionLevel(db, airlineId, airportCode) {
  const stmt = db.prepare('SELECT expansion_level FROM airport_expansions WHERE airline_id = ? AND airport_code = ?');
  stmt.bind([airlineId, airportCode]);
  const found = stmt.step();
  const level = found ? stmt.get()[0] : 0;
  stmt.free();
  return level;
}

// Get all routes for airline
router.get('/', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();

    // Get airline ID
    const airlineStmt = db.prepare('SELECT id, airline_code FROM airlines WHERE id = ?');
    airlineStmt.bind([req.airlineId]);

    if (!airlineStmt.step()) {
      airlineStmt.free();
      return res.status(400).json({ error: 'No airline found' });
    }

    const airlineRow = airlineStmt.get();
    const airlineId = airlineRow[0];
    const airlineCode = airlineRow[1];
    airlineStmt.free();

    const routesStmt = db.prepare(`
      SELECT
        r.id, r.flight_number, r.departure_airport, r.arrival_airport,
        r.distance_km, r.created_at,
        r.economy_price, r.business_price, r.first_price,
        dep.name as departure_name,
        arr.name as arrival_name,
        COALESCE((
          SELECT COUNT(ws.id)
          FROM weekly_schedule ws
          JOIN aircraft a ON ws.aircraft_id = a.id
          WHERE ws.route_id = r.id AND a.airline_id = r.airline_id
        ), 0) as weekly_flights
      FROM routes r
      JOIN airports dep ON r.departure_airport = dep.iata_code
      JOIN airports arr ON r.arrival_airport = arr.iata_code
      WHERE r.airline_id = ?
      ORDER BY r.flight_number ASC
    `);
    routesStmt.bind([airlineId]);

    const routes = [];
    while (routesStmt.step()) {
      const row = routesStmt.get();
      routes.push({
        id: row[0],
        flight_number: row[1],
        departure_airport: row[2],
        arrival_airport: row[3],
        distance_km: row[4],
        created_at: row[5],
        economy_price: row[6],
        business_price: row[7],
        first_price: row[8],
        departure_name: row[9],
        arrival_name: row[10],
        weekly_flights: row[11]
      });
    }
    routesStmt.free();

    res.json({ routes, airline_code: airlineCode });
  } catch (error) {
    console.error('Get routes error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new route (optionally with return route)
router.post('/create',
  authMiddleware,
  body('departure_airport').matches(/^[A-Z]{3}$/).withMessage('Invalid departure airport code'),
  body('arrival_airport').matches(/^[A-Z]{3}$/).withMessage('Invalid arrival airport code'),
  body('flight_number_suffix').matches(/^\d{4}$/).withMessage('Flight number must be exactly 4 digits'),
  body('return_flight_number_suffix').optional({ nullable: true }).matches(/^\d{4}$/).withMessage('Return flight number must be exactly 4 digits'),
  body('economy_price').isFloat({ min: 1 }).withMessage('Economy price must be positive'),
  body('business_price').optional({ nullable: true }).isFloat({ min: 1 }).withMessage('Business price must be positive'),
  body('first_price').optional({ nullable: true }).isFloat({ min: 1 }).withMessage('First class price must be positive'),
  (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { departure_airport, arrival_airport, flight_number_suffix, return_flight_number_suffix, economy_price, business_price, first_price } = req.body;
      const withReturn = !!return_flight_number_suffix;
      const db = getDatabase();

      if (departure_airport === arrival_airport) {
        return res.status(400).json({ error: 'Departure and arrival airports must be different' });
      }

      // Get airline
      const airlineStmt = db.prepare('SELECT id, airline_code FROM airlines WHERE id = ?');
      airlineStmt.bind([req.airlineId]);
      if (!airlineStmt.step()) {
        airlineStmt.free();
        return res.status(400).json({ error: 'No airline found' });
      }
      const airlineRow = airlineStmt.get();
      const airlineId = airlineRow[0];
      const airlineCode = airlineRow[1];
      airlineStmt.free();

      const flightNumber = `${airlineCode}${flight_number_suffix}`;
      const returnFlightNumber = withReturn ? `${airlineCode}${return_flight_number_suffix}` : null;

      // Validate flight number suffix uniqueness (catch duplicate suffix early)
      if (withReturn && flight_number_suffix === return_flight_number_suffix) {
        return res.status(400).json({ error: 'Outbound and return flight numbers must be different' });
      }

      // Check outbound flight number uniqueness
      const fnCheckStmt = db.prepare('SELECT id FROM routes WHERE airline_id = ? AND flight_number = ?');
      fnCheckStmt.bind([airlineId, flightNumber]);
      if (fnCheckStmt.step()) { fnCheckStmt.free(); return res.status(400).json({ error: `Flight number ${flightNumber} already exists` }); }
      fnCheckStmt.free();

      // Check return flight number uniqueness (if requested)
      if (withReturn) {
        const fnRetStmt = db.prepare('SELECT id FROM routes WHERE airline_id = ? AND flight_number = ?');
        fnRetStmt.bind([airlineId, returnFlightNumber]);
        if (fnRetStmt.step()) { fnRetStmt.free(); return res.status(400).json({ error: `Return flight number ${returnFlightNumber} already exists` }); }
        fnRetStmt.free();
      }

      // Verify airports exist
      const depStmt = db.prepare('SELECT iata_code FROM airports WHERE iata_code = ?');
      depStmt.bind([departure_airport]);
      if (!depStmt.step()) { depStmt.free(); return res.status(400).json({ error: 'Departure airport not found' }); }
      depStmt.free();

      const arrStmt = db.prepare('SELECT iata_code FROM airports WHERE iata_code = ?');
      arrStmt.bind([arrival_airport]);
      if (!arrStmt.step()) { arrStmt.free(); return res.status(400).json({ error: 'Arrival airport not found' }); }
      arrStmt.free();

      // Check outbound route doesn't already exist
      const existsStmt = db.prepare('SELECT id FROM routes WHERE airline_id = ? AND departure_airport = ? AND arrival_airport = ?');
      existsStmt.bind([airlineId, departure_airport, arrival_airport]);
      if (existsStmt.step()) { existsStmt.free(); return res.status(400).json({ error: `Route ${departure_airport}→${arrival_airport} already exists` }); }
      existsStmt.free();

      // Check return route doesn't already exist (if requested)
      if (withReturn) {
        const retExistsStmt = db.prepare('SELECT id FROM routes WHERE airline_id = ? AND departure_airport = ? AND arrival_airport = ?');
        retExistsStmt.bind([airlineId, arrival_airport, departure_airport]);
        if (retExistsStmt.step()) { retExistsStmt.free(); return res.status(400).json({ error: `Return route ${arrival_airport}→${departure_airport} already exists` }); }
        retExistsStmt.free();
      }

      // ── Expansion validation ───────────────────────────────────────────────
      const tierDep = getAirportTier(db, airlineId, departure_airport);
      const tierArr = getAirportTier(db, airlineId, arrival_airport);

      if (tierDep === 'not_opened') {
        return res.status(400).json({ error: `${departure_airport} has not been opened as a destination. Open it first in Network.` });
      }
      if (tierArr === 'not_opened') {
        return res.status(400).json({ error: `${arrival_airport} has not been opened as a destination. Open it first in Network.` });
      }

      const depIsHomeBase = tierDep === 'home_base';
      const arrIsHomeBase = tierArr === 'home_base';

      // Rule 1: Home base involved → always allowed
      if (!depIsHomeBase && !arrIsHomeBase) {
        const depExpLevel = getExpansionLevel(db, airlineId, departure_airport);
        const arrExpLevel = getExpansionLevel(db, airlineId, arrival_airport);

        // Rule 5: Neither has expansion → block
        if (depExpLevel === 0 && arrExpLevel === 0) {
          return res.status(400).json({
            error: `Cannot create route ${departure_airport}→${arrival_airport}: neither airport has an expansion. Purchase expansion at one of them in the Network page.`
          });
        }
        // Rule 2 (both have expansion), Rule 3 (only origin), Rule 4 (only dest): all allowed
      }
      // ── End expansion validation ───────────────────────────────────────────

      const distance = calculateDistance(db, departure_airport, arrival_airport);
      const eco = economy_price;
      const biz = business_price || null;
      const fir = first_price || null;

      // ── Insert outbound route ──────────────────────────────────────────────
      const insertStmt = db.prepare(
        'INSERT INTO routes (airline_id, departure_airport, arrival_airport, flight_number, distance_km, economy_price, business_price, first_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      insertStmt.bind([airlineId, departure_airport, arrival_airport, flightNumber, distance, eco, biz, fir]);
      insertStmt.step();
      insertStmt.free();

      const fetchStmt = db.prepare('SELECT id FROM routes WHERE airline_id = ? AND flight_number = ?');
      fetchStmt.bind([airlineId, flightNumber]);
      fetchStmt.step();
      const routeId = fetchStmt.get()[0];
      fetchStmt.free();

      // ── Insert return route (optional) ────────────────────────────────────
      let returnRouteId = null;
      if (withReturn) {
        let retInsertStmt = null;
        let retFetchStmt = null;
        try {
          retInsertStmt = db.prepare(
            'INSERT INTO routes (airline_id, departure_airport, arrival_airport, flight_number, distance_km, economy_price, business_price, first_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          );
          retInsertStmt.bind([airlineId, arrival_airport, departure_airport, returnFlightNumber, distance, eco, biz, fir]);
          retInsertStmt.step();
          retInsertStmt.free();
          retInsertStmt = null;

          retFetchStmt = db.prepare('SELECT id FROM routes WHERE airline_id = ? AND flight_number = ?');
          retFetchStmt.bind([airlineId, returnFlightNumber]);
          retFetchStmt.step();
          returnRouteId = retFetchStmt.get()[0];
          retFetchStmt.free();
          retFetchStmt = null;
        } catch (retErr) {
          // Free any un-freed statements to avoid leaving db in bad state
          try { if (retInsertStmt) retInsertStmt.free(); } catch (_) {}
          try { if (retFetchStmt) retFetchStmt.free(); } catch (_) {}
          // Roll back outbound route
          try {
            const rollbackStmt = db.prepare('DELETE FROM routes WHERE id = ?');
            rollbackStmt.bind([routeId]);
            rollbackStmt.step();
            rollbackStmt.free();
            saveDatabase();
          } catch (_) {}
          throw retErr;
        }
      }

      saveDatabase();

      const responseRoutes = [{
        id: routeId,
        flight_number: flightNumber,
        departure_airport,
        arrival_airport,
        distance_km: distance,
        economy_price: eco,
        business_price: biz,
        first_price: fir
      }];

      if (withReturn) {
        responseRoutes.push({
          id: returnRouteId,
          flight_number: returnFlightNumber,
          departure_airport: arrival_airport,
          arrival_airport: departure_airport,
          distance_km: distance,
          economy_price: eco,
          business_price: biz,
          first_price: fir
        });
      }

      res.status(201).json({
        message: withReturn
          ? `Routes ${flightNumber} and ${returnFlightNumber} created successfully`
          : 'Route created successfully',
        routes: responseRoutes,
        // backwards-compat: single route consumers
        route: responseRoutes[0]
      });
    } catch (error) {
      console.error('Create route error:', error);
      res.status(500).json({ error: error.message || 'Server error' });
    }
  }
);

// Update route prices
router.patch('/:id',
  authMiddleware,
  body('economy_price').optional().isFloat({ min: 1 }).withMessage('Economy price must be positive'),
  body('business_price').optional({ nullable: true }).isFloat({ min: 1 }).withMessage('Business price must be positive'),
  body('first_price').optional({ nullable: true }).isFloat({ min: 1 }).withMessage('First class price must be positive'),
  (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const routeId = parseInt(req.params.id);
      const { economy_price, business_price, first_price } = req.body;
      const db = getDatabase();

      const airlineId = req.airlineId;
      if (!airlineId) return res.status(400).json({ error: 'No active airline' });

      const routeStmt = db.prepare('SELECT id FROM routes WHERE id = ? AND airline_id = ?');
      routeStmt.bind([routeId, airlineId]);
      if (!routeStmt.step()) {
        routeStmt.free();
        return res.status(404).json({ error: 'Route not found' });
      }
      routeStmt.free();

      const updates = [];
      const params = [];

      if (economy_price !== undefined) { updates.push('economy_price = ?'); params.push(economy_price); }
      if (business_price !== undefined) { updates.push('business_price = ?'); params.push(business_price || null); }
      if (first_price !== undefined) { updates.push('first_price = ?'); params.push(first_price || null); }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      params.push(routeId);
      const updateStmt = db.prepare(`UPDATE routes SET ${updates.join(', ')} WHERE id = ?`);
      updateStmt.bind(params);
      updateStmt.step();
      updateStmt.free();

      // Read back the current prices (some may not have been in this update)
      const priceStmt = db.prepare('SELECT economy_price, business_price, first_price FROM routes WHERE id = ?');
      priceStmt.bind([routeId]);
      if (priceStmt.step()) {
        const [curEco, curBiz, curFir] = priceStmt.get();
        if (curEco != null) {
          // Sync weekly_schedule entries
          const wsStmt = db.prepare('UPDATE weekly_schedule SET economy_price = ?, business_price = ?, first_price = ? WHERE route_id = ?');
          wsStmt.bind([curEco, curBiz ?? null, curFir ?? null, routeId]);
          wsStmt.step(); wsStmt.free();
          // Sync future flights
          const fStmt = db.prepare(`UPDATE flights SET economy_price = ?, business_price = ?, first_price = ? WHERE status IN ('scheduled','boarding') AND (route_id = ? OR weekly_schedule_id IN (SELECT id FROM weekly_schedule WHERE route_id = ?))`);
          fStmt.bind([curEco, curBiz ?? null, curFir ?? null, routeId, routeId]);
          fStmt.step(); fStmt.free();
        }
      }
      priceStmt.free();

      saveDatabase();

      res.json({ message: 'Route updated successfully' });
    } catch (error) {
      console.error('Update route error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Delete route
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const routeId = parseInt(req.params.id);
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const routeStmt = db.prepare('SELECT id, flight_number FROM routes WHERE id = ? AND airline_id = ?');
    routeStmt.bind([routeId, airlineId]);
    if (!routeStmt.step()) {
      routeStmt.free();
      return res.status(404).json({ error: 'Route not found' });
    }
    const [, flightNumber] = routeStmt.get();
    routeStmt.free();

    // Block deletion if route is used in any aircraft schedule
    const schedStmt = db.prepare(`
      SELECT ac.registration FROM weekly_schedule ws
      JOIN aircraft ac ON ws.aircraft_id = ac.id
      WHERE ws.flight_number = ? AND ac.airline_id = ?
      GROUP BY ac.registration
    `);
    schedStmt.bind([flightNumber, airlineId]);
    const usedBy = [];
    while (schedStmt.step()) usedBy.push(schedStmt.get()[0]);
    schedStmt.free();

    if (usedBy.length > 0) {
      return res.status(400).json({
        error: `Route ${flightNumber} is scheduled on aircraft: ${usedBy.join(', ')}. Remove it from those flight plans first.`
      });
    }

    const deleteStmt = db.prepare('DELETE FROM routes WHERE id = ?');
    deleteStmt.bind([routeId]);
    deleteStmt.step();
    deleteStmt.free();

    saveDatabase();

    res.json({ message: 'Route deleted successfully' });
  } catch (error) {
    console.error('Delete route error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get aircraft scheduled on a specific route
router.get('/:id/aircraft', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const stmt = db.prepare(`
      SELECT ac.id, ac.registration, ac.name, at.full_name, ac.is_active,
             COUNT(ws.id) as slot_count
      FROM weekly_schedule ws
      JOIN aircraft ac ON ws.aircraft_id = ac.id
      JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      WHERE ws.route_id = ? AND ac.airline_id = ?
      GROUP BY ac.id
      ORDER BY ac.registration ASC
    `);
    stmt.bind([req.params.id, airlineId]);
    const aircraft = [];
    while (stmt.step()) {
      const r = stmt.get();
      aircraft.push({ id: r[0], registration: r[1], name: r[2], type: r[3], is_active: r[4], slot_count: r[5] });
    }
    stmt.free();
    res.json({ aircraft });
  } catch (error) {
    console.error('Get route aircraft error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
