import express from 'express';
import { body, validationResult } from 'express-validator';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// Calculate distance between two airports using Haversine formula
async function calculateDistance(dep, arr) {
  const result = await pool.query(
    'SELECT iata_code, latitude, longitude FROM airports WHERE iata_code IN ($1, $2)',
    [dep, arr]
  );
  const coords = {};
  for (const row of result.rows) {
    coords[row.iata_code] = { lat: row.latitude, lon: row.longitude };
  }

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
async function getAirportTier(airlineId, airportCode) {
  const homeResult = await pool.query(
    'SELECT home_airport_code FROM airlines WHERE id = $1',
    [airlineId]
  );
  const homeCode = homeResult.rows[0] ? homeResult.rows[0].home_airport_code : null;
  if (homeCode === airportCode) return 'home_base';

  const destResult = await pool.query(
    'SELECT destination_type FROM airline_destinations WHERE airline_id = $1 AND airport_code = $2',
    [airlineId, airportCode]
  );
  if (destResult.rows[0]) {
    return destResult.rows[0].destination_type; // 'hub', 'base', or 'destination'
  }
  return 'not_opened';
}

// Check if airport has expansion levels purchased
async function getExpansionLevel(airlineId, airportCode) {
  const result = await pool.query(
    'SELECT expansion_level FROM airport_expansions WHERE airline_id = $1 AND airport_code = $2',
    [airlineId, airportCode]
  );
  return result.rows[0] ? result.rows[0].expansion_level : 0;
}

// Get all routes for airline
router.get('/', authMiddleware, async (req, res) => {
  try {
    const airlineResult = await pool.query('SELECT id, airline_code FROM airlines WHERE id = $1', [req.airlineId]);
    if (!airlineResult.rows[0]) {
      return res.status(400).json({ error: 'No airline found' });
    }
    const airlineId = airlineResult.rows[0].id;
    const airlineCode = airlineResult.rows[0].airline_code;

    const result = await pool.query(`
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
        ), 0) as weekly_flights,
        ma.economy_rating, ma.business_rating, ma.first_rating,
        ma.economy_market_price, ma.business_market_price, ma.first_market_price,
        ma.economy_price as ma_eco_price, ma.business_price as ma_biz_price, ma.first_price as ma_fir_price,
        ma.requested_at as ma_requested_at
      FROM routes r
      JOIN airports dep ON r.departure_airport = dep.iata_code
      JOIN airports arr ON r.arrival_airport = arr.iata_code
      LEFT JOIN LATERAL (
        SELECT economy_rating, business_rating, first_rating,
               economy_market_price, business_market_price, first_market_price,
               economy_price, business_price, first_price,
               requested_at
        FROM market_analyses
        WHERE route_id = r.id AND airline_id = $1 AND status = 'completed'
        ORDER BY requested_at DESC
        LIMIT 1
      ) ma ON true
      WHERE r.airline_id = $1
      ORDER BY r.flight_number ASC
    `, [airlineId]);

    const routes = result.rows.map(row => ({
      id: row.id,
      flight_number: row.flight_number,
      departure_airport: row.departure_airport,
      arrival_airport: row.arrival_airport,
      distance_km: row.distance_km,
      created_at: row.created_at,
      economy_price: row.economy_price,
      business_price: row.business_price,
      first_price: row.first_price,
      departure_name: row.departure_name,
      arrival_name: row.arrival_name,
      weekly_flights: parseInt(row.weekly_flights),
      analysis: row.economy_rating ? {
        economy_rating: row.economy_rating,
        business_rating: row.business_rating,
        first_rating: row.first_rating,
        economy_market_price: row.economy_market_price,
        business_market_price: row.business_market_price,
        first_market_price: row.first_market_price,
        ma_eco_price: row.ma_eco_price,
        ma_biz_price: row.ma_biz_price,
        ma_fir_price: row.ma_fir_price,
        requested_at: row.ma_requested_at,
      } : null,
    }));

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
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { departure_airport, arrival_airport, flight_number_suffix, return_flight_number_suffix, economy_price, business_price, first_price } = req.body;
      const withReturn = !!return_flight_number_suffix;

      if (departure_airport === arrival_airport) {
        return res.status(400).json({ error: 'Departure and arrival airports must be different' });
      }

      // Get airline
      const airlineResult = await pool.query('SELECT id, airline_code FROM airlines WHERE id = $1', [req.airlineId]);
      if (!airlineResult.rows[0]) {
        return res.status(400).json({ error: 'No airline found' });
      }
      const airlineId = airlineResult.rows[0].id;
      const airlineCode = airlineResult.rows[0].airline_code;

      const flightNumber = `${airlineCode}${flight_number_suffix}`;
      const returnFlightNumber = withReturn ? `${airlineCode}${return_flight_number_suffix}` : null;

      // Validate flight number suffix uniqueness
      if (withReturn && flight_number_suffix === return_flight_number_suffix) {
        return res.status(400).json({ error: 'Outbound and return flight numbers must be different' });
      }

      // Check outbound flight number uniqueness
      const fnCheckResult = await pool.query(
        'SELECT id FROM routes WHERE airline_id = $1 AND flight_number = $2',
        [airlineId, flightNumber]
      );
      if (fnCheckResult.rows[0]) return res.status(400).json({ error: `Flight number ${flightNumber} already exists` });

      // Check return flight number uniqueness (if requested)
      if (withReturn) {
        const fnRetResult = await pool.query(
          'SELECT id FROM routes WHERE airline_id = $1 AND flight_number = $2',
          [airlineId, returnFlightNumber]
        );
        if (fnRetResult.rows[0]) return res.status(400).json({ error: `Return flight number ${returnFlightNumber} already exists` });
      }

      // Verify airports exist
      const depResult = await pool.query('SELECT iata_code FROM airports WHERE iata_code = $1', [departure_airport]);
      if (!depResult.rows[0]) return res.status(400).json({ error: 'Departure airport not found' });

      const arrResult = await pool.query('SELECT iata_code FROM airports WHERE iata_code = $1', [arrival_airport]);
      if (!arrResult.rows[0]) return res.status(400).json({ error: 'Arrival airport not found' });

      // Check outbound route doesn't already exist
      const existsResult = await pool.query(
        'SELECT id FROM routes WHERE airline_id = $1 AND departure_airport = $2 AND arrival_airport = $3',
        [airlineId, departure_airport, arrival_airport]
      );
      if (existsResult.rows[0]) return res.status(400).json({ error: `Route ${departure_airport}→${arrival_airport} already exists` });

      // Check return route doesn't already exist (if requested)
      if (withReturn) {
        const retExistsResult = await pool.query(
          'SELECT id FROM routes WHERE airline_id = $1 AND departure_airport = $2 AND arrival_airport = $3',
          [airlineId, arrival_airport, departure_airport]
        );
        if (retExistsResult.rows[0]) return res.status(400).json({ error: `Return route ${arrival_airport}→${departure_airport} already exists` });
      }

      // ── Expansion validation ───────────────────────────────────────────────
      const tierDep = await getAirportTier(airlineId, departure_airport);
      const tierArr = await getAirportTier(airlineId, arrival_airport);

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
        const depExpLevel = await getExpansionLevel(airlineId, departure_airport);
        const arrExpLevel = await getExpansionLevel(airlineId, arrival_airport);

        // Rule 5: Neither has expansion → block
        if (depExpLevel === 0 && arrExpLevel === 0) {
          return res.status(400).json({
            error: `Cannot create route ${departure_airport}→${arrival_airport}: neither airport has an expansion. Purchase expansion at one of them in the Network page.`
          });
        }
        // Rule 2 (both have expansion), Rule 3 (only origin), Rule 4 (only dest): all allowed
      }
      // ── End expansion validation ───────────────────────────────────────────

      const distance = await calculateDistance(departure_airport, arrival_airport);
      const eco = economy_price;
      const biz = business_price || null;
      const fir = first_price || null;

      // ── Insert outbound route ──────────────────────────────────────────────
      const insertResult = await pool.query(
        'INSERT INTO routes (airline_id, departure_airport, arrival_airport, flight_number, distance_km, economy_price, business_price, first_price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
        [airlineId, departure_airport, arrival_airport, flightNumber, distance, eco, biz, fir]
      );
      const routeId = insertResult.rows[0].id;

      // ── Insert return route (optional) ────────────────────────────────────
      let returnRouteId = null;
      if (withReturn) {
        try {
          const retInsertResult = await pool.query(
            'INSERT INTO routes (airline_id, departure_airport, arrival_airport, flight_number, distance_km, economy_price, business_price, first_price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
            [airlineId, arrival_airport, departure_airport, returnFlightNumber, distance, eco, biz, fir]
          );
          returnRouteId = retInsertResult.rows[0].id;
        } catch (retErr) {
          // Roll back outbound route
          try {
            await pool.query('DELETE FROM routes WHERE id = $1', [routeId]);
          } catch (_) {}
          throw retErr;
        }
      }

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
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const routeId = parseInt(req.params.id);
      const { economy_price, business_price, first_price } = req.body;

      const airlineId = req.airlineId;
      if (!airlineId) return res.status(400).json({ error: 'No active airline' });

      const routeResult = await pool.query(
        'SELECT id FROM routes WHERE id = $1 AND airline_id = $2',
        [routeId, airlineId]
      );
      if (!routeResult.rows[0]) {
        return res.status(404).json({ error: 'Route not found' });
      }

      const updates = [];
      const params = [];
      let paramIndex = 1;

      if (economy_price !== undefined) { updates.push(`economy_price = $${paramIndex++}`); params.push(economy_price); }
      if (business_price !== undefined) { updates.push(`business_price = $${paramIndex++}`); params.push(business_price || null); }
      if (first_price !== undefined) { updates.push(`first_price = $${paramIndex++}`); params.push(first_price || null); }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      params.push(routeId);
      await pool.query(`UPDATE routes SET ${updates.join(', ')} WHERE id = $${paramIndex}`, params);

      // Read back the current prices and sync schedule/flights
      const priceResult = await pool.query(
        'SELECT economy_price, business_price, first_price FROM routes WHERE id = $1',
        [routeId]
      );
      if (priceResult.rows[0]) {
        const { economy_price: curEco, business_price: curBiz, first_price: curFir } = priceResult.rows[0];
        if (curEco != null) {
          // Sync weekly_schedule entries
          await pool.query(
            'UPDATE weekly_schedule SET economy_price = $1, business_price = $2, first_price = $3 WHERE route_id = $4',
            [curEco, curBiz ?? null, curFir ?? null, routeId]
          );
          // Sync future flights
          await pool.query(
            `UPDATE flights SET economy_price = $1, business_price = $2, first_price = $3 WHERE status IN ('scheduled','boarding') AND (route_id = $4 OR weekly_schedule_id IN (SELECT id FROM weekly_schedule WHERE route_id = $4))`,
            [curEco, curBiz ?? null, curFir ?? null, routeId]
          );
        }
      }

      res.json({ message: 'Route updated successfully' });
    } catch (error) {
      console.error('Update route error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Delete route
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const routeId = parseInt(req.params.id);
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const routeResult = await pool.query(
      'SELECT id, flight_number FROM routes WHERE id = $1 AND airline_id = $2',
      [routeId, airlineId]
    );
    if (!routeResult.rows[0]) {
      return res.status(404).json({ error: 'Route not found' });
    }
    const flightNumber = routeResult.rows[0].flight_number;

    // Block deletion if route is used in any aircraft schedule
    const schedResult = await pool.query(`
      SELECT ac.registration FROM weekly_schedule ws
      JOIN aircraft ac ON ws.aircraft_id = ac.id
      WHERE ws.flight_number = $1 AND ac.airline_id = $2
      GROUP BY ac.registration
    `, [flightNumber, airlineId]);
    const usedBy = schedResult.rows.map(r => r.registration);

    if (usedBy.length > 0) {
      return res.status(400).json({
        error: `Route ${flightNumber} is scheduled on aircraft: ${usedBy.join(', ')}. Remove it from those flight plans first.`
      });
    }

    await pool.query('DELETE FROM routes WHERE id = $1', [routeId]);

    res.json({ message: 'Route deleted successfully' });
  } catch (error) {
    console.error('Delete route error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get aircraft scheduled on a specific route
router.get('/:id/aircraft', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const result = await pool.query(`
      SELECT ac.id, ac.registration, ac.name, at.full_name, ac.is_active,
             COUNT(ws.id) as slot_count
      FROM weekly_schedule ws
      JOIN aircraft ac ON ws.aircraft_id = ac.id
      JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      WHERE ws.route_id = $1 AND ac.airline_id = $2
      GROUP BY ac.id, ac.registration, ac.name, at.full_name, ac.is_active
      ORDER BY ac.registration ASC
    `, [req.params.id, airlineId]);

    const aircraft = result.rows.map(r => ({
      id: r.id, registration: r.registration, name: r.name,
      type: r.full_name, is_active: r.is_active, slot_count: parseInt(r.slot_count)
    }));
    res.json({ aircraft });
  } catch (error) {
    console.error('Get route aircraft error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
