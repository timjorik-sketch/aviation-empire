import express from 'express';
import { body, validationResult } from 'express-validator';
import { getDatabase, saveDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';
import { calcFlightSatisfaction, getAirlineSatisfactionScore, getSatisfactionMultiplier } from '../utils/satisfaction.js';

const router = express.Router();

// Financial constants for flight cost calculation
const FUEL_MIN_PER_KG = 0.20;     // Minimum fuel price USD/kg
const FUEL_MAX_PER_KG = 1.30;     // Maximum fuel price USD/kg
const ATC_RATE_PER_KM = 0.50;     // USD per km for ATC/navigation fees

// XP progression thresholds (cumulative total_points needed to reach each level index)
// Index = level number. threshold[1]=1000 means you need 1000 XP to reach level 2.
const XP_THRESHOLDS = [0, 1000, 3500, 8500, 18500, 36500, 66500, 111500, 176500, 266500, 386500, 546500, 756500, 1036500, 1406500];

function calcFlightXP(distanceKm, loadFactor) {
  const distMult = distanceKm >= 3000 ? 2.0 : distanceKm >= 1000 ? 1.5 : 1.0;
  const loadMult = loadFactor >= 0.9 ? 1.2 : loadFactor >= 0.8 ? 1.1 : loadFactor >= 0.7 ? 1.0 : 0.8;
  return Math.round(50 * distMult * loadMult);
}

function checkLevelUp(db, airlineId) {
  const stmt = db.prepare('SELECT level, total_points FROM airlines WHERE id = ?');
  stmt.bind([airlineId]);
  if (!stmt.step()) { stmt.free(); return { leveledUp: false }; }
  const row = stmt.get();
  const currentLevel = row[0], totalPoints = row[1];
  stmt.free();
  let newLevel = currentLevel;
  while (newLevel < 15 && totalPoints >= XP_THRESHOLDS[newLevel]) newLevel++;
  if (newLevel > currentLevel) {
    const upd = db.prepare('UPDATE airlines SET level = ? WHERE id = ?');
    upd.bind([newLevel, airlineId]);
    upd.step();
    upd.free();
    console.log(`[XP] Airline ${airlineId}: Level ${currentLevel} → ${newLevel}!`);
    return { leveledUp: true, oldLevel: currentLevel, newLevel };
  }
  return { leveledUp: false, newLevel: currentLevel };
}

// Calculate flight duration based on distance (assuming 850 km/h cruise speed)
function calculateFlightDuration(distanceKm) {
  const cruiseSpeedKmh = 850;
  const taxiTimeMinutes = 30; // taxi, takeoff, landing
  const flightHours = distanceKm / cruiseSpeedKmh;
  const totalMinutes = Math.round(flightHours * 60) + taxiTimeMinutes;
  return totalMinutes;
}

// ── Hidden market price calculation (NEVER exposed to user) ─────────────────

function calcBaseRate(d) {
  if (d <= 500)  return 0.20;
  if (d <= 1500) return 0.15;
  if (d <= 3000) return 0.12;
  if (d <= 6000) return 0.10;
  return 0.08;
}

function calcAirportPremium(cat1, cat2) {
  const P = { 8: 1.5, 7: 1.4, 6: 1.3, 5: 1.2, 4: 1.15, 3: 1.05, 2: 1.0, 1: 0.9 };
  return ((P[cat1] || 1.0) + (P[cat2] || 1.0)) / 2;
}

function calcDistanceMod(d) {
  if (d < 1000)  return 0.8;
  if (d <= 3000) return 1.0;
  return 1.2;
}

function calcMarketPrices(distKm, depCat, arrCat) {
  const eco = Math.round(distKm * calcBaseRate(distKm) * calcAirportPremium(depCat, arrCat) * calcDistanceMod(distKm));
  return {
    eco,
    biz:   Math.round(eco * (distKm < 1000 ? 2.5 : distKm < 3000 ? 3.0 : 4.0)),
    first: Math.round(eco * (distKm < 1000 ? 4.0 : distKm < 3000 ? 5.0 : 6.0)),
  };
}

// ── Demand system (HIDDEN) ────────────────────────────────────────────────────

function calcBaseDemandPerHour(depCat, arrCat) {
  const hi = Math.max(depCat, arrCat);
  const lo = Math.min(depCat, arrCat);
  if (lo >= 8)              return 25;
  if (lo >= 6)              return 20;
  if (hi >= 6 && lo >= 4)   return 15;
  if (lo >= 4)              return 8;
  if (hi >= 4 && lo >= 2)   return 5;
  return 3;
}

function calcPriceAttractiveness(actual, market) {
  if (!market || market <= 0) return 1.0;
  const ratio = actual / market;
  if (ratio < 0.8)   return 1.8;
  if (ratio < 1.0)   return 1.2;
  if (ratio < 1.2)   return 1.0;
  if (ratio < 1.35)  return 0.6;
  if (ratio < 1.5)   return 0.2;
  if (ratio < 1.7)   return 0.05;
  return 0.01;
}

function calcServiceFactor(db, serviceProfileId, cabinClass = 'economy') {
  if (!serviceProfileId) return 1.0;
  try {
    const priceCol = cabinClass === 'first' ? 'price_first'
                   : cabinClass === 'business' ? 'price_business'
                   : 'price_economy';
    const stmt = db.prepare(
      `SELECT COALESCE(SUM(t.${priceCol}), 0) FROM service_profile_items i JOIN service_item_types t ON i.item_type_id = t.id WHERE i.profile_id = ? AND i.cabin_class = ?`
    );
    stmt.bind([serviceProfileId, cabinClass]);
    let cost = 0;
    if (stmt.step()) cost = stmt.get()[0] || 0;
    stmt.free();
    if (cost <= 5)   return 0.7;
    if (cost <= 15)  return 0.9;
    if (cost <= 35)  return 1.1;
    if (cost <= 60)  return 1.3;
    return 1.6;
  } catch { return 1.0; }
}

function calcConditionFactor(condition) {
  if (condition >= 80) return 1.0;
  if (condition >= 60) return 0.95;
  if (condition >= 40) return 0.85;
  if (condition >= 20) return 0.70;
  return 0.50;
}

// ── Distance-based catering cost (HIDDEN, deducted at landing) ───────────────
function calcCateringCost(distKm, bookedEco, bookedBiz, bookedFir) {
  let ecoRate, bizRate, firRate;
  if (distKm < 1000)      { ecoRate =  8; bizRate =  20; firRate =  40; }
  else if (distKm <= 3000) { ecoRate = 15; bizRate =  40; firRate =  80; }
  else                     { ecoRate = 30; bizRate = 150; firRate = 300; }
  return Math.round(ecoRate * (bookedEco || 0) + bizRate * (bookedBiz || 0) + firRate * (bookedFir || 0));
}

// Get all flights for airline
router.get('/', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();

    // Get airline ID
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Get flights with route and aircraft details
    const flightsStmt = db.prepare(`
      SELECT
        f.id, f.flight_number, f.departure_time, f.arrival_time,
        f.ticket_price, f.total_seats, f.seats_sold, f.status, f.revenue, f.created_at,
        r.departure_airport, r.arrival_airport, r.distance_km,
        dep.name as departure_name, arr.name as arrival_name,
        ac.registration, at.full_name as aircraft_type, f.aircraft_id,
        f.satisfaction_score, f.violated_rules
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
        aircraft_type: row[16],
        aircraft_id: row[17],
        satisfaction_score: row[18],
        violated_rules: row[19] ? JSON.parse(row[19]) : [],
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
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Get routes with assigned aircraft
    const routesStmt = db.prepare(`
      SELECT
        r.id, r.flight_number, r.departure_airport, r.arrival_airport, r.distance_km,
        ac.id as aircraft_id, ac.registration,
        at.full_name as aircraft_type, at.max_passengers
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
        max_passengers: row[8],
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
      const airlineId = req.airlineId;
      if (!airlineId) return res.status(400).json({ error: 'No active airline' });

      // Get route with aircraft details
      const routeStmt = db.prepare(`
        SELECT r.id, r.flight_number, r.distance_km, r.aircraft_id,
               at.max_passengers
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
        max_passengers: routeRow[4]
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
      const seatsSold = simulateBookings(route.max_passengers, ticket_price, route.distance_km);

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
        route.max_passengers,
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
          total_seats: route.max_passengers,
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

// Active flights for Live Map — flights currently in the air (status = 'in-flight')
router.get('/active', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Flights may have route_id (direct) OR weekly_schedule_id (schedule-based) — use COALESCE
    const stmt = db.prepare(`
      SELECT f.flight_number, f.departure_time, f.arrival_time,
             COALESCE(r.departure_airport, ws.departure_airport) as origin_iata,
             COALESCE(r.arrival_airport,   ws.arrival_airport)   as dest_iata,
             dep.latitude, dep.longitude, arr.latitude, arr.longitude,
             ac.registration
      FROM flights f
      LEFT JOIN routes r          ON f.route_id           = r.id
      LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
      LEFT JOIN airports dep ON COALESCE(r.departure_airport, ws.departure_airport) = dep.iata_code
      LEFT JOIN airports arr ON COALESCE(r.arrival_airport,   ws.arrival_airport)   = arr.iata_code
      LEFT JOIN aircraft ac  ON f.aircraft_id = ac.id
      WHERE f.airline_id = ? AND f.status = 'in-flight'
    `);
    stmt.bind([airlineId]);

    const now = Date.now();
    const flights = [];

    while (stmt.step()) {
      const [fn, depTime, arrTime, originIata, destIata, originLat, originLon, destLat, destLon, reg] = stmt.get();
      if (originLat == null || destLat == null) continue;

      const dep = new Date(depTime).getTime();
      const arr = new Date(arrTime).getTime();
      const total = arr - dep;
      if (total <= 0) continue;

      const progress = (now - dep) / total;
      if (progress <= 0 || progress >= 1) continue;

      const remaining_ms = Math.round((1 - progress) * total);
      flights.push({ flight_number: fn, registration: reg, origin_iata: originIata,
        destination_iata: destIata, origin_lat: originLat, origin_lon: originLon,
        dest_lat: destLat, dest_lon: destLon, progress, remaining_ms });
    }
    stmt.free();

    res.json({ flights });
  } catch (error) {
    console.error('Active flights map error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Edit a flight (PATCH /:id)
router.patch('/:id', authMiddleware, (req, res) => {
  try {
    const flightId = parseInt(req.params.id);
    const db = getDatabase();

    // Get airline
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Get flight and verify ownership
    const flightStmt = db.prepare(`
      SELECT f.id, f.status, f.aircraft_id, f.route_id, f.departure_time, f.arrival_time,
             f.ticket_price, f.total_seats, r.distance_km
      FROM flights f
      JOIN routes r ON f.route_id = r.id
      WHERE f.id = ? AND f.airline_id = ?
    `);
    flightStmt.bind([flightId, airlineId]);
    if (!flightStmt.step()) {
      flightStmt.free();
      return res.status(404).json({ error: 'Flight not found' });
    }
    const row = flightStmt.get();
    const flight = {
      id: row[0], status: row[1], aircraft_id: row[2], route_id: row[3],
      departure_time: row[4], arrival_time: row[5], ticket_price: row[6],
      total_seats: row[7], distance_km: row[8]
    };
    flightStmt.free();

    if (flight.status !== 'scheduled') {
      return res.status(400).json({ error: 'Only scheduled flights can be edited' });
    }

    const { departure_time, ticket_price, service_profile_id } = req.body;
    const updates = [];
    const params = [];

    let newDepTime = flight.departure_time;
    let newArrTime = flight.arrival_time;
    let newPrice = flight.ticket_price;

    // Validate service_profile_id if provided
    if (service_profile_id !== undefined) {
      if (service_profile_id !== null) {
        const spStmt = db.prepare('SELECT id FROM airline_service_profiles WHERE id = ? AND airline_id = ?');
        spStmt.bind([service_profile_id, airlineId]);
        if (!spStmt.step()) {
          spStmt.free();
          return res.status(400).json({ error: 'Service profile not found' });
        }
        spStmt.free();
      }
      updates.push('service_profile_id = ?');
      params.push(service_profile_id);
    }

    // Handle departure time change
    if (departure_time) {
      const depTime = new Date(departure_time);
      const durationMin = calculateFlightDuration(flight.distance_km);
      const arrTime = new Date(depTime.getTime() + durationMin * 60 * 1000);
      newDepTime = depTime.toISOString();
      newArrTime = arrTime.toISOString();

      // Check overlap with other flights on same aircraft (excluding this flight)
      const GROUND_TIME_MS = 30 * 60 * 1000;
      const overlapStmt = db.prepare(`
        SELECT f.departure_time, f.arrival_time
        FROM flights f
        WHERE f.aircraft_id = ? AND f.airline_id = ? AND f.id != ? AND f.status != 'cancelled'
      `);
      overlapStmt.bind([flight.aircraft_id, airlineId, flightId]);
      while (overlapStmt.step()) {
        const oRow = overlapStmt.get();
        const existDep = new Date(oRow[0]);
        const existArr = new Date(oRow[1]);
        const existEnd = new Date(existArr.getTime() + GROUND_TIME_MS);
        const newEnd = new Date(arrTime.getTime() + GROUND_TIME_MS);
        if (depTime < existEnd && existDep < newEnd) {
          overlapStmt.free();
          return res.status(400).json({ error: 'New time overlaps with an existing flight' });
        }
      }
      overlapStmt.free();

      // Check overlap with maintenance
      const maintStmt = db.prepare(`
        SELECT start_time, end_time FROM maintenance_schedule
        WHERE aircraft_id = ? AND airline_id = ?
      `);
      maintStmt.bind([flight.aircraft_id, airlineId]);
      while (maintStmt.step()) {
        const mRow = maintStmt.get();
        const mStart = new Date(mRow[0]);
        const mEnd = new Date(mRow[1]);
        if (depTime < mEnd && mStart < arrTime) {
          maintStmt.free();
          return res.status(400).json({ error: 'New time overlaps with a maintenance window' });
        }
      }
      maintStmt.free();

      updates.push('departure_time = ?', 'arrival_time = ?');
      params.push(newDepTime, newArrTime);
    }

    // Handle price change -> re-simulate bookings
    if (ticket_price !== undefined) {
      newPrice = ticket_price;
      const seatsSold = simulateBookings(flight.total_seats, newPrice, flight.distance_km);
      updates.push('ticket_price = ?', 'seats_sold = ?');
      params.push(newPrice, seatsSold);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    params.push(flightId);
    const sql = `UPDATE flights SET ${updates.join(', ')} WHERE id = ?`;
    const updateStmt = db.prepare(sql);
    updateStmt.bind(params);
    updateStmt.step();
    updateStmt.free();

    saveDatabase();

    // Fetch updated flight
    const updatedStmt = db.prepare(`
      SELECT f.id, f.flight_number, f.departure_time, f.arrival_time,
             f.ticket_price, f.total_seats, f.seats_sold, f.status, f.service_profile_id,
             r.departure_airport, r.arrival_airport
      FROM flights f
      JOIN routes r ON f.route_id = r.id
      WHERE f.id = ?
    `);
    updatedStmt.bind([flightId]);
    updatedStmt.step();
    const uRow = updatedStmt.get();
    updatedStmt.free();

    res.json({
      message: 'Flight updated successfully',
      flight: {
        id: uRow[0], flight_number: uRow[1], departure_time: uRow[2],
        arrival_time: uRow[3], ticket_price: uRow[4], total_seats: uRow[5],
        seats_sold: uRow[6], status: uRow[7], service_profile_id: uRow[8],
        departure_airport: uRow[9], arrival_airport: uRow[10]
      }
    });
  } catch (error) {
    console.error('Edit flight error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a flight (DELETE /:id)
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const flightId = parseInt(req.params.id);
    const db = getDatabase();

    // Get airline
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Get airline balance for penalty
    const airlineBalStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    airlineBalStmt.bind([airlineId]);
    airlineBalStmt.step();
    const currentBalance = airlineBalStmt.get()[0];
    airlineBalStmt.free();

    // Get flight and verify ownership
    const flightStmt = db.prepare(`
      SELECT id, status, flight_number,
             booked_economy, booked_business, booked_first,
             economy_price, business_price, first_price,
             booking_revenue_collected
      FROM flights WHERE id = ? AND airline_id = ?
    `);
    flightStmt.bind([flightId, airlineId]);
    if (!flightStmt.step()) {
      flightStmt.free();
      return res.status(404).json({ error: 'Flight not found' });
    }
    const fr = flightStmt.get();
    const [, status, flightNumber,
      bookedEco, bookedBiz, bookedFirst,
      ecoPrice, bizPrice, firstPrice,
      bookingRevenueCollected] = fr;
    flightStmt.free();

    if (status === 'completed') {
      return res.status(400).json({ error: 'Cannot delete a completed flight' });
    }

    // Apply cancellation penalty if revenue was already collected
    if (bookingRevenueCollected) {
      const penalty = Math.round(
        (bookedEco   || 0) * (ecoPrice   || 0) * 1.2 +
        (bookedBiz   || 0) * (bizPrice   || ecoPrice || 0) * 1.2 +
        (bookedFirst || 0) * (firstPrice || ecoPrice || 0) * 1.2
      );
      if (penalty > 0) {
        const updBalStmt = db.prepare('UPDATE airlines SET balance = ? WHERE id = ?');
        updBalStmt.bind([currentBalance - penalty, airlineId]);
        updBalStmt.step();
        updBalStmt.free();

        const txStmt = db.prepare(
          "INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'other', ?, ?)"
        );
        txStmt.bind([airlineId, -penalty, `Flight Cancellation Penalty - ${flightNumber}`]);
        txStmt.step();
        txStmt.free();
      }
    }

    const deleteStmt = db.prepare('DELETE FROM flights WHERE id = ?');
    deleteStmt.bind([flightId]);
    deleteStmt.step();
    deleteStmt.free();

    saveDatabase();

    res.json({ message: 'Flight deleted successfully' });
  } catch (error) {
    console.error('Delete flight error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Cancel a flight
router.post('/:id/cancel', authMiddleware, (req, res) => {
  try {
    const flightId = parseInt(req.params.id);
    const db = getDatabase();

    // Get airline with balance
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });
    const airlineBalStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    airlineBalStmt.bind([airlineId]);
    if (!airlineBalStmt.step()) { airlineBalStmt.free(); return res.status(400).json({ error: 'No airline found' }); }
    const currentBalance = airlineBalStmt.get()[0];
    airlineBalStmt.free();

    // Get flight with booked passengers and prices
    const flightStmt = db.prepare(`
      SELECT id, status, flight_number,
             booked_economy, booked_business, booked_first,
             economy_price, business_price, first_price,
             booking_revenue_collected
      FROM flights WHERE id = ? AND airline_id = ?
    `);
    flightStmt.bind([flightId, airlineId]);
    if (!flightStmt.step()) {
      flightStmt.free();
      return res.status(404).json({ error: 'Flight not found' });
    }
    const fr = flightStmt.get();
    flightStmt.free();

    const [, status, flightNumber,
      bookedEco, bookedBiz, bookedFirst,
      ecoPrice, bizPrice, firstPrice,
      bookingRevenueCollected] = fr;

    if (status === 'completed' || status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot cancel a completed or already cancelled flight' });
    }
    if (status === 'in-flight') {
      return res.status(400).json({ error: 'Cannot cancel a flight that is already in the air' });
    }

    // Only apply refund + 20% penalty if booking revenue was already collected
    let penalty = 0;
    if (bookingRevenueCollected) {
      penalty = Math.round(
        (bookedEco   || 0) * (ecoPrice   || 0) * 1.2 +
        (bookedBiz   || 0) * (bizPrice   || ecoPrice || 0) * 1.2 +
        (bookedFirst || 0) * (firstPrice || ecoPrice || 0) * 1.2
      );
    }

    // Deduct penalty from balance and record transaction
    if (penalty > 0) {
      const newBalance = currentBalance - penalty;
      const updStmt = db.prepare('UPDATE airlines SET balance = ? WHERE id = ?');
      updStmt.bind([newBalance, airlineId]);
      updStmt.step(); updStmt.free();

      const txStmt = db.prepare("INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'other', ?, ?)");
      txStmt.bind([airlineId, -penalty, `Flight Cancellation Penalty - ${flightNumber}`]);
      txStmt.step(); txStmt.free();
    }

    // Cancel flight
    const updateStmt = db.prepare("UPDATE flights SET status = 'cancelled' WHERE id = ?");
    updateStmt.bind([flightId]);
    updateStmt.step();
    updateStmt.free();

    saveDatabase();

    const totalPax = (bookedEco || 0) + (bookedBiz || 0) + (bookedFirst || 0);
    res.json({
      message: `Flight ${flightNumber} cancelled`,
      penalty,
      passengers_refunded: totalPax
    });
  } catch (error) {
    console.error('Cancel flight error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// CET helpers: interpret schedule times as Europe/Berlin local time
function getBerlinOffsetMin(date) {
  const str = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Berlin', timeZoneName: 'longOffset'
  }).format(date);
  const m = str.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 60; // CET fallback
  return (m[1] === '+' ? 1 : -1) * (parseInt(m[2]) * 60 + parseInt(m[3]));
}
function cetToUTC(cetDateStr, cetTimeStr) {
  const approxUTC = new Date(`${cetDateStr}T${cetTimeStr}:00Z`);
  const offset = getBerlinOffsetMin(approxUTC);
  return new Date(approxUTC.getTime() - offset * 60000);
}

// Generate flight instances from weekly_schedule templates for active aircraft (next 72h)
function generateFlights() {
  try {
    const db = getDatabase();
    if (!db) return;

    const now = new Date();
    const horizon = new Date(now.getTime() + 72 * 60 * 60 * 1000);

    // Active aircraft that have at least one weekly_schedule entry
    const acStmt = db.prepare(`
      SELECT a.id, a.airline_id, a.airline_cabin_profile_id, at.max_passengers, a.condition
      FROM aircraft a
      JOIN aircraft_types at ON a.aircraft_type_id = at.id
      WHERE a.is_active = 1
        AND EXISTS (SELECT 1 FROM weekly_schedule ws WHERE ws.aircraft_id = a.id)
    `);
    const aircraft = [];
    while (acStmt.step()) {
      const r = acStmt.get();
      aircraft.push({ id: r[0], airline_id: r[1], cabin_profile_id: r[2], max_passengers: r[3], condition: r[4] ?? 100 });
    }
    acStmt.free();

    let generated = 0;

    for (const ac of aircraft) {
      // Resolve per-class seat counts and seat types from cabin profile
      let ecoSeats = 0, bizSeats = 0, firstSeats = 0;
      let ecoSeatType = 'economy', bizSeatType = 'business', firstSeatType = 'first';
      if (ac.cabin_profile_id) {
        const clStmt = db.prepare(
          'SELECT class_type, actual_capacity, seat_type FROM airline_cabin_classes WHERE profile_id = ?'
        );
        clStmt.bind([ac.cabin_profile_id]);
        while (clStmt.step()) {
          const cr = clStmt.get();
          if (cr[0] === 'economy')       { ecoSeats = cr[1]; if (cr[2]) ecoSeatType = cr[2]; }
          else if (cr[0] === 'business') { bizSeats = cr[1]; if (cr[2]) bizSeatType = cr[2]; }
          else if (cr[0] === 'first')    { firstSeats = cr[1]; if (cr[2]) firstSeatType = cr[2]; }
        }
        clStmt.free();
      }
      const totalSeats = (ecoSeats + bizSeats + firstSeats) || ac.max_passengers;

      // Weekly schedule entries for this aircraft (join routes for distance_km)
      const wsStmt = db.prepare(`
        SELECT ws.id, ws.day_of_week, ws.flight_number,
               ws.departure_airport, ws.arrival_airport,
               ws.departure_time, ws.arrival_time,
               ws.economy_price, ws.business_price, ws.first_price,
               ws.route_id, ws.service_profile_id,
               COALESCE(r.distance_km, 0) as distance_km
        FROM weekly_schedule ws
        LEFT JOIN routes r ON ws.route_id = r.id
        WHERE ws.aircraft_id = ?
      `);
      wsStmt.bind([ac.id]);
      const entries = [];
      while (wsStmt.step()) {
        const r = wsStmt.get();
        entries.push({
          id: r[0], day_of_week: r[1], flight_number: r[2],
          dep_airport: r[3], arr_airport: r[4],
          dep_time: r[5], arr_time: r[6],
          eco_price: r[7], biz_price: r[8], first_price: r[9],
          route_id: r[10], service_profile_id: r[11],
          distance_km: r[12]
        });
      }
      wsStmt.free();
      if (!entries.length) continue;

      // Check each of the next 3 CET calendar days
      for (let d = 0; d < 3; d++) {
        const dayUTC = new Date(now.getTime() + d * 86400000);

        // Date string in Europe/Berlin (YYYY-MM-DD)
        const cetDateStr = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(dayUTC);

        // Day-of-week in Berlin: noon UTC on that CET date is always same calendar day
        const noonUTC = new Date(`${cetDateStr}T12:00:00Z`);
        const jsDay   = noonUTC.getUTCDay();   // 0=Sun
        const ourDay  = (jsDay + 6) % 7;       // 0=Mon

        for (const entry of entries) {
          if (entry.day_of_week !== ourDay) continue;

          // Parse dep_time as CET → UTC
          const depDT = cetToUTC(cetDateStr, entry.dep_time);
          if (depDT <= now || depDT > horizon) continue;

          // Arrival datetime (handles midnight overflow)
          const [dh, dm] = entry.dep_time.split(':').map(Number);
          const [ah, am] = entry.arr_time.split(':').map(Number);
          const dMin = dh * 60 + dm;
          const aMin = ah * 60 + am;
          const durMin = ((aMin - dMin) + 1440) % 1440 || 1;
          const arrDT = new Date(depDT.getTime() + durMin * 60000);

          // Dup check uses UTC date of the stored ISO departure_time
          const utcDateStr = depDT.toISOString().slice(0, 10);
          const dupStmt = db.prepare(
            'SELECT id FROM flights WHERE aircraft_id = ? AND weekly_schedule_id = ? AND date(departure_time) = ?'
          );
          dupStmt.bind([ac.id, entry.id, utcDateStr]);
          const dup = dupStmt.step();
          dupStmt.free();
          if (dup) continue;

          const ecoPrice   = entry.eco_price   ?? 0;
          const bizPrice   = entry.biz_price   ?? ecoPrice;
          const firstPrice = entry.first_price ?? ecoPrice;
          const distKm     = entry.distance_km || 1000;

          // Fetch airport categories for market price calculation
          let depCat = 4, arrCat = 4;
          try {
            const catStmt = db.prepare('SELECT iata_code, category FROM airports WHERE iata_code IN (?, ?)');
            catStmt.bind([entry.dep_airport, entry.arr_airport]);
            while (catStmt.step()) {
              const cr = catStmt.get();
              if (cr[0] === entry.dep_airport) depCat = cr[1] || 4;
              else arrCat = cr[1] || 4;
            }
            catStmt.free();
          } catch (e) { /* use defaults */ }

          // Calculate hidden market prices (NEVER exposed to user)
          const mp = calcMarketPrices(distKm, depCat, arrCat);
          const atcFee = Math.round(distKm * ATC_RATE_PER_KM);

          // Calculate passenger satisfaction score and violations for this flight
          const satEcoSeats = (ecoSeats + bizSeats + firstSeats > 0) ? ecoSeats : totalSeats;
          const { score: satisfactionScore, violations } = calcFlightSatisfaction(db, {
            distKm,
            serviceProfileId: entry.service_profile_id ?? null,
            condition: ac.condition ?? 100,
            ecoSeats: satEcoSeats,
            bizSeats,
            firstSeats,
            ecoSeatType,
            bizSeatType,
            firstSeatType,
          });
          const violatedRulesJson = JSON.stringify(violations);

          // Insert flight with 0 bookings — hourly booking processor fills it over 72h
          const insStmt = db.prepare(`
            INSERT INTO flights (
              airline_id, route_id, aircraft_id, flight_number,
              departure_time, arrival_time,
              ticket_price, economy_price, business_price, first_price,
              total_seats, seats_sold,
              booked_economy, booked_business, booked_first,
              status, weekly_schedule_id, service_profile_id,
              revenue, booking_revenue_collected, atc_fee,
              market_price_economy, market_price_business, market_price_first,
              satisfaction_score, violated_rules
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'scheduled', ?, ?, 0, 1, ?, ?, ?, ?, ?, ?)
          `);
          insStmt.bind([
            ac.airline_id, entry.route_id ?? null, ac.id, entry.flight_number,
            depDT.toISOString(), arrDT.toISOString(),
            ecoPrice, ecoPrice, entry.biz_price ?? null, entry.first_price ?? null,
            totalSeats,
            entry.id, entry.service_profile_id ?? null,
            atcFee, mp.eco, mp.biz, mp.first, satisfactionScore, violatedRulesJson
          ]);
          insStmt.step();
          insStmt.free();

          generated++;
        }
      }
    }

    if (generated > 0) {
      saveDatabase();
      console.log(`[FlightGen] Generated ${generated} flight(s) from weekly templates`);
    }
  } catch (err) {
    console.error('generateFlights error:', err);
  }
}

// ── Hourly booking processor (runs every hour) ────────────────────────────────
function processBookings() {
  try {
    const db = getDatabase();
    if (!db) return;

    const now = new Date();
    const windowEnd = new Date(now.getTime() + 72 * 60 * 60 * 1000);

    // Flights in 0–72h booking window that still have capacity
    const stmt = db.prepare(`
      SELECT f.id, f.airline_id, f.flight_number,
             COALESCE(f.economy_price, 0)  as eco_price,
             COALESCE(f.business_price, 0) as biz_price,
             COALESCE(f.first_price, 0)    as fir_price,
             COALESCE(f.booked_economy, 0)  as booked_eco,
             COALESCE(f.booked_business, 0) as booked_biz,
             COALESCE(f.booked_first, 0)    as booked_fir,
             COALESCE(f.market_price_economy, 0)  as mp_eco,
             COALESCE(f.market_price_business, 0) as mp_biz,
             COALESCE(f.market_price_first, 0)    as mp_fir,
             f.service_profile_id,
             f.total_seats,
             COALESCE(r.distance_km, ws_r.distance_km, 1000) as distance_km,
             COALESCE(dep_apt.category, 4) as dep_cat,
             COALESCE(arr_apt.category, 4) as arr_cat,
             COALESCE(ac.condition, 100)   as condition,
             COALESCE(eco_cl.actual_capacity, 0)  as eco_cap,
             COALESCE(biz_cl.actual_capacity, 0)  as biz_cap,
             COALESCE(fir_cl.actual_capacity, 0)  as fir_cap
      FROM flights f
      LEFT JOIN routes r          ON f.route_id = r.id
      LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
      LEFT JOIN routes ws_r        ON ws.route_id = ws_r.id
      LEFT JOIN airports dep_apt   ON dep_apt.iata_code = COALESCE(r.departure_airport, ws.departure_airport)
      LEFT JOIN airports arr_apt   ON arr_apt.iata_code = COALESCE(r.arrival_airport,   ws.arrival_airport)
      LEFT JOIN aircraft ac        ON f.aircraft_id = ac.id
      LEFT JOIN airline_cabin_classes eco_cl ON eco_cl.profile_id = ac.airline_cabin_profile_id AND eco_cl.class_type = 'economy'
      LEFT JOIN airline_cabin_classes biz_cl ON biz_cl.profile_id = ac.airline_cabin_profile_id AND biz_cl.class_type = 'business'
      LEFT JOIN airline_cabin_classes fir_cl ON fir_cl.profile_id = ac.airline_cabin_profile_id AND fir_cl.class_type = 'first'
      WHERE f.status IN ('scheduled', 'boarding')
        AND datetime(f.departure_time) > datetime(?)
        AND datetime(f.departure_time) <= datetime(?)
    `);
    stmt.bind([now.toISOString(), windowEnd.toISOString()]);

    const flightsList = [];
    while (stmt.step()) {
      const r = stmt.get();
      flightsList.push({
        id: r[0], airline_id: r[1], flight_number: r[2],
        eco_price: r[3], biz_price: r[4], fir_price: r[5],
        booked_eco: r[6], booked_biz: r[7], booked_fir: r[8],
        mp_eco: r[9], mp_biz: r[10], mp_fir: r[11],
        service_profile_id: r[12], total_seats: r[13], distance_km: r[14],
        dep_cat: r[15], arr_cat: r[16], condition: r[17],
        eco_cap: r[18], biz_cap: r[19], fir_cap: r[20],
      });
    }
    stmt.free();

    if (!flightsList.length) return;

    // Compute satisfaction-based booking multiplier once per airline
    const airlineSatMultipliers = {};
    for (const f of flightsList) {
      if (!(f.airline_id in airlineSatMultipliers)) {
        const avgScore = getAirlineSatisfactionScore(db, f.airline_id);
        airlineSatMultipliers[f.airline_id] = getSatisfactionMultiplier(avgScore);
      }
    }

    let totalNewPax = 0, totalRevenue = 0;
    // Accumulate revenue and pax per airline for a single consolidated transaction
    const airlineTotals = {}; // airline_id → { revenue, pax }

    for (const f of flightsList) {
      // Resolve per-class seat capacities
      let ecoCap = f.eco_cap;
      let bizCap = f.biz_cap;
      let firCap = f.fir_cap;
      if (ecoCap + bizCap + firCap === 0) {
        // No cabin profile → treat all seats as economy
        ecoCap = f.total_seats;
      }

      const baseDemand      = calcBaseDemandPerHour(f.dep_cat, f.arr_cat);
      const distMod         = calcDistanceMod(f.distance_km);
      const condFactor      = calcConditionFactor(f.condition);
      const svcEco  = calcServiceFactor(db, f.service_profile_id, 'economy');
      const svcBiz  = calcServiceFactor(db, f.service_profile_id, 'business');
      const svcFir  = calcServiceFactor(db, f.service_profile_id, 'first');
      const satMult = airlineSatMultipliers[f.airline_id] || 1.0;

      let newEco = 0, newBiz = 0, newFir = 0, addedRev = 0;

      if (f.eco_price > 0 && ecoCap > f.booked_eco) {
        const attr = calcPriceAttractiveness(f.eco_price, f.mp_eco || f.eco_price);
        const rate = baseDemand * distMod * attr * svcEco * condFactor * satMult;
        newEco = Math.max(0, Math.min(ecoCap - f.booked_eco,
          Math.round(rate * (0.85 + Math.random() * 0.30))));
        addedRev += newEco * f.eco_price;
      }

      if (f.biz_price > 0 && bizCap > f.booked_biz) {
        const attr = calcPriceAttractiveness(f.biz_price, f.mp_biz || f.biz_price);
        const rate = baseDemand * 0.15 * distMod * attr * svcBiz * condFactor * satMult;
        newBiz = Math.max(0, Math.min(bizCap - f.booked_biz,
          Math.round(rate * (0.85 + Math.random() * 0.30))));
        addedRev += newBiz * f.biz_price;
      }

      if (f.fir_price > 0 && firCap > f.booked_fir) {
        const attr = calcPriceAttractiveness(f.fir_price, f.mp_fir || f.fir_price);
        const rate = baseDemand * 0.05 * distMod * attr * svcFir * condFactor * satMult;
        newFir = Math.max(0, Math.min(firCap - f.booked_fir,
          Math.round(rate * (0.85 + Math.random() * 0.30))));
        addedRev += newFir * f.fir_price;
      }

      if (newEco + newBiz + newFir <= 0) continue;

      const newTotal = (f.booked_eco + newEco) + (f.booked_biz + newBiz) + (f.booked_fir + newFir);
      const revToAdd = Math.round(addedRev);

      const updStmt = db.prepare(`
        UPDATE flights SET
          booked_economy  = booked_economy  + ?,
          booked_business = booked_business + ?,
          booked_first    = booked_first    + ?,
          seats_sold      = ?,
          revenue         = revenue + ?
        WHERE id = ?
      `);
      updStmt.bind([newEco, newBiz, newFir, newTotal, revToAdd, f.id]);
      updStmt.step();
      updStmt.free();

      if (revToAdd > 0) {
        if (!airlineTotals[f.airline_id]) airlineTotals[f.airline_id] = { revenue: 0, pax: 0 };
        airlineTotals[f.airline_id].revenue += revToAdd;
        airlineTotals[f.airline_id].pax     += newEco + newBiz + newFir;
      }

      totalNewPax += newEco + newBiz + newFir;
      totalRevenue += revToAdd;
    }

    // One balance update + one transaction per airline
    for (const [airlineId, totals] of Object.entries(airlineTotals)) {
      if (totals.revenue <= 0) continue;
      const balStmt = db.prepare('UPDATE airlines SET balance = balance + ? WHERE id = ?');
      balStmt.bind([totals.revenue, Number(airlineId)]);
      balStmt.step();
      balStmt.free();

      const txStmt = db.prepare(
        "INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'flight_revenue', ?, ?)"
      );
      txStmt.bind([Number(airlineId), totals.revenue, `Ticket Sales (${totals.pax} passengers)`]);
      txStmt.step();
      txStmt.free();
    }

    if (totalNewPax > 0) {
      saveDatabase();
      console.log(`[Bookings] +${totalNewPax} pax, $${totalRevenue.toLocaleString()} revenue`);
    }
  } catch (err) {
    console.error('processBookings error:', err);
  }
}

// Backfill satisfaction_score for flights that have NULL scores (up to 30 per cycle)
function patchNullSatisfactionScores(db) {
  const findStmt = db.prepare(`
    SELECT f.id, f.service_profile_id, f.aircraft_id,
           COALESCE(r.distance_km, ws_r.distance_km, 1000) AS distance_km
    FROM flights f
    LEFT JOIN routes r ON f.route_id = r.id
    LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
    LEFT JOIN routes ws_r ON ws.route_id = ws_r.id
    WHERE f.satisfaction_score IS NULL AND f.status != 'cancelled'
    LIMIT 30
  `);
  const toFix = [];
  while (findStmt.step()) {
    const r = findStmt.get();
    toFix.push({ id: r[0], service_profile_id: r[1], aircraft_id: r[2], distance_km: r[3] || 1000 });
  }
  findStmt.free();

  for (const f of toFix) {
    let ecoSeats = 0, bizSeats = 0, firstSeats = 0;
    let ecoSeatType = 'economy', bizSeatType = 'business', firstSeatType = 'first';
    let condition = 100;

    if (f.aircraft_id) {
      const acStmt = db.prepare(`
        SELECT ac.airline_cabin_profile_id, ac.condition, at.max_passengers
        FROM aircraft ac JOIN aircraft_types at ON ac.aircraft_type_id = at.id
        WHERE ac.id = ?
      `);
      acStmt.bind([f.aircraft_id]);
      let cabinProfileId = null, maxPax = 100;
      if (acStmt.step()) {
        const ar = acStmt.get();
        cabinProfileId = ar[0];
        condition = ar[1] ?? 100;
        maxPax = ar[2] ?? 100;
      }
      acStmt.free();

      if (cabinProfileId) {
        const clStmt = db.prepare(
          'SELECT class_type, actual_capacity, seat_type FROM airline_cabin_classes WHERE profile_id = ?'
        );
        clStmt.bind([cabinProfileId]);
        while (clStmt.step()) {
          const cr = clStmt.get();
          if (cr[0] === 'economy')       { ecoSeats = cr[1]; if (cr[2]) ecoSeatType = cr[2]; }
          else if (cr[0] === 'business') { bizSeats = cr[1]; if (cr[2]) bizSeatType = cr[2]; }
          else if (cr[0] === 'first')    { firstSeats = cr[1]; if (cr[2]) firstSeatType = cr[2]; }
        }
        clStmt.free();
      }

      // No cabin profile or empty profile → treat all seats as economy
      if (ecoSeats + bizSeats + firstSeats === 0) ecoSeats = maxPax;
    }

    const { score: satScore, violations: satViolations } = calcFlightSatisfaction(db, {
      distKm: f.distance_km,
      serviceProfileId: f.service_profile_id ?? null,
      condition,
      ecoSeats,
      bizSeats,
      firstSeats,
      ecoSeatType,
      bizSeatType,
      firstSeatType,
    });

    const updStmt = db.prepare('UPDATE flights SET satisfaction_score = ?, violated_rules = ? WHERE id = ?');
    updStmt.bind([satScore, JSON.stringify(satViolations), f.id]);
    updStmt.step();
    updStmt.free();
  }

  if (toFix.length > 0) {
    console.log(`[SatBackfill] Patched satisfaction_score for ${toFix.length} flight(s)`);
  }
  return toFix.length;
}

// Process flights - update statuses and calculate revenue
function processFlights() {
  try {
    const db = getDatabase();
    if (!db) return;

    // Backfill any missing satisfaction scores from before the system existed
    patchNullSatisfactionScores(db);

    const now = new Date();

    // ── Maintenance completion: restore condition to 100% ──────────────────
    // game uses 0=Mon..6=Sun; JS getDay() uses 0=Sun..6=Sat
    const jsDay = now.getDay();
    const gameDow = jsDay === 0 ? 6 : jsDay - 1;
    const currentWeekMin = gameDow * 1440 + now.getHours() * 60 + now.getMinutes();

    // Maintenance cost base rates by wake turbulence category
    const MAINT_BASE_COST = { L: 2000, M: 8000, H: 15000 };

    const pendingMaintStmt = db.prepare(`
      SELECT ms.id, ms.aircraft_id, ms.day_of_week, ms.start_minutes, ms.duration_minutes, ms.airline_id
      FROM maintenance_schedule ms
      WHERE ms.last_completed_at IS NULL
         OR ms.last_completed_at < datetime('now', '-6 days')
    `);
    const pendingMaint = [];
    while (pendingMaintStmt.step()) {
      const r = pendingMaintStmt.get();
      pendingMaint.push({ id: r[0], aircraft_id: r[1], day_of_week: r[2], start_minutes: r[3], duration_minutes: r[4], airline_id: r[5] });
    }
    pendingMaintStmt.free();

    for (const m of pendingMaint) {
      const maintWeekMin = m.day_of_week * 1440 + m.start_minutes + m.duration_minutes;
      if (currentWeekMin >= maintWeekMin) {
        // Fetch aircraft condition and wake category at maintenance time
        const acInfoStmt = db.prepare(`
          SELECT a.condition, t.wake_turbulence_category, a.registration, a.home_airport
          FROM aircraft a
          JOIN aircraft_types t ON a.aircraft_type_id = t.id
          WHERE a.id = ?
        `);
        acInfoStmt.bind([m.aircraft_id]);
        let condition = 100, wakeCategory = 'M', registration = '', homeAirport = '';
        if (acInfoStmt.step()) {
          const ar = acInfoStmt.get();
          condition    = ar[0] ?? 100;
          wakeCategory = ar[1] ?? 'M';
          registration = ar[2] ?? '';
          homeAirport  = ar[3] ?? '';
        }
        acInfoStmt.free();

        // Restore condition to 100%
        const restoreStmt = db.prepare('UPDATE aircraft SET condition = 100 WHERE id = ?');
        restoreStmt.bind([m.aircraft_id]);
        restoreStmt.step();
        restoreStmt.free();

        // Calculate and deduct maintenance cost
        const baseCost  = MAINT_BASE_COST[wakeCategory] ?? MAINT_BASE_COST.M;
        const maintCost = Math.round(baseCost * (2 - condition / 100));

        if (maintCost > 0 && m.airline_id) {
          const deductStmt = db.prepare('UPDATE airlines SET balance = balance - ? WHERE id = ?');
          deductStmt.bind([maintCost, m.airline_id]);
          deductStmt.step();
          deductStmt.free();

          const txStmt = db.prepare(
            "INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'maintenance', ?, ?)"
          );
          const desc = `Maintenance - ${registration}${homeAirport ? ' - ' + homeAirport : ''}`;
          txStmt.bind([m.airline_id, -maintCost, desc]);
          txStmt.step();
          txStmt.free();
        }

        const markStmt = db.prepare('UPDATE maintenance_schedule SET last_completed_at = ? WHERE id = ?');
        markStmt.bind([now.toISOString(), m.id]);
        markStmt.step();
        markStmt.free();

        console.log(`[Maintenance] Aircraft ${m.aircraft_id} (${registration}) completed — condition restored to 100%, cost: $${maintCost.toLocaleString()}`);
      }
    }
    // ───────────────────────────────────────────────────────────────────────

    // Scheduled → Boarding (15 min before departure)
    // Check aircraft location: if not at departure airport → cancel with refund penalty.
    const boardingCandidatesStmt = db.prepare(`
      SELECT
        f.id, f.flight_number, f.airline_id, f.aircraft_id,
        COALESCE(r.departure_airport, ws.departure_airport) AS dep_airport,
        COALESCE(f.booked_economy,  0) AS booked_eco,
        COALESCE(f.booked_business, 0) AS booked_biz,
        COALESCE(f.booked_first,    0) AS booked_fir,
        COALESCE(f.economy_price,   0) AS eco_price,
        COALESCE(f.business_price,  0) AS biz_price,
        COALESCE(f.first_price,     0) AS fir_price,
        COALESCE(f.booking_revenue_collected, 0) AS rev_collected,
        ac.current_location
      FROM flights f
      LEFT JOIN routes r           ON f.route_id           = r.id
      LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
      LEFT JOIN aircraft ac        ON f.aircraft_id        = ac.id
      WHERE f.status = 'scheduled'
        AND datetime(f.departure_time) <= datetime(?, '+15 minutes')
    `);
    boardingCandidatesStmt.bind([now.toISOString()]);
    const boardingCandidates = [];
    while (boardingCandidatesStmt.step()) {
      const r = boardingCandidatesStmt.get();
      boardingCandidates.push({
        id: r[0], flight_number: r[1], airline_id: r[2], aircraft_id: r[3],
        dep_airport: r[4],
        booked_eco: r[5], booked_biz: r[6], booked_fir: r[7],
        eco_price: r[8], biz_price: r[9], fir_price: r[10],
        rev_collected: r[11],
        current_location: r[12],
      });
    }
    boardingCandidatesStmt.free();

    for (const f of boardingCandidates) {
      // If current_location is known and doesn't match departure airport → cancel
      if (f.current_location !== null && f.current_location !== f.dep_airport) {
        let penalty = 0;
        if (f.rev_collected) {
          penalty += f.booked_eco * f.eco_price * 1.2;
          penalty += f.booked_biz * (f.biz_price || f.eco_price) * 1.2;
          penalty += f.booked_fir * (f.fir_price || f.eco_price) * 1.2;
        }
        penalty = Math.round(penalty);

        const cancelStmt = db.prepare("UPDATE flights SET status = 'cancelled' WHERE id = ?");
        cancelStmt.bind([f.id]);
        cancelStmt.step();
        cancelStmt.free();

        if (penalty > 0) {
          const penStmt = db.prepare('UPDATE airlines SET balance = balance - ? WHERE id = ?');
          penStmt.bind([penalty, f.airline_id]);
          penStmt.step();
          penStmt.free();

          const txStmt = db.prepare(
            "INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'other', ?, ?)"
          );
          txStmt.bind([
            f.airline_id, -penalty,
            `Flight ${f.flight_number} cancelled - aircraft not at ${f.dep_airport} (at ${f.current_location})`,
          ]);
          txStmt.step();
          txStmt.free();
        }

        console.log(`[FlightProc] ${f.flight_number} CANCELLED - not at ${f.dep_airport}, at ${f.current_location}, penalty $${penalty}`);
        continue;
      }

      // Location OK (or unknown) → proceed to boarding
      const boardStmt = db.prepare("UPDATE flights SET status = 'boarding' WHERE id = ?");
      boardStmt.bind([f.id]);
      boardStmt.step();
      boardStmt.free();
    }

    // Boarding → In-Flight: calculate fuel cost at departure using current live price
    const boardingReadyStmt = db.prepare(`
      SELECT f.id, f.flight_number,
             COALESCE(r.distance_km, ws_r.distance_km, 0) as distance_km,
             COALESCE(at.fuel_consumption_per_km, 2.8) as fuel_per_km
      FROM flights f
      LEFT JOIN routes r ON f.route_id = r.id
      LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
      LEFT JOIN routes ws_r ON ws.route_id = ws_r.id
      LEFT JOIN aircraft ac ON f.aircraft_id = ac.id
      LEFT JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      WHERE f.status = 'boarding'
      AND datetime(f.departure_time) <= datetime(?)
    `);
    boardingReadyStmt.bind([now.toISOString()]);
    const departingFlights = [];
    while (boardingReadyStmt.step()) {
      const r = boardingReadyStmt.get();
      departingFlights.push({ id: r[0], flight_number: r[1], distance_km: r[2], fuel_per_km: r[3] });
    }
    boardingReadyStmt.free();

    if (departingFlights.length > 0) {
      // Fetch current fuel price
      const fpStmt = db.prepare('SELECT price_per_liter FROM fuel_prices ORDER BY created_at DESC LIMIT 1');
      let currentFuelPrice = 0.64;
      if (fpStmt.step()) currentFuelPrice = fpStmt.get()[0];
      fpStmt.free();

      for (const f of departingFlights) {
        // fuel_consumption_per_km is in kg/km
        const fuelKg = Math.round(f.distance_km * f.fuel_per_km);
        const fuelCost = Math.round(fuelKg * currentFuelPrice);
        const updStmt = db.prepare(
          "UPDATE flights SET status = 'in-flight', fuel_cost = ? WHERE id = ?"
        );
        updStmt.bind([fuelCost, f.id]);
        updStmt.step();
        updStmt.free();
      }
      console.log(`[FlightProc] ${departingFlights.length} flight(s) departed at $${currentFuelPrice.toFixed(2)}/kg fuel`);
    }

    // In-Flight → Completed (deduct costs for new-flow flights; post net revenue for legacy)
    const completedStmt = db.prepare(`
      SELECT f.id, f.airline_id, f.seats_sold, f.ticket_price, f.aircraft_id,
             COALESCE(r.arrival_airport, ws.arrival_airport) as arrival_airport,
             f.service_profile_id, f.departure_time, f.arrival_time,
             f.booking_revenue_collected, f.flight_number,
             COALESCE(r.departure_airport, ws.departure_airport) as departure_airport,
             COALESCE(r.distance_km, ws_r.distance_km, 0) as distance_km,
             COALESCE(at.wake_turbulence_category, 'M') as wake_cat,
             COALESCE(f.fuel_cost, 0) as fuel_cost,
             COALESCE(f.atc_fee, 0) as atc_fee,
             COALESCE(arr_apt.landing_fee_light,  300)  as landing_fee_light,
             COALESCE(arr_apt.landing_fee_medium, 700)  as landing_fee_medium,
             COALESCE(arr_apt.landing_fee_heavy,  2200) as landing_fee_heavy,
             COALESCE(arr_apt.ground_handling_fee_light,  400) as arr_gh_light,
             COALESCE(arr_apt.ground_handling_fee_medium, 650) as arr_gh_medium,
             COALESCE(arr_apt.ground_handling_fee_heavy, 950) as arr_gh_heavy,
             COALESCE(dep_apt.ground_handling_fee_light,  400) as dep_gh_light,
             COALESCE(dep_apt.ground_handling_fee_medium, 650) as dep_gh_medium,
             COALESCE(dep_apt.ground_handling_fee_heavy, 950) as dep_gh_heavy,
             COALESCE(f.booked_economy, f.seats_sold, 0)  as booked_eco,
             COALESCE(f.booked_business, 0) as booked_biz,
             COALESCE(f.booked_first, 0)    as booked_fir,
             COALESCE(at.max_passengers, 100) as total_capacity
      FROM flights f
      LEFT JOIN routes r ON f.route_id = r.id
      LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
      LEFT JOIN routes ws_r ON ws.route_id = ws_r.id
      LEFT JOIN aircraft ac ON f.aircraft_id = ac.id
      LEFT JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      LEFT JOIN airports arr_apt ON COALESCE(r.arrival_airport, ws.arrival_airport) = arr_apt.iata_code
      LEFT JOIN airports dep_apt ON COALESCE(r.departure_airport, ws.departure_airport) = dep_apt.iata_code
      WHERE f.status = 'in-flight'
      AND datetime(f.arrival_time) <= datetime(?)
    `);
    completedStmt.bind([now.toISOString()]);

    const completedFlights = [];
    while (completedStmt.step()) {
      const row = completedStmt.get();
      completedFlights.push({
        id: row[0],
        airline_id: row[1],
        seats_sold: row[2],
        ticket_price: row[3],
        aircraft_id: row[4],
        arrival_airport: row[5],
        service_profile_id: row[6],
        departure_time: row[7],
        arrival_time: row[8],
        booking_revenue_collected: row[9],
        flight_number: row[10],
        departure_airport: row[11],
        distance_km: row[12],
        wake_cat: row[13],
        fuel_cost: row[14],
        atc_fee: row[15],
        landing_fee_light: row[16],
        landing_fee_medium: row[17],
        landing_fee_heavy: row[18],
        arr_gh_light: row[19], arr_gh_medium: row[20], arr_gh_heavy: row[21],
        dep_gh_light: row[22], dep_gh_medium: row[23], dep_gh_heavy: row[24],
        booked_eco: row[25],
        booked_biz: row[26],
        booked_fir: row[27],
        total_capacity: row[28],
      });
    }
    completedStmt.free();

    // Process each completed flight
    for (const flight of completedFlights) {
      // Distance-based catering cost per cabin class
      const cateringCost = calcCateringCost(
        flight.distance_km,
        flight.booked_eco,
        flight.booked_biz,
        flight.booked_fir
      );

      if (flight.booking_revenue_collected) {
        // NEW FLOW: revenue already collected at booking — deduct costs only at landing
        const distKm = flight.distance_km || 0;
        const wakeCategory = flight.wake_cat || 'M';

        // Landing fee at arrival airport, based on wake turbulence category
        let landingFee = 0;
        if (wakeCategory === 'L') landingFee = flight.landing_fee_light  || 500;
        else if (wakeCategory === 'M') landingFee = flight.landing_fee_medium || 1500;
        else                           landingFee = flight.landing_fee_heavy  || 5000;

        // Ground handling at both airports
        const wc = (flight.wake_cat || 'M').toUpperCase();
        const arrGH = wc === 'L' ? (flight.arr_gh_light || 400)  : wc === 'H' ? (flight.arr_gh_heavy || 950)  : (flight.arr_gh_medium || 650);
        const depGH = wc === 'L' ? (flight.dep_gh_light || 400)  : wc === 'H' ? (flight.dep_gh_heavy || 950)  : (flight.dep_gh_medium || 650);
        const groundHandling = arrGH + depGH;

        // ATC / navigation fees — use stored value (calculated at scheduling), fallback to live calc
        const atcFee = flight.atc_fee > 0 ? flight.atc_fee : Math.round(distKm * ATC_RATE_PER_KM);

        // Fuel cost already calculated at departure (using live price at takeoff)
        const fuelCost = flight.fuel_cost || 0;

        const totalCosts = landingFee + groundHandling + atcFee + fuelCost + cateringCost;

        // Mark flight completed; persist costs for profit calculation
        const updateFlightStmt = db.prepare(
          'UPDATE flights SET status = ?, atc_fee = CASE WHEN atc_fee = 0 THEN ? ELSE atc_fee END, landing_fee = ?, ground_handling_cost = ?, catering_cost = ? WHERE id = ?'
        );
        updateFlightStmt.bind(['completed', atcFee, landingFee, groundHandling, cateringCost, flight.id]);
        updateFlightStmt.step();
        updateFlightStmt.free();

        // Update aircraft physical location, flight hours, and condition
        if (flight.aircraft_id) {
          const flightHours = flight.departure_time && flight.arrival_time
            ? (new Date(flight.arrival_time) - new Date(flight.departure_time)) / 3600000
            : 0;
          const updateLocStmt = db.prepare(
            'UPDATE aircraft SET current_location = ?, total_flight_hours = total_flight_hours + ? WHERE id = ?'
          );
          updateLocStmt.bind([flight.arrival_airport || null, flightHours, flight.aircraft_id]);
          updateLocStmt.step();
          updateLocStmt.free();
          degradeCondition(db, flight.aircraft_id, flightHours, flight.wake_cat);
        }

        // Deduct costs from airline balance
        if (totalCosts > 0) {
          const updateBalanceStmt = db.prepare('UPDATE airlines SET balance = balance - ? WHERE id = ?');
          updateBalanceStmt.bind([totalCosts, flight.airline_id]);
          updateBalanceStmt.step();
          updateBalanceStmt.free();

          const txStmt = db.prepare(
            "INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'other', ?, ?)"
          );
          txStmt.bind([flight.airline_id, -totalCosts, `Flight Costs - ${flight.flight_number}`]);
          txStmt.step();
          txStmt.free();
        }

        console.log(`Flight ${flight.id} (${flight.flight_number}) landed. Landing: $${landingFee.toLocaleString()}, Ground: $${groundHandling.toLocaleString()}, ATC: $${atcFee.toLocaleString()}, Fuel: $${fuelCost.toLocaleString()}, Catering: $${cateringCost.toLocaleString()}, Total costs: $${totalCosts.toLocaleString()}`);
      } else {
        // LEGACY FLOW: no upfront revenue collected — post net revenue at landing
        const revenue = flight.seats_sold * flight.ticket_price;
        const netRevenue = revenue - cateringCost;

        // Update flight status and revenue; persist catering cost for profit calculation
        const updateFlightStmt = db.prepare('UPDATE flights SET status = ?, revenue = ?, catering_cost = ? WHERE id = ?');
        updateFlightStmt.bind(['completed', netRevenue, cateringCost, flight.id]);
        updateFlightStmt.step();
        updateFlightStmt.free();

        // Update aircraft physical location, flight hours, and condition
        if (flight.aircraft_id) {
          const flightHours = flight.departure_time && flight.arrival_time
            ? (new Date(flight.arrival_time) - new Date(flight.departure_time)) / 3600000
            : 0;
          const updateLocStmt = db.prepare(
            'UPDATE aircraft SET current_location = ?, total_flight_hours = total_flight_hours + ? WHERE id = ?'
          );
          updateLocStmt.bind([flight.arrival_airport || null, flightHours, flight.aircraft_id]);
          updateLocStmt.step();
          updateLocStmt.free();
          degradeCondition(db, flight.aircraft_id, flightHours, flight.wake_cat);
        }

        // Add net revenue to airline balance
        const updateBalanceStmt = db.prepare('UPDATE airlines SET balance = balance + ? WHERE id = ?');
        updateBalanceStmt.bind([netRevenue, flight.airline_id]);
        updateBalanceStmt.step();
        updateBalanceStmt.free();

        console.log(`Flight ${flight.id} completed (legacy). Revenue: $${revenue.toLocaleString()}, Catering: $${cateringCost.toLocaleString()}, Net: $${netRevenue.toLocaleString()}`);
      }

      // ── Award XP for completed flight ───────────────────────────────────────
      const totalBooked = (flight.booked_eco || 0) + (flight.booked_biz || 0) + (flight.booked_fir || 0);
      const loadFactor  = flight.total_capacity > 0 ? totalBooked / flight.total_capacity : 0.7;
      const xpEarned    = calcFlightXP(flight.distance_km || 0, loadFactor);
      const xpStmt = db.prepare('UPDATE airlines SET total_points = total_points + ? WHERE id = ?');
      xpStmt.bind([xpEarned, flight.airline_id]);
      xpStmt.step();
      xpStmt.free();
      checkLevelUp(db, flight.airline_id);
      console.log(`[XP] Flight ${flight.flight_number}: +${xpEarned} XP (dist=${flight.distance_km}km, load=${(loadFactor*100).toFixed(0)}%)`);
    }

    if (completedFlights.length > 0) {
      saveDatabase();
    }

    // ── Complete transfer flights that have landed ──────────────────────────
    try {
      const pendingTransferStmt = db.prepare(`
        SELECT id, aircraft_id, airline_id, arrival_airport, departure_time, arrival_time
        FROM transfer_flights WHERE status = 'scheduled'
      `);
      const pendingTransfers = [];
      while (pendingTransferStmt.step()) {
        const r = pendingTransferStmt.get();
        pendingTransfers.push({ id: r[0], aircraft_id: r[1], airline_id: r[2], arrival_airport: r[3], departure_time: r[4], arrival_time: r[5] });
      }
      pendingTransferStmt.free();

      let transferCompleted = false;
      for (const t of pendingTransfers) {
        if (now >= new Date(t.arrival_time)) {
          // Mark completed
          const completeStmt = db.prepare("UPDATE transfer_flights SET status = 'completed' WHERE id = ?");
          completeStmt.bind([t.id]);
          completeStmt.step();
          completeStmt.free();

          // Update aircraft location
          const flightHours = (new Date(t.arrival_time) - new Date(t.departure_time)) / 3600000;
          const locStmt = db.prepare('UPDATE aircraft SET current_location = ?, total_flight_hours = total_flight_hours + ? WHERE id = ?');
          locStmt.bind([t.arrival_airport, flightHours, t.aircraft_id]);
          locStmt.step();
          locStmt.free();

          transferCompleted = true;
          console.log(`Transfer flight ${t.id} completed → ${t.arrival_airport}`);
        }
      }
      if (transferCompleted) saveDatabase();
    } catch (err) {
      console.error('Transfer flight processing error:', err);
    }
  } catch (error) {
    console.error('Process flights error:', error);
  }
}

// Degrade aircraft condition after landing
const CONDITION_RATE = { L: 0.20, M: 0.25, H: 0.30 };
function degradeCondition(db, aircraftId, flightHours, wakeCategory) {
  try {
    const rate = CONDITION_RATE[wakeCategory] ?? CONDITION_RATE.M;
    const loss = parseFloat(((flightHours * rate) + 0.15).toFixed(4));
    const stmt = db.prepare(
      'UPDATE aircraft SET condition = MAX(0, ROUND(condition - ?, 2)) WHERE id = ?'
    );
    stmt.bind([loss, aircraftId]);
    stmt.step();
    stmt.free();
  } catch (err) {
    console.error('degradeCondition error:', err);
  }
}

// Backfill fuel price history if fewer than 24 entries exist (covers last 3 days at 3h intervals)
function backfillFuelPrices() {
  try {
    const db = getDatabase();
    if (!db) return;

    const countStmt = db.prepare('SELECT COUNT(*) FROM fuel_prices');
    countStmt.step();
    const count = countStmt.get()[0];
    countStmt.free();

    if (count >= 24) return; // Enough history already

    // Get current seed price
    const curStmt = db.prepare('SELECT price_per_liter FROM fuel_prices ORDER BY created_at DESC LIMIT 1');
    let price = 0.75;
    if (curStmt.step()) price = curStmt.get()[0];
    curStmt.free();

    // Add entries spaced 3h apart going back from now
    const needed = 24 - count;
    const insStmt = db.prepare("INSERT INTO fuel_prices (price_per_liter, price_per_kg, created_at) VALUES (?, ?, datetime('now', ? || ' hours'))");
    for (let i = needed; i >= 1; i--) {
      const isSpike = Math.random() < 0.10;
      let delta = isSpike ? (Math.random() * 0.60) - 0.30 : (Math.random() * 0.10) - 0.05;
      if (price > 0.90) delta -= 0.01;
      if (price < 0.50) delta += 0.01;
      price = Math.max(FUEL_MIN_PER_KG, Math.min(FUEL_MAX_PER_KG, price + delta));
      price = Math.round(price * 100) / 100;
      insStmt.bind([price, Math.round(price * 1.25 * 100) / 100, String(-(i * 3))]);
      insStmt.step();
      insStmt.reset();
    }
    insStmt.free();
    saveDatabase();
    console.log(`[FuelPrice] Backfilled ${needed} historical price entries`);
  } catch (err) {
    console.error('backfillFuelPrices error:', err);
  }
}

// Generate a new fuel price — smooth random walk with occasional spikes
function generateFuelPrice() {
  try {
    const db = getDatabase();
    if (!db) return;

    const lastStmt = db.prepare('SELECT price_per_liter FROM fuel_prices ORDER BY created_at DESC LIMIT 1');
    let previousPrice = 0.75;
    if (lastStmt.step()) previousPrice = lastStmt.get()[0];
    lastStmt.free();

    const isSpike = Math.random() < 0.10;
    let delta = isSpike ? (Math.random() * 0.60) - 0.30 : (Math.random() * 0.10) - 0.05;
    if (previousPrice > 0.90) delta -= 0.01;
    if (previousPrice < 0.50) delta += 0.01;
    const newPrice = Math.max(FUEL_MIN_PER_KG, Math.min(FUEL_MAX_PER_KG, previousPrice + delta));
    const rounded = Math.round(newPrice * 100) / 100;

    const insStmt = db.prepare('INSERT INTO fuel_prices (price_per_liter, price_per_kg) VALUES (?, ?)');
    insStmt.bind([rounded, Math.round(rounded * 1.25 * 100) / 100]);
    insStmt.step();
    insStmt.free();

    // Keep only last 3 days of history
    const cleanStmt = db.prepare("DELETE FROM fuel_prices WHERE created_at < datetime('now', '-3 days')");
    cleanStmt.step();
    cleanStmt.free();

    saveDatabase();
    console.log(`[FuelPrice] New price: $${rounded.toFixed(2)}/kg${isSpike ? ' (spike)' : ''}`);
  } catch (err) {
    console.error('generateFuelPrice error:', err);
  }
}

// ── DEV: Route price calculator ───────────────────────────────────────────────
router.get('/dev/route-calc', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();
    const { dep, arr, eco_price, biz_price, fir_price, condition = 100,
            service_profile_id, eco_cap, biz_cap, fir_cap } = req.query;

    if (!dep || !arr) return res.status(400).json({ error: 'dep and arr required' });

    function haversineKm(lat1, lon1, lat2, lon2) {
      const R = 6371, toRad = x => x * Math.PI / 180;
      const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
      return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
    }

    const getApt = (code) => {
      const s = db.prepare('SELECT category, latitude, longitude, name FROM airports WHERE iata_code = ?');
      s.bind([code]);
      let r = null;
      if (s.step()) { const row = s.get(); r = { category: row[0] || 4, lat: row[1], lon: row[2], name: row[3] }; }
      s.free();
      return r || { category: 4, lat: null, lon: null, name: code };
    };

    const depApt = getApt(dep.toUpperCase());
    const arrApt = getApt(arr.toUpperCase());

    let distKm = parseInt(req.query.dist_km) || 1000;
    if (depApt.lat != null && arrApt.lat != null) {
      distKm = haversineKm(depApt.lat, depApt.lon, arrApt.lat, arrApt.lon);
    }

    const ecoPx  = parseFloat(eco_price) || 0;
    const bizPx  = parseFloat(biz_price) || 0;
    const firPx  = parseFloat(fir_price) || 0;
    const cond   = parseFloat(condition) || 100;
    const ecoCap = parseInt(eco_cap) || 150;
    const bizCap = parseInt(biz_cap) || 0;
    const firCap = parseInt(fir_cap) || 0;
    const spId   = service_profile_id ? parseInt(service_profile_id) : null;

    const mkt        = calcMarketPrices(distKm, depApt.category, arrApt.category);
    const baseDemand = calcBaseDemandPerHour(depApt.category, arrApt.category);
    const distMod    = calcDistanceMod(distKm);
    const svcEco     = calcServiceFactor(db, spId, 'economy');
    const svcBiz     = calcServiceFactor(db, spId, 'business');
    const svcFir     = calcServiceFactor(db, spId, 'first');
    const condFactor = calcConditionFactor(cond);
    const baseRate   = calcBaseRate(distKm);
    const aptPremium = calcAirportPremium(depApt.category, arrApt.category);

    const ecoAttr = ecoPx > 0 ? calcPriceAttractiveness(ecoPx, mkt.eco)   : null;
    const bizAttr = bizPx > 0 ? calcPriceAttractiveness(bizPx, mkt.biz)   : null;
    const firAttr = firPx > 0 ? calcPriceAttractiveness(firPx, mkt.first) : null;

    const ecoRateHr = ecoPx > 0 ? baseDemand * 1.00 * distMod * ecoAttr * svcEco * condFactor : 0;
    const bizRateHr = bizPx > 0 ? baseDemand * 0.15 * distMod * bizAttr * svcBiz * condFactor : 0;
    const firRateHr = firPx > 0 ? baseDemand * 0.05 * distMod * firAttr * svcFir * condFactor : 0;

    const eco72 = Math.min(ecoCap, Math.round(ecoRateHr * 72));
    const biz72 = Math.min(bizCap, Math.round(bizRateHr * 72));
    const fir72 = Math.min(firCap, Math.round(firRateHr * 72));

    const totalCap = ecoCap + bizCap + firCap;
    const totalPax = eco72 + biz72 + fir72;
    const loadFactor = totalCap > 0 ? Math.round(totalPax / totalCap * 100) : 0;
    const expRevenue = Math.round(eco72 * ecoPx + biz72 * bizPx + fir72 * firPx);

    res.json({
      route: { dep: dep.toUpperCase(), arr: arr.toUpperCase(), dep_name: depApt.name, arr_name: arrApt.name,
               dist_km: distKm, dep_cat: depApt.category, arr_cat: arrApt.category },
      market_prices: { eco: mkt.eco, biz: mkt.biz, first: mkt.first },
      factors: { base_rate_per_km: baseRate, airport_premium: aptPremium, dist_mod: distMod,
                 base_demand_per_hr: baseDemand,
                 service_factor_eco: svcEco, service_factor_biz: svcBiz, service_factor_fir: svcFir,
                 cond_factor: condFactor },
      attractiveness: { eco: ecoAttr, biz: bizAttr, fir: firAttr },
      bookings_per_hr: {
        eco: Math.round(ecoRateHr * 100) / 100,
        biz: Math.round(bizRateHr * 100) / 100,
        fir: Math.round(firRateHr * 100) / 100,
      },
      expected_72h: { eco: eco72, biz: biz72, fir: fir72, total: totalPax },
      capacity:     { eco: ecoCap, biz: bizCap, fir: firCap, total: totalCap },
      load_factor_pct: loadFactor,
      expected_revenue: expRevenue,
    });
  } catch (err) {
    console.error('dev/route-calc error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start flight processor (runs every 10 seconds)
let flightProcessorInterval = null;

function startFlightProcessor() {
  if (flightProcessorInterval) return;

  console.log('Starting flight processor...');
  // Generate flights immediately and every 10 minutes
  generateFlights();
  setInterval(generateFlights, 10 * 60 * 1000);
  // Process flight statuses every 10 seconds
  flightProcessorInterval = setInterval(processFlights, 10000);
  setTimeout(processFlights, 1000);
  // Hourly booking processor — runs immediately then every hour
  processBookings();
  setInterval(processBookings, 60 * 60 * 1000);
  console.log('[Bookings] Hourly booking processor started');
  // Fuel price: backfill history, generate one immediately, then update every hour
  backfillFuelPrices();
  generateFuelPrice();
  setInterval(generateFuelPrice, 60 * 60 * 1000);
  console.log('[FuelPrice] Fuel price updater started (interval: 1h)');
}

function stopFlightProcessor() {
  if (flightProcessorInterval) {
    clearInterval(flightProcessorInterval);
    flightProcessorInterval = null;
  }
}

// ── Client feedback: completed flights in last 24h with satisfaction issues ───
router.get('/client-feedback', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();
    const airlineId = req.airlineId;
    const stmt = db.prepare(`
      SELECT f.id, f.flight_number, f.satisfaction_score, f.violated_rules,
             f.arrival_time, f.aircraft_id,
             COALESCE(r.departure_airport, ws.departure_airport) AS dep_iata,
             COALESCE(r.arrival_airport,   ws.arrival_airport)   AS arr_iata,
             ac.registration
      FROM flights f
      LEFT JOIN routes r ON f.route_id = r.id
      LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
      LEFT JOIN aircraft ac ON f.aircraft_id = ac.id
      WHERE f.airline_id = ?
        AND f.status = 'completed'
        AND f.satisfaction_score IS NOT NULL
        AND f.satisfaction_score < 85
        AND f.violated_rules IS NOT NULL
        AND f.arrival_time >= datetime('now', '-24 hours')
      ORDER BY f.arrival_time DESC
      LIMIT 50
    `);
    stmt.bind([airlineId]);
    const items = [];
    while (stmt.step()) {
      const r = stmt.get();
      items.push({
        id: r[0], flight_number: r[1], satisfaction_score: r[2],
        violated_rules: r[3] ? JSON.parse(r[3]) : [],
        arrival_time: r[4], aircraft_id: r[5],
        departure_airport: r[6], arrival_airport: r[7],
        registration: r[8],
      });
    }
    stmt.free();
    res.json({ items });
  } catch (err) {
    console.error('client-feedback error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Weekly flight schedule (all aircraft, all routes) ────────────────────────
router.get('/weekly-schedule', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const stmt = db.prepare(`
      SELECT
        ws.id, ws.day_of_week, ws.flight_number,
        ws.departure_airport, ws.arrival_airport,
        ws.departure_time, ws.arrival_time,
        ac.id as aircraft_id, ac.registration, ac.is_active,
        at.full_name as aircraft_type,
        dep.name as departure_name,
        arr.name as arrival_name
      FROM weekly_schedule ws
      JOIN aircraft ac ON ws.aircraft_id = ac.id
      JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      JOIN airports dep ON ws.departure_airport = dep.iata_code
      JOIN airports arr ON ws.arrival_airport = arr.iata_code
      WHERE ac.airline_id = ?
      ORDER BY arr.name ASC, ws.day_of_week ASC, ws.departure_time ASC
    `);
    stmt.bind([airlineId]);
    const entries = [];
    while (stmt.step()) {
      const r = stmt.get();
      entries.push({
        id: r[0], day_of_week: r[1], flight_number: r[2],
        departure_airport: r[3], arrival_airport: r[4],
        departure_time: r[5], arrival_time: r[6],
        aircraft_id: r[7], registration: r[8], is_active: r[9],
        aircraft_type: r[10], departure_name: r[11], arrival_name: r[12],
      });
    }
    stmt.free();
    res.json({ entries });
  } catch (error) {
    console.error('Weekly schedule error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
export { startFlightProcessor, stopFlightProcessor, processFlights, generateFlights, generateFuelPrice, calculateFlightDuration, processBookings, checkLevelUp, XP_THRESHOLDS };
