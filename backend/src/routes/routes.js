import express from 'express';
import { body, validationResult } from 'express-validator';
import { getDatabase, saveDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// Airport coordinates for distance calculation (approximate)
const airportCoordinates = {
  'FRA': { lat: 50.0379, lon: 8.5622 },
  'MUC': { lat: 48.3538, lon: 11.7861 },
  'BER': { lat: 52.3667, lon: 13.5033 },
  'LHR': { lat: 51.4700, lon: -0.4543 },
  'LGW': { lat: 51.1537, lon: -0.1821 },
  'MAN': { lat: 53.3539, lon: -2.2750 },
  'CDG': { lat: 49.0097, lon: 2.5479 },
  'ORY': { lat: 48.7233, lon: 2.3794 },
  'AMS': { lat: 52.3105, lon: 4.7683 },
  'JFK': { lat: 40.6413, lon: -73.7781 },
  'LAX': { lat: 33.9425, lon: -118.4081 },
  'ORD': { lat: 41.9742, lon: -87.9073 },
  'ATL': { lat: 33.6407, lon: -84.4277 },
  'DXB': { lat: 25.2532, lon: 55.3657 },
  'SIN': { lat: 1.3644, lon: 103.9915 },
  'NRT': { lat: 35.7720, lon: 140.3929 },
  'HND': { lat: 35.5494, lon: 139.7798 },
  'SYD': { lat: -33.9399, lon: 151.1753 }
};

// Calculate distance between two airports using Haversine formula
function calculateDistance(dep, arr) {
  const depCoords = airportCoordinates[dep];
  const arrCoords = airportCoordinates[arr];

  if (!depCoords || !arrCoords) {
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

// Get all routes for airline
router.get('/', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();

    // Get airline ID
    const airlineStmt = db.prepare('SELECT id, airline_code FROM airlines WHERE user_id = ?');
    airlineStmt.bind([req.userId]);

    if (!airlineStmt.step()) {
      airlineStmt.free();
      return res.status(400).json({ error: 'No airline found' });
    }

    const airlineRow = airlineStmt.get();
    const airlineId = airlineRow[0];
    const airlineCode = airlineRow[1];
    airlineStmt.free();

    // Get routes with airport and aircraft details
    const routesStmt = db.prepare(`
      SELECT
        r.id, r.flight_number, r.departure_airport, r.arrival_airport,
        r.distance_km, r.created_at, r.aircraft_id,
        dep.name as departure_name, dep.country as departure_country,
        arr.name as arrival_name, arr.country as arrival_country,
        ac.registration, ac.name as aircraft_name,
        at.full_name as aircraft_type
      FROM routes r
      JOIN airports dep ON r.departure_airport = dep.iata_code
      JOIN airports arr ON r.arrival_airport = arr.iata_code
      LEFT JOIN aircraft ac ON r.aircraft_id = ac.id
      LEFT JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      WHERE r.airline_id = ?
      ORDER BY r.created_at DESC
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
        aircraft_id: row[6],
        departure_name: row[7],
        departure_country: row[8],
        arrival_name: row[9],
        arrival_country: row[10],
        aircraft_registration: row[11],
        aircraft_name: row[12],
        aircraft_type: row[13]
      });
    }
    routesStmt.free();

    res.json({ routes, airline_code: airlineCode });
  } catch (error) {
    console.error('Get routes error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new route
router.post('/create',
  authMiddleware,
  body('departure_airport').matches(/^[A-Z]{3}$/).withMessage('Invalid departure airport code'),
  body('arrival_airport').matches(/^[A-Z]{3}$/).withMessage('Invalid arrival airport code'),
  body('aircraft_id').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Invalid aircraft ID'),
  (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { departure_airport, arrival_airport, aircraft_id } = req.body;
      const db = getDatabase();

      // Validate airports are different
      if (departure_airport === arrival_airport) {
        return res.status(400).json({ error: 'Departure and arrival airports must be different' });
      }

      // Get airline
      const airlineStmt = db.prepare('SELECT id, airline_code FROM airlines WHERE user_id = ?');
      airlineStmt.bind([req.userId]);

      if (!airlineStmt.step()) {
        airlineStmt.free();
        return res.status(400).json({ error: 'No airline found' });
      }

      const airlineRow = airlineStmt.get();
      const airlineId = airlineRow[0];
      const airlineCode = airlineRow[1];
      airlineStmt.free();

      // Verify departure airport exists
      const depStmt = db.prepare('SELECT iata_code FROM airports WHERE iata_code = ?');
      depStmt.bind([departure_airport]);
      if (!depStmt.step()) {
        depStmt.free();
        return res.status(400).json({ error: 'Departure airport not found' });
      }
      depStmt.free();

      // Verify arrival airport exists
      const arrStmt = db.prepare('SELECT iata_code FROM airports WHERE iata_code = ?');
      arrStmt.bind([arrival_airport]);
      if (!arrStmt.step()) {
        arrStmt.free();
        return res.status(400).json({ error: 'Arrival airport not found' });
      }
      arrStmt.free();

      // Check if route already exists
      const existsStmt = db.prepare(
        'SELECT id FROM routes WHERE airline_id = ? AND departure_airport = ? AND arrival_airport = ?'
      );
      existsStmt.bind([airlineId, departure_airport, arrival_airport]);
      if (existsStmt.step()) {
        existsStmt.free();
        return res.status(400).json({ error: 'Route already exists' });
      }
      existsStmt.free();

      // Verify aircraft belongs to airline if provided
      if (aircraft_id) {
        const acStmt = db.prepare('SELECT id FROM aircraft WHERE id = ? AND airline_id = ?');
        acStmt.bind([aircraft_id, airlineId]);
        if (!acStmt.step()) {
          acStmt.free();
          return res.status(400).json({ error: 'Aircraft not found or not owned' });
        }
        acStmt.free();
      }

      // Calculate distance
      const distance = calculateDistance(departure_airport, arrival_airport);

      // Generate flight number (airline code + 3-4 digit number)
      const countStmt = db.prepare('SELECT COUNT(*) FROM routes WHERE airline_id = ?');
      countStmt.bind([airlineId]);
      countStmt.step();
      const routeCount = countStmt.get()[0];
      countStmt.free();

      const flightNumber = `${airlineCode}${(100 + routeCount).toString()}`;

      // Create route
      const insertStmt = db.prepare(
        'INSERT INTO routes (airline_id, departure_airport, arrival_airport, aircraft_id, flight_number, distance_km) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insertStmt.bind([airlineId, departure_airport, arrival_airport, aircraft_id || null, flightNumber, distance]);
      insertStmt.step();
      insertStmt.free();

      // Get the created route
      const fetchStmt = db.prepare('SELECT id FROM routes WHERE airline_id = ? AND departure_airport = ? AND arrival_airport = ?');
      fetchStmt.bind([airlineId, departure_airport, arrival_airport]);
      fetchStmt.step();
      const routeId = fetchStmt.get()[0];
      fetchStmt.free();

      saveDatabase();

      res.status(201).json({
        message: 'Route created successfully',
        route: {
          id: routeId,
          flight_number: flightNumber,
          departure_airport,
          arrival_airport,
          distance_km: distance,
          aircraft_id: aircraft_id || null
        }
      });
    } catch (error) {
      console.error('Create route error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Update route (assign/unassign aircraft)
router.patch('/:id',
  authMiddleware,
  body('aircraft_id').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Invalid aircraft ID'),
  (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const routeId = parseInt(req.params.id);
      const { aircraft_id } = req.body;
      const db = getDatabase();

      // Get airline
      const airlineStmt = db.prepare('SELECT id FROM airlines WHERE user_id = ?');
      airlineStmt.bind([req.userId]);

      if (!airlineStmt.step()) {
        airlineStmt.free();
        return res.status(400).json({ error: 'No airline found' });
      }

      const airlineId = airlineStmt.get()[0];
      airlineStmt.free();

      // Verify route belongs to airline
      const routeStmt = db.prepare('SELECT id FROM routes WHERE id = ? AND airline_id = ?');
      routeStmt.bind([routeId, airlineId]);
      if (!routeStmt.step()) {
        routeStmt.free();
        return res.status(404).json({ error: 'Route not found' });
      }
      routeStmt.free();

      // Verify aircraft if provided
      if (aircraft_id) {
        const acStmt = db.prepare('SELECT id FROM aircraft WHERE id = ? AND airline_id = ?');
        acStmt.bind([aircraft_id, airlineId]);
        if (!acStmt.step()) {
          acStmt.free();
          return res.status(400).json({ error: 'Aircraft not found or not owned' });
        }
        acStmt.free();
      }

      // Update route
      const updateStmt = db.prepare('UPDATE routes SET aircraft_id = ? WHERE id = ?');
      updateStmt.bind([aircraft_id || null, routeId]);
      updateStmt.step();
      updateStmt.free();

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

    // Get airline
    const airlineStmt = db.prepare('SELECT id FROM airlines WHERE user_id = ?');
    airlineStmt.bind([req.userId]);

    if (!airlineStmt.step()) {
      airlineStmt.free();
      return res.status(400).json({ error: 'No airline found' });
    }

    const airlineId = airlineStmt.get()[0];
    airlineStmt.free();

    // Verify route belongs to airline
    const routeStmt = db.prepare('SELECT id FROM routes WHERE id = ? AND airline_id = ?');
    routeStmt.bind([routeId, airlineId]);
    if (!routeStmt.step()) {
      routeStmt.free();
      return res.status(404).json({ error: 'Route not found' });
    }
    routeStmt.free();

    // Delete route
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

export default router;
