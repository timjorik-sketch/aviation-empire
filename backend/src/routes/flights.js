import express from 'express';
import { body, validationResult } from 'express-validator';
import { getDatabase, saveDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// Calculate flight duration based on distance (assuming 850 km/h cruise speed)
function calculateFlightDuration(distanceKm) {
  const cruiseSpeedKmh = 850;
  const taxiTimeMinutes = 30; // taxi, takeoff, landing
  const flightHours = distanceKm / cruiseSpeedKmh;
  const totalMinutes = Math.round(flightHours * 60) + taxiTimeMinutes;
  return totalMinutes;
}

// Simulate passenger bookings based on price and demand
function simulateBookings(totalSeats, ticketPrice, distanceKm) {
  // Base demand factor (0.5 - 0.95 based on price competitiveness)
  const basePricePerKm = 0.12; // $0.12 per km is competitive
  const competitivePrice = distanceKm * basePricePerKm;
  const priceRatio = competitivePrice / ticketPrice;

  // Demand factor based on price (higher price = lower demand)
  let demandFactor = Math.min(0.95, Math.max(0.3, priceRatio * 0.7 + 0.2));

  // Add some randomness (+/- 15%)
  const randomFactor = 0.85 + Math.random() * 0.3;
  demandFactor *= randomFactor;

  // Calculate seats sold
  const seatsSold = Math.min(totalSeats, Math.round(totalSeats * demandFactor));
  return seatsSold;
}

// Get all flights for airline
router.get('/', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();

    // Get airline ID
    const airlineStmt = db.prepare('SELECT id FROM airlines WHERE user_id = ?');
    airlineStmt.bind([req.userId]);

    if (!airlineStmt.step()) {
      airlineStmt.free();
      return res.status(400).json({ error: 'No airline found' });
    }

    const airlineId = airlineStmt.get()[0];
    airlineStmt.free();

    // Get flights with route and aircraft details
    const flightsStmt = db.prepare(`
      SELECT
        f.id, f.flight_number, f.departure_time, f.arrival_time,
        f.ticket_price, f.total_seats, f.seats_sold, f.status, f.revenue, f.created_at,
        r.departure_airport, r.arrival_airport, r.distance_km,
        dep.name as departure_name, arr.name as arrival_name,
        ac.registration, at.full_name as aircraft_type
      FROM flights f
      JOIN routes r ON f.route_id = r.id
      JOIN airports dep ON r.departure_airport = dep.iata_code
      JOIN airports arr ON r.arrival_airport = arr.iata_code
      JOIN aircraft ac ON f.aircraft_id = ac.id
      JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      WHERE f.airline_id = ?
      ORDER BY f.departure_time DESC
    `);
    flightsStmt.bind([airlineId]);

    const flights = [];
    while (flightsStmt.step()) {
      const row = flightsStmt.get();
      flights.push({
        id: row[0],
        flight_number: row[1],
        departure_time: row[2],
        arrival_time: row[3],
        ticket_price: row[4],
        total_seats: row[5],
        seats_sold: row[6],
        status: row[7],
        revenue: row[8],
        created_at: row[9],
        departure_airport: row[10],
        arrival_airport: row[11],
        distance_km: row[12],
        departure_name: row[13],
        arrival_name: row[14],
        aircraft_registration: row[15],
        aircraft_type: row[16]
      });
    }
    flightsStmt.free();

    res.json({ flights });
  } catch (error) {
    console.error('Get flights error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get routes available for scheduling (with assigned aircraft)
router.get('/available-routes', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();

    // Get airline ID
    const airlineStmt = db.prepare('SELECT id FROM airlines WHERE user_id = ?');
    airlineStmt.bind([req.userId]);

    if (!airlineStmt.step()) {
      airlineStmt.free();
      return res.status(400).json({ error: 'No airline found' });
    }

    const airlineId = airlineStmt.get()[0];
    airlineStmt.free();

    // Get routes with assigned aircraft
    const routesStmt = db.prepare(`
      SELECT
        r.id, r.flight_number, r.departure_airport, r.arrival_airport, r.distance_km,
        ac.id as aircraft_id, ac.registration,
        at.full_name as aircraft_type, at.max_seats
      FROM routes r
      JOIN aircraft ac ON r.aircraft_id = ac.id
      JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      WHERE r.airline_id = ? AND r.aircraft_id IS NOT NULL
      ORDER BY r.flight_number
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
        aircraft_id: row[5],
        aircraft_registration: row[6],
        aircraft_type: row[7],
        max_seats: row[8],
        estimated_duration: calculateFlightDuration(row[4])
      });
    }
    routesStmt.free();

    res.json({ routes });
  } catch (error) {
    console.error('Get available routes error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Schedule a new flight
router.post('/schedule',
  authMiddleware,
  body('route_id').isInt({ min: 1 }).withMessage('Invalid route ID'),
  body('ticket_price').isFloat({ min: 1 }).withMessage('Ticket price must be positive'),
  body('departure_time').optional().isISO8601().withMessage('Invalid departure time'),
  (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { route_id, ticket_price, departure_time } = req.body;
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

      // Get route with aircraft details
      const routeStmt = db.prepare(`
        SELECT r.id, r.flight_number, r.distance_km, r.aircraft_id,
               at.max_seats
        FROM routes r
        JOIN aircraft ac ON r.aircraft_id = ac.id
        JOIN aircraft_types at ON ac.aircraft_type_id = at.id
        WHERE r.id = ? AND r.airline_id = ?
      `);
      routeStmt.bind([route_id, airlineId]);

      if (!routeStmt.step()) {
        routeStmt.free();
        return res.status(400).json({ error: 'Route not found or no aircraft assigned' });
      }

      const routeRow = routeStmt.get();
      const route = {
        id: routeRow[0],
        flight_number: routeRow[1],
        distance_km: routeRow[2],
        aircraft_id: routeRow[3],
        max_seats: routeRow[4]
      };
      routeStmt.free();

      if (!route.aircraft_id) {
        return res.status(400).json({ error: 'No aircraft assigned to this route' });
      }

      // Calculate flight times
      const flightDurationMinutes = calculateFlightDuration(route.distance_km);
      const depTime = departure_time ? new Date(departure_time) : new Date();
      const arrTime = new Date(depTime.getTime() + flightDurationMinutes * 60 * 1000);

      // Simulate bookings
      const seatsSold = simulateBookings(route.max_seats, ticket_price, route.distance_km);

      // Create flight
      const insertStmt = db.prepare(`
        INSERT INTO flights (airline_id, route_id, aircraft_id, flight_number,
                            departure_time, arrival_time, ticket_price, total_seats, seats_sold, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')
      `);
      insertStmt.bind([
        airlineId,
        route.id,
        route.aircraft_id,
        route.flight_number,
        depTime.toISOString(),
        arrTime.toISOString(),
        ticket_price,
        route.max_seats,
        seatsSold
      ]);
      insertStmt.step();
      insertStmt.free();

      // Get created flight ID
      const fetchStmt = db.prepare('SELECT last_insert_rowid()');
      fetchStmt.step();
      const flightId = fetchStmt.get()[0];
      fetchStmt.free();

      saveDatabase();

      res.status(201).json({
        message: 'Flight scheduled successfully',
        flight: {
          id: flightId,
          flight_number: route.flight_number,
          departure_time: depTime.toISOString(),
          arrival_time: arrTime.toISOString(),
          ticket_price,
          total_seats: route.max_seats,
          seats_sold: seatsSold,
          status: 'scheduled',
          estimated_revenue: seatsSold * ticket_price
        }
      });
    } catch (error) {
      console.error('Schedule flight error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Cancel a flight
router.post('/:id/cancel', authMiddleware, (req, res) => {
  try {
    const flightId = parseInt(req.params.id);
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

    // Get flight and verify ownership
    const flightStmt = db.prepare('SELECT id, status FROM flights WHERE id = ? AND airline_id = ?');
    flightStmt.bind([flightId, airlineId]);

    if (!flightStmt.step()) {
      flightStmt.free();
      return res.status(404).json({ error: 'Flight not found' });
    }

    const status = flightStmt.get()[1];
    flightStmt.free();

    if (status === 'completed' || status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot cancel a completed or already cancelled flight' });
    }

    // Cancel flight
    const updateStmt = db.prepare('UPDATE flights SET status = ? WHERE id = ?');
    updateStmt.bind(['cancelled', flightId]);
    updateStmt.step();
    updateStmt.free();

    saveDatabase();

    res.json({ message: 'Flight cancelled successfully' });
  } catch (error) {
    console.error('Cancel flight error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Process flights - update statuses and calculate revenue
function processFlights() {
  try {
    const db = getDatabase();
    if (!db) return;

    const now = new Date();

    // Update scheduled flights to boarding (15 min before departure)
    const boardingStmt = db.prepare(`
      UPDATE flights
      SET status = 'boarding'
      WHERE status = 'scheduled'
      AND datetime(departure_time) <= datetime(?, '+15 minutes')
    `);
    boardingStmt.bind([now.toISOString()]);
    boardingStmt.step();
    boardingStmt.free();

    // Update boarding flights to in-flight (after departure time)
    const inflightStmt = db.prepare(`
      UPDATE flights
      SET status = 'in-flight'
      WHERE status = 'boarding'
      AND datetime(departure_time) <= datetime(?)
    `);
    inflightStmt.bind([now.toISOString()]);
    inflightStmt.step();
    inflightStmt.free();

    // Complete flights that have arrived and calculate revenue
    const completedStmt = db.prepare(`
      SELECT id, airline_id, seats_sold, ticket_price
      FROM flights
      WHERE status = 'in-flight'
      AND datetime(arrival_time) <= datetime(?)
    `);
    completedStmt.bind([now.toISOString()]);

    const completedFlights = [];
    while (completedStmt.step()) {
      const row = completedStmt.get();
      completedFlights.push({
        id: row[0],
        airline_id: row[1],
        seats_sold: row[2],
        ticket_price: row[3]
      });
    }
    completedStmt.free();

    // Process each completed flight
    for (const flight of completedFlights) {
      const revenue = flight.seats_sold * flight.ticket_price;

      // Update flight status and revenue
      const updateFlightStmt = db.prepare('UPDATE flights SET status = ?, revenue = ? WHERE id = ?');
      updateFlightStmt.bind(['completed', revenue, flight.id]);
      updateFlightStmt.step();
      updateFlightStmt.free();

      // Add revenue to airline balance
      const updateBalanceStmt = db.prepare('UPDATE airlines SET balance = balance + ? WHERE id = ?');
      updateBalanceStmt.bind([revenue, flight.airline_id]);
      updateBalanceStmt.step();
      updateBalanceStmt.free();

      console.log(`Flight ${flight.id} completed. Revenue: $${revenue.toLocaleString()}`);
    }

    if (completedFlights.length > 0) {
      saveDatabase();
    }
  } catch (error) {
    console.error('Process flights error:', error);
  }
}

// Start flight processor (runs every 10 seconds)
let flightProcessorInterval = null;

function startFlightProcessor() {
  if (flightProcessorInterval) return;

  console.log('Starting flight processor...');
  flightProcessorInterval = setInterval(processFlights, 10000);
  // Run immediately on start
  setTimeout(processFlights, 1000);
}

function stopFlightProcessor() {
  if (flightProcessorInterval) {
    clearInterval(flightProcessorInterval);
    flightProcessorInterval = null;
  }
}

export default router;
export { startFlightProcessor, stopFlightProcessor, processFlights };
