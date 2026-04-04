import express from 'express';
import { body, validationResult } from 'express-validator';
import pool from '../database/postgres.js';
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

async function checkLevelUp(airlineId) {
  const result = await pool.query('SELECT level, total_points FROM airlines WHERE id = $1', [airlineId]);
  if (!result.rows[0]) return { leveledUp: false };
  const { level: currentLevel, total_points: totalPoints } = result.rows[0];
  let newLevel = currentLevel;
  while (newLevel < 15 && totalPoints >= XP_THRESHOLDS[newLevel]) newLevel++;
  if (newLevel > currentLevel) {
    await pool.query('UPDATE airlines SET level = $1 WHERE id = $2', [newLevel, airlineId]);
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
  if (d <= 500)  return 0.22;
  if (d <= 1500) return 0.15;
  if (d <= 3000) return 0.10;
  if (d <= 6000) return 0.065;
  return 0.055;
}

function calcAirportPremium(cat1, cat2) {
  const P = { 8: 1.5, 7: 1.4, 6: 1.3, 5: 1.2, 4: 1.15, 3: 1.05, 2: 1.0, 1: 0.9 };
  return ((P[cat1] || 1.0) + (P[cat2] || 1.0)) / 2;
}

function calcMarketPrices(distKm, depCat, arrCat) {
  const eco = Math.round(distKm * calcBaseRate(distKm) * calcAirportPremium(depCat, arrCat));
  return {
    eco,
    biz:   Math.round(eco * (distKm < 1000 ? 2.5 : distKm < 3000 ? 3.0 : 4.0)),
    first: Math.round(eco * (distKm < 1000 ? 5.0 : distKm < 3000 ? 7.0 : 10.0)),
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

async function calcServiceFactor(serviceProfileId, cabinClass = 'economy') {
  if (!serviceProfileId) return 1.0;
  try {
    const priceCol = cabinClass === 'first' ? 'price_first'
                   : cabinClass === 'business' ? 'price_business'
                   : 'price_economy';
    const result = await pool.query(
      `SELECT COALESCE(SUM(t.${priceCol}), 0) as cost FROM service_profile_items i JOIN service_item_types t ON i.item_type_id = t.id WHERE i.profile_id = $1 AND i.cabin_class = $2`,
      [serviceProfileId, cabinClass]
    );
    const cost = result.rows[0]?.cost || 0;
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
router.get('/', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const result = await pool.query(`
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
      WHERE f.airline_id = $1
      ORDER BY f.departure_time DESC
    `, [airlineId]);

    const flights = result.rows.map(row => ({
      id: row.id,
      flight_number: row.flight_number,
      departure_time: row.departure_time,
      arrival_time: row.arrival_time,
      ticket_price: row.ticket_price,
      total_seats: row.total_seats,
      seats_sold: row.seats_sold,
      status: row.status,
      revenue: row.revenue,
      created_at: row.created_at,
      departure_airport: row.departure_airport,
      arrival_airport: row.arrival_airport,
      distance_km: row.distance_km,
      departure_name: row.departure_name,
      arrival_name: row.arrival_name,
      aircraft_registration: row.registration,
      aircraft_type: row.aircraft_type,
      aircraft_id: row.aircraft_id,
      satisfaction_score: row.satisfaction_score,
      violated_rules: row.violated_rules ? JSON.parse(row.violated_rules) : [],
    }));

    res.json({ flights });
  } catch (error) {
    console.error('Get flights error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get routes available for scheduling (with assigned aircraft)
router.get('/available-routes', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const result = await pool.query(`
      SELECT
        r.id, r.flight_number, r.departure_airport, r.arrival_airport, r.distance_km,
        ac.id as aircraft_id, ac.registration,
        at.full_name as aircraft_type, at.max_passengers
      FROM routes r
      JOIN aircraft ac ON r.aircraft_id = ac.id
      JOIN aircraft_types at ON ac.aircraft_type_id = at.id
      WHERE r.airline_id = $1 AND r.aircraft_id IS NOT NULL
      ORDER BY r.flight_number
    `, [airlineId]);

    const routes = result.rows.map(row => ({
      id: row.id,
      flight_number: row.flight_number,
      departure_airport: row.departure_airport,
      arrival_airport: row.arrival_airport,
      distance_km: row.distance_km,
      aircraft_id: row.aircraft_id,
      aircraft_registration: row.registration,
      aircraft_type: row.aircraft_type,
      max_passengers: row.max_passengers,
      estimated_duration: calculateFlightDuration(row.distance_km)
    }));

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
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { route_id, ticket_price, departure_time } = req.body;

      const airlineId = req.airlineId;
      if (!airlineId) return res.status(400).json({ error: 'No active airline' });

      const routeResult = await pool.query(`
        SELECT r.id, r.flight_number, r.distance_km, r.aircraft_id,
               at.max_passengers
        FROM routes r
        JOIN aircraft ac ON r.aircraft_id = ac.id
        JOIN aircraft_types at ON ac.aircraft_type_id = at.id
        WHERE r.id = $1 AND r.airline_id = $2
      `, [route_id, airlineId]);

      if (!routeResult.rows[0]) {
        return res.status(400).json({ error: 'Route not found or no aircraft assigned' });
      }

      const routeRow = routeResult.rows[0];
      const route = {
        id: routeRow.id,
        flight_number: routeRow.flight_number,
        distance_km: routeRow.distance_km,
        aircraft_id: routeRow.aircraft_id,
        max_passengers: routeRow.max_passengers
      };

      if (!route.aircraft_id) {
        return res.status(400).json({ error: 'No aircraft assigned to this route' });
      }

      const flightDurationMinutes = calculateFlightDuration(route.distance_km);
      const depTime = departure_time ? new Date(departure_time) : new Date();
      const arrTime = new Date(depTime.getTime() + flightDurationMinutes * 60 * 1000);

      const seatsSold = simulateBookings(route.max_passengers, ticket_price, route.distance_km);

      const insertResult = await pool.query(`
        INSERT INTO flights (airline_id, route_id, aircraft_id, flight_number,
                            departure_time, arrival_time, ticket_price, total_seats, seats_sold, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'scheduled')
        RETURNING id
      `, [
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

      const flightId = insertResult.rows[0].id;

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
router.get('/active', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const result = await pool.query(`
      SELECT f.flight_number, f.departure_time, f.arrival_time,
             COALESCE(r.departure_airport, ws.departure_airport) as origin_iata,
             COALESCE(r.arrival_airport,   ws.arrival_airport)   as dest_iata,
             dep.latitude as origin_lat, dep.longitude as origin_lon,
             arr.latitude as dest_lat, arr.longitude as dest_lon,
             ac.registration
      FROM flights f
      LEFT JOIN routes r          ON f.route_id           = r.id
      LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
      LEFT JOIN airports dep ON COALESCE(r.departure_airport, ws.departure_airport) = dep.iata_code
      LEFT JOIN airports arr ON COALESCE(r.arrival_airport,   ws.arrival_airport)   = arr.iata_code
      LEFT JOIN aircraft ac  ON f.aircraft_id = ac.id
      WHERE f.airline_id = $1 AND f.status = 'in-flight'
    `, [airlineId]);

    const now = Date.now();
    const flights = [];

    for (const row of result.rows) {
      if (row.origin_lat == null || row.dest_lat == null) continue;

      const dep = new Date(row.departure_time).getTime();
      const arr = new Date(row.arrival_time).getTime();
      const total = arr - dep;
      if (total <= 0) continue;

      const progress = (now - dep) / total;
      if (progress <= 0 || progress >= 1) continue;

      const remaining_ms = Math.round((1 - progress) * total);
      flights.push({
        flight_number: row.flight_number,
        registration: row.registration,
        origin_iata: row.origin_iata,
        destination_iata: row.dest_iata,
        origin_lat: row.origin_lat,
        origin_lon: row.origin_lon,
        dest_lat: row.dest_lat,
        dest_lon: row.dest_lon,
        progress,
        remaining_ms
      });
    }

    res.json({ flights });
  } catch (error) {
    console.error('Active flights map error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Edit a flight (PATCH /:id)
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const flightId = parseInt(req.params.id);

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const flightResult = await pool.query(`
      SELECT f.id, f.status, f.aircraft_id, f.route_id, f.departure_time, f.arrival_time,
             f.ticket_price, f.total_seats, r.distance_km
      FROM flights f
      JOIN routes r ON f.route_id = r.id
      WHERE f.id = $1 AND f.airline_id = $2
    `, [flightId, airlineId]);

    if (!flightResult.rows[0]) {
      return res.status(404).json({ error: 'Flight not found' });
    }
    const flight = flightResult.rows[0];

    if (flight.status !== 'scheduled') {
      return res.status(400).json({ error: 'Only scheduled flights can be edited' });
    }

    const { departure_time, ticket_price, service_profile_id } = req.body;
    const updates = [];
    const params = [];
    let paramIdx = 1;

    let newDepTime = flight.departure_time;
    let newArrTime = flight.arrival_time;
    let newPrice = flight.ticket_price;

    if (service_profile_id !== undefined) {
      if (service_profile_id !== null) {
        const spResult = await pool.query('SELECT id FROM airline_service_profiles WHERE id = $1 AND airline_id = $2', [service_profile_id, airlineId]);
        if (!spResult.rows[0]) {
          return res.status(400).json({ error: 'Service profile not found' });
        }
      }
      updates.push(`service_profile_id = $${paramIdx++}`);
      params.push(service_profile_id);
    }

    if (departure_time) {
      const depTime = new Date(departure_time);
      const durationMin = calculateFlightDuration(flight.distance_km);
      const arrTime = new Date(depTime.getTime() + durationMin * 60 * 1000);
      newDepTime = depTime.toISOString();
      newArrTime = arrTime.toISOString();

      const GROUND_TIME_MS = 30 * 60 * 1000;
      const overlapResult = await pool.query(`
        SELECT departure_time, arrival_time
        FROM flights
        WHERE aircraft_id = $1 AND airline_id = $2 AND id != $3 AND status != 'cancelled'
      `, [flight.aircraft_id, airlineId, flightId]);

      for (const oRow of overlapResult.rows) {
        const existDep = new Date(oRow.departure_time);
        const existArr = new Date(oRow.arrival_time);
        const existEnd = new Date(existArr.getTime() + GROUND_TIME_MS);
        const newEnd = new Date(arrTime.getTime() + GROUND_TIME_MS);
        if (depTime < existEnd && existDep < newEnd) {
          return res.status(400).json({ error: 'New time overlaps with an existing flight' });
        }
      }

      const maintResult = await pool.query(`
        SELECT start_time, end_time FROM maintenance_schedule
        WHERE aircraft_id = $1 AND airline_id = $2
      `, [flight.aircraft_id, airlineId]);

      for (const mRow of maintResult.rows) {
        const mStart = new Date(mRow.start_time);
        const mEnd = new Date(mRow.end_time);
        if (depTime < mEnd && mStart < arrTime) {
          return res.status(400).json({ error: 'New time overlaps with a maintenance window' });
        }
      }

      updates.push(`departure_time = $${paramIdx++}`, `arrival_time = $${paramIdx++}`);
      params.push(newDepTime, newArrTime);
    }

    if (ticket_price !== undefined) {
      newPrice = ticket_price;
      const seatsSold = simulateBookings(flight.total_seats, newPrice, flight.distance_km);
      updates.push(`ticket_price = $${paramIdx++}`, `seats_sold = $${paramIdx++}`);
      params.push(newPrice, seatsSold);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    params.push(flightId);
    await pool.query(`UPDATE flights SET ${updates.join(', ')} WHERE id = $${paramIdx}`, params);

    const updatedResult = await pool.query(`
      SELECT f.id, f.flight_number, f.departure_time, f.arrival_time,
             f.ticket_price, f.total_seats, f.seats_sold, f.status, f.service_profile_id,
             r.departure_airport, r.arrival_airport
      FROM flights f
      JOIN routes r ON f.route_id = r.id
      WHERE f.id = $1
    `, [flightId]);
    const uRow = updatedResult.rows[0];

    res.json({
      message: 'Flight updated successfully',
      flight: {
        id: uRow.id, flight_number: uRow.flight_number, departure_time: uRow.departure_time,
        arrival_time: uRow.arrival_time, ticket_price: uRow.ticket_price, total_seats: uRow.total_seats,
        seats_sold: uRow.seats_sold, status: uRow.status, service_profile_id: uRow.service_profile_id,
        departure_airport: uRow.departure_airport, arrival_airport: uRow.arrival_airport
      }
    });
  } catch (error) {
    console.error('Edit flight error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a flight (DELETE /:id)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const flightId = parseInt(req.params.id);

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const airlineBalResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [airlineId]);
    const currentBalance = airlineBalResult.rows[0]?.balance;

    const flightResult = await pool.query(`
      SELECT id, status, flight_number,
             booked_economy, booked_business, booked_first,
             economy_price, business_price, first_price,
             booking_revenue_collected
      FROM flights WHERE id = $1 AND airline_id = $2
    `, [flightId, airlineId]);

    if (!flightResult.rows[0]) {
      return res.status(404).json({ error: 'Flight not found' });
    }
    const fr = flightResult.rows[0];
    const { status, flight_number: flightNumber,
      booked_economy: bookedEco, booked_business: bookedBiz, booked_first: bookedFirst,
      economy_price: ecoPrice, business_price: bizPrice, first_price: firstPrice,
      booking_revenue_collected: bookingRevenueCollected } = fr;

    if (status === 'completed') {
      return res.status(400).json({ error: 'Cannot delete a completed flight' });
    }

    // Only charge penalty if not already cancelled (cancel already applied penalty)
    if (status !== 'cancelled' && bookingRevenueCollected) {
      const penalty = Math.round(
        (bookedEco   || 0) * (ecoPrice   || 0) * 1.2 +
        (bookedBiz   || 0) * (bizPrice   || ecoPrice || 0) * 1.2 +
        (bookedFirst || 0) * (firstPrice || ecoPrice || 0) * 1.2
      );
      if (penalty > 0) {
        await pool.query('UPDATE airlines SET balance = $1 WHERE id = $2', [currentBalance - penalty, airlineId]);
        await pool.query(
          "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'other', $2, $3)",
          [airlineId, -penalty, `Flight Cancellation Penalty - ${flightNumber}`]
        );
      }
    }

    await pool.query('DELETE FROM flights WHERE id = $1', [flightId]);

    res.json({ message: 'Flight deleted successfully' });
  } catch (error) {
    console.error('Delete flight error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Cancel a flight
router.post('/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const flightId = parseInt(req.params.id);

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const airlineBalResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [airlineId]);
    if (!airlineBalResult.rows[0]) return res.status(400).json({ error: 'No airline found' });
    const currentBalance = airlineBalResult.rows[0].balance;

    const flightResult = await pool.query(`
      SELECT id, status, flight_number,
             booked_economy, booked_business, booked_first,
             economy_price, business_price, first_price,
             booking_revenue_collected
      FROM flights WHERE id = $1 AND airline_id = $2
    `, [flightId, airlineId]);

    if (!flightResult.rows[0]) {
      return res.status(404).json({ error: 'Flight not found' });
    }
    const fr = flightResult.rows[0];

    const { status, flight_number: flightNumber,
      booked_economy: bookedEco, booked_business: bookedBiz, booked_first: bookedFirst,
      economy_price: ecoPrice, business_price: bizPrice, first_price: firstPrice,
      booking_revenue_collected: bookingRevenueCollected } = fr;

    if (status === 'completed' || status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot cancel a completed or already cancelled flight' });
    }
    if (status === 'in-flight') {
      return res.status(400).json({ error: 'Cannot cancel a flight that is already in the air' });
    }

    let penalty = 0;
    if (bookingRevenueCollected) {
      penalty = Math.round(
        (bookedEco   || 0) * (ecoPrice   || 0) * 1.2 +
        (bookedBiz   || 0) * (bizPrice   || ecoPrice || 0) * 1.2 +
        (bookedFirst || 0) * (firstPrice || ecoPrice || 0) * 1.2
      );
    }

    if (penalty > 0) {
      const newBalance = currentBalance - penalty;
      await pool.query('UPDATE airlines SET balance = $1 WHERE id = $2', [newBalance, airlineId]);
      await pool.query(
        "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'other', $2, $3)",
        [airlineId, -penalty, `Flight Cancellation Penalty - ${flightNumber}`]
      );
    }

    await pool.query("UPDATE flights SET status = 'cancelled' WHERE id = $1", [flightId]);

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
async function generateFlights() {
  try {
    const now = new Date();
    const horizon = new Date(now.getTime() + 72 * 60 * 60 * 1000);

    const acResult = await pool.query(`
      SELECT a.id, a.airline_id, a.airline_cabin_profile_id, at.max_passengers, a.condition
      FROM aircraft a
      JOIN aircraft_types at ON a.aircraft_type_id = at.id
      WHERE a.is_active = 1
        AND EXISTS (SELECT 1 FROM weekly_schedule ws WHERE ws.aircraft_id = a.id)
    `);
    const aircraft = acResult.rows.map(r => ({
      id: r.id, airline_id: r.airline_id, cabin_profile_id: r.airline_cabin_profile_id,
      max_passengers: r.max_passengers, condition: r.condition ?? 100
    }));

    let generated = 0;

    for (const ac of aircraft) {
      let ecoSeats = 0, bizSeats = 0, firstSeats = 0;
      let ecoSeatType = 'economy', bizSeatType = 'business', firstSeatType = 'first';
      if (ac.cabin_profile_id) {
        const clResult = await pool.query(
          'SELECT class_type, actual_capacity, seat_type FROM airline_cabin_classes WHERE profile_id = $1',
          [ac.cabin_profile_id]
        );
        for (const cr of clResult.rows) {
          if (cr.class_type === 'economy')       { ecoSeats = cr.actual_capacity; if (cr.seat_type) ecoSeatType = cr.seat_type; }
          else if (cr.class_type === 'business') { bizSeats = cr.actual_capacity; if (cr.seat_type) bizSeatType = cr.seat_type; }
          else if (cr.class_type === 'first')    { firstSeats = cr.actual_capacity; if (cr.seat_type) firstSeatType = cr.seat_type; }
        }
      }
      const totalSeats = (ecoSeats + bizSeats + firstSeats) || ac.max_passengers;

      const wsResult = await pool.query(`
        SELECT ws.id, ws.day_of_week, ws.flight_number,
               ws.departure_airport, ws.arrival_airport,
               ws.departure_time, ws.arrival_time,
               ws.economy_price, ws.business_price, ws.first_price,
               ws.route_id, ws.service_profile_id,
               COALESCE(r.distance_km, 0) as distance_km
        FROM weekly_schedule ws
        LEFT JOIN routes r ON ws.route_id = r.id
        WHERE ws.aircraft_id = $1
      `, [ac.id]);

      const entries = wsResult.rows.map(r => ({
        id: r.id, day_of_week: r.day_of_week, flight_number: r.flight_number,
        dep_airport: r.departure_airport, arr_airport: r.arrival_airport,
        dep_time: r.departure_time, arr_time: r.arrival_time,
        eco_price: r.economy_price, biz_price: r.business_price, first_price: r.first_price,
        route_id: r.route_id, service_profile_id: r.service_profile_id,
        distance_km: r.distance_km
      }));

      if (!entries.length) continue;

      for (let d = 0; d < 3; d++) {
        const dayUTC = new Date(now.getTime() + d * 86400000);

        const cetDateStr = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(dayUTC);

        const noonUTC = new Date(`${cetDateStr}T12:00:00Z`);
        const jsDay   = noonUTC.getUTCDay();
        const ourDay  = (jsDay + 6) % 7;

        for (const entry of entries) {
          if (entry.day_of_week !== ourDay) continue;

          const depDT = cetToUTC(cetDateStr, entry.dep_time);
          if (depDT <= now || depDT > horizon) continue;

          const [dh, dm] = entry.dep_time.split(':').map(Number);
          const [ah, am] = entry.arr_time.split(':').map(Number);
          const dMin = dh * 60 + dm;
          const aMin = ah * 60 + am;
          const durMin = ((aMin - dMin) + 1440) % 1440 || 1;
          const arrDT = new Date(depDT.getTime() + durMin * 60000);

          const utcDateStr = depDT.toISOString().slice(0, 10);
          const dupResult = await pool.query(
            "SELECT id FROM flights WHERE aircraft_id = $1 AND weekly_schedule_id = $2 AND departure_time::date = $3::date",
            [ac.id, entry.id, utcDateStr]
          );
          if (dupResult.rows[0]) continue;

          const ecoPrice   = entry.eco_price   ?? 0;
          const bizPrice   = entry.biz_price   ?? ecoPrice;
          const firstPrice = entry.first_price ?? ecoPrice;
          const distKm     = entry.distance_km || 1000;

          let depCat = 4, arrCat = 4;
          try {
            const catResult = await pool.query('SELECT iata_code, category FROM airports WHERE iata_code IN ($1, $2)', [entry.dep_airport, entry.arr_airport]);
            for (const cr of catResult.rows) {
              if (cr.iata_code === entry.dep_airport) depCat = cr.category || 4;
              else arrCat = cr.category || 4;
            }
          } catch (e) { /* use defaults */ }

          const mp = calcMarketPrices(distKm, depCat, arrCat);
          const atcFee = Math.round(distKm * ATC_RATE_PER_KM);

          const satEcoSeats = (ecoSeats + bizSeats + firstSeats > 0) ? ecoSeats : totalSeats;
          const { score: satisfactionScore, violations } = await calcFlightSatisfaction({
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

          await pool.query(`
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
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, 0, 0, 0, 'scheduled', $12, $13, 0, 1, $14, $15, $16, $17, $18, $19)
          `, [
            ac.airline_id, entry.route_id ?? null, ac.id, entry.flight_number,
            depDT.toISOString(), arrDT.toISOString(),
            ecoPrice, ecoPrice, entry.biz_price ?? null, entry.first_price ?? null,
            totalSeats,
            entry.id, entry.service_profile_id ?? null,
            atcFee, mp.eco, mp.biz, mp.first, satisfactionScore, violatedRulesJson
          ]);

          generated++;
        }
      }
    }

    if (generated > 0) {
      console.log(`[FlightGen] Generated ${generated} flight(s) from weekly templates`);
    }
  } catch (err) {
    console.error('generateFlights error:', err);
  }
}

// ── Hourly booking processor (runs every hour) ────────────────────────────────
async function processBookings() {
  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 72 * 60 * 60 * 1000);

    const result = await pool.query(`
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
        AND f.departure_time > $1::timestamptz
        AND f.departure_time <= $2::timestamptz
    `, [now.toISOString(), windowEnd.toISOString()]);

    const flightsList = result.rows.map(r => ({
      id: r.id, airline_id: r.airline_id, flight_number: r.flight_number,
      eco_price: r.eco_price, biz_price: r.biz_price, fir_price: r.fir_price,
      booked_eco: r.booked_eco, booked_biz: r.booked_biz, booked_fir: r.booked_fir,
      mp_eco: r.mp_eco, mp_biz: r.mp_biz, mp_fir: r.mp_fir,
      service_profile_id: r.service_profile_id, total_seats: r.total_seats,
      distance_km: r.distance_km, dep_cat: r.dep_cat, arr_cat: r.arr_cat,
      condition: r.condition, eco_cap: r.eco_cap, biz_cap: r.biz_cap, fir_cap: r.fir_cap,
    }));

    if (!flightsList.length) return;

    const airlineSatMultipliers = {};
    for (const f of flightsList) {
      if (!(f.airline_id in airlineSatMultipliers)) {
        const avgScore = await getAirlineSatisfactionScore(f.airline_id);
        airlineSatMultipliers[f.airline_id] = getSatisfactionMultiplier(avgScore);
      }
    }

    let totalNewPax = 0, totalRevenue = 0;
    const airlineTotals = {};

    for (const f of flightsList) {
      let ecoCap = f.eco_cap;
      let bizCap = f.biz_cap;
      let firCap = f.fir_cap;
      if (ecoCap + bizCap + firCap === 0) {
        ecoCap = f.total_seats;
      }

      const baseDemand = calcBaseDemandPerHour(f.dep_cat, f.arr_cat);
      const condFactor = calcConditionFactor(f.condition);
      const svcEco  = await calcServiceFactor(f.service_profile_id, 'economy');
      const svcBiz  = await calcServiceFactor(f.service_profile_id, 'business');
      const svcFir  = await calcServiceFactor(f.service_profile_id, 'first');
      const satMult = airlineSatMultipliers[f.airline_id] || 1.0;

      let newEco = 0, newBiz = 0, newFir = 0, addedRev = 0;

      if (f.eco_price > 0 && ecoCap > f.booked_eco) {
        const attr = calcPriceAttractiveness(f.eco_price, f.mp_eco || f.eco_price);
        const rate = baseDemand * attr * svcEco * condFactor * satMult;
        newEco = Math.max(0, Math.min(ecoCap - f.booked_eco,
          Math.round(rate * (0.85 + Math.random() * 0.30))));
        addedRev += newEco * f.eco_price;
      }

      if (f.biz_price > 0 && bizCap > f.booked_biz) {
        const attr = calcPriceAttractiveness(f.biz_price, f.mp_biz || f.biz_price);
        const rate = baseDemand * 0.15 * attr * svcBiz * condFactor * satMult;
        newBiz = Math.max(0, Math.min(bizCap - f.booked_biz,
          Math.round(rate * (0.85 + Math.random() * 0.30))));
        addedRev += newBiz * f.biz_price;
      }

      if (f.fir_price > 0 && firCap > f.booked_fir) {
        const attr = calcPriceAttractiveness(f.fir_price, f.mp_fir || f.fir_price);
        const rate = baseDemand * 0.05 * attr * svcFir * condFactor * satMult;
        newFir = Math.max(0, Math.min(firCap - f.booked_fir,
          Math.round(rate * (0.85 + Math.random() * 0.30))));
        addedRev += newFir * f.fir_price;
      }

      if (newEco + newBiz + newFir <= 0) continue;

      const newTotal = (f.booked_eco + newEco) + (f.booked_biz + newBiz) + (f.booked_fir + newFir);
      const revToAdd = Math.round(addedRev);

      await pool.query(`
        UPDATE flights SET
          booked_economy  = booked_economy  + $1,
          booked_business = booked_business + $2,
          booked_first    = booked_first    + $3,
          seats_sold      = $4,
          revenue         = revenue + $5
        WHERE id = $6
      `, [newEco, newBiz, newFir, newTotal, revToAdd, f.id]);

      if (revToAdd > 0) {
        if (!airlineTotals[f.airline_id]) airlineTotals[f.airline_id] = { revenue: 0, pax: 0 };
        airlineTotals[f.airline_id].revenue += revToAdd;
        airlineTotals[f.airline_id].pax     += newEco + newBiz + newFir;
      }

      totalNewPax += newEco + newBiz + newFir;
      totalRevenue += revToAdd;
    }

    for (const [airlineId, totals] of Object.entries(airlineTotals)) {
      if (totals.revenue <= 0) continue;
      await pool.query('UPDATE airlines SET balance = balance + $1 WHERE id = $2', [totals.revenue, Number(airlineId)]);
      await pool.query(
        "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'flight_revenue', $2, $3)",
        [Number(airlineId), totals.revenue, `Ticket Sales (${totals.pax} passengers)`]
      );
    }

    if (totalNewPax > 0) {
      console.log(`[Bookings] +${totalNewPax} pax, $${totalRevenue.toLocaleString()} revenue`);
    }
  } catch (err) {
    console.error('processBookings error:', err);
  }
}

// Backfill satisfaction_score for flights that have NULL scores (up to 30 per cycle)
async function patchNullSatisfactionScores() {
  const findResult = await pool.query(`
    SELECT f.id, f.service_profile_id, f.aircraft_id,
           COALESCE(r.distance_km, ws_r.distance_km, 1000) AS distance_km
    FROM flights f
    LEFT JOIN routes r ON f.route_id = r.id
    LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
    LEFT JOIN routes ws_r ON ws.route_id = ws_r.id
    WHERE f.satisfaction_score IS NULL AND f.status != 'cancelled'
    LIMIT 30
  `);
  const toFix = findResult.rows.map(r => ({
    id: r.id, service_profile_id: r.service_profile_id, aircraft_id: r.aircraft_id,
    distance_km: r.distance_km || 1000
  }));

  for (const f of toFix) {
    let ecoSeats = 0, bizSeats = 0, firstSeats = 0;
    let ecoSeatType = 'economy', bizSeatType = 'business', firstSeatType = 'first';
    let condition = 100;

    if (f.aircraft_id) {
      const acResult = await pool.query(`
        SELECT ac.airline_cabin_profile_id, ac.condition, at.max_passengers
        FROM aircraft ac JOIN aircraft_types at ON ac.aircraft_type_id = at.id
        WHERE ac.id = $1
      `, [f.aircraft_id]);
      let cabinProfileId = null, maxPax = 100;
      if (acResult.rows[0]) {
        cabinProfileId = acResult.rows[0].airline_cabin_profile_id;
        condition = acResult.rows[0].condition ?? 100;
        maxPax = acResult.rows[0].max_passengers ?? 100;
      }

      if (cabinProfileId) {
        const clResult = await pool.query(
          'SELECT class_type, actual_capacity, seat_type FROM airline_cabin_classes WHERE profile_id = $1',
          [cabinProfileId]
        );
        for (const cr of clResult.rows) {
          if (cr.class_type === 'economy')       { ecoSeats = cr.actual_capacity; if (cr.seat_type) ecoSeatType = cr.seat_type; }
          else if (cr.class_type === 'business') { bizSeats = cr.actual_capacity; if (cr.seat_type) bizSeatType = cr.seat_type; }
          else if (cr.class_type === 'first')    { firstSeats = cr.actual_capacity; if (cr.seat_type) firstSeatType = cr.seat_type; }
        }
      }

      if (ecoSeats + bizSeats + firstSeats === 0) ecoSeats = maxPax;
    }

    const { score: satScore, violations: satViolations } = await calcFlightSatisfaction({
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

    await pool.query('UPDATE flights SET satisfaction_score = $1, violated_rules = $2 WHERE id = $3',
      [satScore, JSON.stringify(satViolations), f.id]);
  }

  if (toFix.length > 0) {
    console.log(`[SatBackfill] Patched satisfaction_score for ${toFix.length} flight(s)`);
  }
  return toFix.length;
}

// Process flights - update statuses and calculate revenue
async function processFlights() {
  try {
    await patchNullSatisfactionScores();

    const now = new Date();

    // ── Maintenance completion: restore condition to 100% ──────────────────
    const jsDay = now.getDay();
    const gameDow = jsDay === 0 ? 6 : jsDay - 1;
    const currentWeekMin = gameDow * 1440 + now.getHours() * 60 + now.getMinutes();

    const MAINT_BASE_COST = { L: 2000, M: 8000, H: 15000 };

    const pendingMaintResult = await pool.query(`
      SELECT ms.id, ms.aircraft_id, ms.day_of_week, ms.start_minutes, ms.duration_minutes, ms.airline_id
      FROM maintenance_schedule ms
      WHERE ms.last_completed_at IS NULL
         OR ms.last_completed_at < NOW() - INTERVAL '6 days'
    `);
    const pendingMaint = pendingMaintResult.rows.map(r => ({
      id: r.id, aircraft_id: r.aircraft_id, day_of_week: r.day_of_week,
      start_minutes: r.start_minutes, duration_minutes: r.duration_minutes, airline_id: r.airline_id
    }));

    for (const m of pendingMaint) {
      const maintWeekMin = m.day_of_week * 1440 + m.start_minutes + m.duration_minutes;
      if (currentWeekMin >= maintWeekMin) {
        const acInfoResult = await pool.query(`
          SELECT a.condition, t.wake_turbulence_category, a.registration, a.home_airport
          FROM aircraft a
          JOIN aircraft_types t ON a.aircraft_type_id = t.id
          WHERE a.id = $1
        `, [m.aircraft_id]);
        let condition = 100, wakeCategory = 'M', registration = '', homeAirport = '';
        if (acInfoResult.rows[0]) {
          const ar = acInfoResult.rows[0];
          condition    = ar.condition ?? 100;
          wakeCategory = ar.wake_turbulence_category ?? 'M';
          registration = ar.registration ?? '';
          homeAirport  = ar.home_airport ?? '';
        }

        await pool.query('UPDATE aircraft SET condition = 100 WHERE id = $1', [m.aircraft_id]);

        const baseCost  = MAINT_BASE_COST[wakeCategory] ?? MAINT_BASE_COST.M;
        const maintCost = Math.round(baseCost * (2 - condition / 100));

        if (maintCost > 0 && m.airline_id) {
          await pool.query('UPDATE airlines SET balance = balance - $1 WHERE id = $2', [maintCost, m.airline_id]);
          const desc = `Maintenance - ${registration}${homeAirport ? ' - ' + homeAirport : ''}`;
          await pool.query(
            "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'maintenance', $2, $3)",
            [m.airline_id, -maintCost, desc]
          );
        }

        await pool.query('UPDATE maintenance_schedule SET last_completed_at = $1 WHERE id = $2', [now.toISOString(), m.id]);
        console.log(`[Maintenance] Aircraft ${m.aircraft_id} (${registration}) completed — condition restored to 100%, cost: $${maintCost.toLocaleString()}`);
      }
    }

    // Scheduled → Boarding (15 min before departure)
    const boardingCandidatesResult = await pool.query(`
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
        AND f.departure_time <= $1::timestamptz + INTERVAL '15 minutes'
    `, [now.toISOString()]);

    const boardingCandidates = boardingCandidatesResult.rows.map(r => ({
      id: r.id, flight_number: r.flight_number, airline_id: r.airline_id, aircraft_id: r.aircraft_id,
      dep_airport: r.dep_airport,
      booked_eco: r.booked_eco, booked_biz: r.booked_biz, booked_fir: r.booked_fir,
      eco_price: r.eco_price, biz_price: r.biz_price, fir_price: r.fir_price,
      rev_collected: r.rev_collected,
      current_location: r.current_location,
    }));

    for (const f of boardingCandidates) {
      if (f.current_location !== null && f.current_location !== f.dep_airport) {
        let penalty = 0;
        if (f.rev_collected) {
          penalty += f.booked_eco * f.eco_price * 1.2;
          penalty += f.booked_biz * (f.biz_price || f.eco_price) * 1.2;
          penalty += f.booked_fir * (f.fir_price || f.eco_price) * 1.2;
        }
        penalty = Math.round(penalty);

        await pool.query("UPDATE flights SET status = 'cancelled' WHERE id = $1", [f.id]);

        if (penalty > 0) {
          await pool.query('UPDATE airlines SET balance = balance - $1 WHERE id = $2', [penalty, f.airline_id]);
          await pool.query(
            "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'other', $2, $3)",
            [f.airline_id, -penalty, `Flight ${f.flight_number} cancelled - aircraft not at ${f.dep_airport} (at ${f.current_location})`]
          );
        }

        console.log(`[FlightProc] ${f.flight_number} CANCELLED - not at ${f.dep_airport}, at ${f.current_location}, penalty $${penalty}`);
        continue;
      }

      await pool.query("UPDATE flights SET status = 'boarding' WHERE id = $1", [f.id]);
    }

    // Boarding → In-Flight
    const boardingReadyResult = await pool.query(`
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
      AND f.departure_time <= $1::timestamptz
    `, [now.toISOString()]);

    const departingFlights = boardingReadyResult.rows.map(r => ({
      id: r.id, flight_number: r.flight_number, distance_km: r.distance_km, fuel_per_km: r.fuel_per_km
    }));

    if (departingFlights.length > 0) {
      const fpResult = await pool.query('SELECT price_per_liter FROM fuel_prices ORDER BY created_at DESC LIMIT 1');
      let currentFuelPrice = 0.64;
      if (fpResult.rows[0]) currentFuelPrice = fpResult.rows[0].price_per_liter;

      for (const f of departingFlights) {
        const fuelKg = Math.round(f.distance_km * f.fuel_per_km);
        const fuelCost = Math.round(fuelKg * currentFuelPrice);
        await pool.query(
          "UPDATE flights SET status = 'in-flight', fuel_cost = $1 WHERE id = $2",
          [fuelCost, f.id]
        );
      }
      console.log(`[FlightProc] ${departingFlights.length} flight(s) departed at $${currentFuelPrice.toFixed(2)}/kg fuel`);
    }

    // In-Flight → Completed
    const completedResult = await pool.query(`
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
      AND f.arrival_time <= $1::timestamptz
    `, [now.toISOString()]);

    const completedFlights = completedResult.rows.map(row => ({
      id: row.id,
      airline_id: row.airline_id,
      seats_sold: row.seats_sold,
      ticket_price: row.ticket_price,
      aircraft_id: row.aircraft_id,
      arrival_airport: row.arrival_airport,
      service_profile_id: row.service_profile_id,
      departure_time: row.departure_time,
      arrival_time: row.arrival_time,
      booking_revenue_collected: row.booking_revenue_collected,
      flight_number: row.flight_number,
      departure_airport: row.departure_airport,
      distance_km: row.distance_km,
      wake_cat: row.wake_cat,
      fuel_cost: row.fuel_cost,
      atc_fee: row.atc_fee,
      landing_fee_light: row.landing_fee_light,
      landing_fee_medium: row.landing_fee_medium,
      landing_fee_heavy: row.landing_fee_heavy,
      arr_gh_light: row.arr_gh_light, arr_gh_medium: row.arr_gh_medium, arr_gh_heavy: row.arr_gh_heavy,
      dep_gh_light: row.dep_gh_light, dep_gh_medium: row.dep_gh_medium, dep_gh_heavy: row.dep_gh_heavy,
      booked_eco: row.booked_eco,
      booked_biz: row.booked_biz,
      booked_fir: row.booked_fir,
      total_capacity: row.total_capacity,
    }));

    for (const flight of completedFlights) {
      const cateringCost = calcCateringCost(
        flight.distance_km,
        flight.booked_eco,
        flight.booked_biz,
        flight.booked_fir
      );

      if (flight.booking_revenue_collected) {
        const distKm = flight.distance_km || 0;
        const wakeCategory = flight.wake_cat || 'M';

        let landingFee = 0;
        if (wakeCategory === 'L') landingFee = flight.landing_fee_light  || 500;
        else if (wakeCategory === 'M') landingFee = flight.landing_fee_medium || 1500;
        else                           landingFee = flight.landing_fee_heavy  || 5000;

        const wc = (flight.wake_cat || 'M').toUpperCase();
        const arrGH = wc === 'L' ? (flight.arr_gh_light || 400)  : wc === 'H' ? (flight.arr_gh_heavy || 950)  : (flight.arr_gh_medium || 650);
        const depGH = wc === 'L' ? (flight.dep_gh_light || 400)  : wc === 'H' ? (flight.dep_gh_heavy || 950)  : (flight.dep_gh_medium || 650);
        const groundHandling = arrGH + depGH;

        const atcFee = flight.atc_fee > 0 ? flight.atc_fee : Math.round(distKm * ATC_RATE_PER_KM);
        const fuelCost = flight.fuel_cost || 0;
        const totalCosts = landingFee + groundHandling + atcFee + fuelCost + cateringCost;

        await pool.query(
          'UPDATE flights SET status = $1, atc_fee = CASE WHEN atc_fee = 0 THEN $2 ELSE atc_fee END, landing_fee = $3, ground_handling_cost = $4, catering_cost = $5 WHERE id = $6',
          ['completed', atcFee, landingFee, groundHandling, cateringCost, flight.id]
        );

        if (flight.aircraft_id) {
          const flightHours = flight.departure_time && flight.arrival_time
            ? (new Date(flight.arrival_time) - new Date(flight.departure_time)) / 3600000
            : 0;
          await pool.query(
            'UPDATE aircraft SET current_location = $1, total_flight_hours = total_flight_hours + $2 WHERE id = $3',
            [flight.arrival_airport || null, flightHours, flight.aircraft_id]
          );
          await degradeCondition(flight.aircraft_id, flightHours, flight.wake_cat);
        }

        if (totalCosts > 0) {
          await pool.query('UPDATE airlines SET balance = balance - $1 WHERE id = $2', [totalCosts, flight.airline_id]);
          await pool.query(
            "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'other', $2, $3)",
            [flight.airline_id, -totalCosts, `Flight Costs - ${flight.flight_number}`]
          );
        }

        console.log(`Flight ${flight.id} (${flight.flight_number}) landed. Landing: $${landingFee.toLocaleString()}, Ground: $${groundHandling.toLocaleString()}, ATC: $${atcFee.toLocaleString()}, Fuel: $${fuelCost.toLocaleString()}, Catering: $${cateringCost.toLocaleString()}, Total costs: $${totalCosts.toLocaleString()}`);
      } else {
        const revenue = flight.seats_sold * flight.ticket_price;
        const netRevenue = revenue - cateringCost;

        await pool.query('UPDATE flights SET status = $1, revenue = $2, catering_cost = $3 WHERE id = $4',
          ['completed', netRevenue, cateringCost, flight.id]);

        if (flight.aircraft_id) {
          const flightHours = flight.departure_time && flight.arrival_time
            ? (new Date(flight.arrival_time) - new Date(flight.departure_time)) / 3600000
            : 0;
          await pool.query(
            'UPDATE aircraft SET current_location = $1, total_flight_hours = total_flight_hours + $2 WHERE id = $3',
            [flight.arrival_airport || null, flightHours, flight.aircraft_id]
          );
          await degradeCondition(flight.aircraft_id, flightHours, flight.wake_cat);
        }

        await pool.query('UPDATE airlines SET balance = balance + $1 WHERE id = $2', [netRevenue, flight.airline_id]);

        console.log(`Flight ${flight.id} completed (legacy). Revenue: $${revenue.toLocaleString()}, Catering: $${cateringCost.toLocaleString()}, Net: $${netRevenue.toLocaleString()}`);
      }

      // ── Award XP for completed flight ───────────────────────────────────────
      const totalBooked = (flight.booked_eco || 0) + (flight.booked_biz || 0) + (flight.booked_fir || 0);
      const loadFactor  = flight.total_capacity > 0 ? totalBooked / flight.total_capacity : 0.7;
      const xpEarned    = calcFlightXP(flight.distance_km || 0, loadFactor);
      await pool.query('UPDATE airlines SET total_points = total_points + $1 WHERE id = $2', [xpEarned, flight.airline_id]);
      await checkLevelUp(flight.airline_id);
      console.log(`[XP] Flight ${flight.flight_number}: +${xpEarned} XP (dist=${flight.distance_km}km, load=${(loadFactor*100).toFixed(0)}%)`);
    }

    // ── Complete transfer flights that have landed ──────────────────────────
    try {
      const pendingTransferResult = await pool.query(`
        SELECT id, aircraft_id, airline_id, arrival_airport, departure_time, arrival_time
        FROM transfer_flights WHERE status = 'scheduled'
      `);
      const pendingTransfers = pendingTransferResult.rows.map(r => ({
        id: r.id, aircraft_id: r.aircraft_id, airline_id: r.airline_id,
        arrival_airport: r.arrival_airport, departure_time: r.departure_time, arrival_time: r.arrival_time
      }));

      for (const t of pendingTransfers) {
        if (now >= new Date(t.arrival_time)) {
          await pool.query("UPDATE transfer_flights SET status = 'completed' WHERE id = $1", [t.id]);
          const flightHours = (new Date(t.arrival_time) - new Date(t.departure_time)) / 3600000;
          await pool.query(
            'UPDATE aircraft SET current_location = $1, total_flight_hours = total_flight_hours + $2 WHERE id = $3',
            [t.arrival_airport, flightHours, t.aircraft_id]
          );
          console.log(`Transfer flight ${t.id} completed → ${t.arrival_airport}`);
        }
      }
    } catch (err) {
      console.error('Transfer flight processing error:', err);
    }
  } catch (error) {
    console.error('Process flights error:', error);
  }
}

// Degrade aircraft condition after landing
const CONDITION_RATE = { L: 0.20, M: 0.25, H: 0.30 };
async function degradeCondition(aircraftId, flightHours, wakeCategory) {
  try {
    const rate = CONDITION_RATE[wakeCategory] ?? CONDITION_RATE.M;
    const loss = parseFloat(((flightHours * rate) + 0.15).toFixed(4));
    await pool.query(
      'UPDATE aircraft SET condition = GREATEST(0, ROUND((condition - $1)::numeric, 2)) WHERE id = $2',
      [loss, aircraftId]
    );
  } catch (err) {
    console.error('degradeCondition error:', err);
  }
}

// Backfill fuel price history if fewer than 24 entries exist
async function backfillFuelPrices() {
  try {
    const countResult = await pool.query('SELECT COUNT(*) as cnt FROM fuel_prices');
    const count = parseInt(countResult.rows[0].cnt);
    if (count >= 24) return;

    const curResult = await pool.query('SELECT price_per_liter FROM fuel_prices ORDER BY created_at DESC LIMIT 1');
    let price = 0.75;
    if (curResult.rows[0]) price = curResult.rows[0].price_per_liter;

    const needed = 24 - count;
    for (let i = needed; i >= 1; i--) {
      const isSpike = Math.random() < 0.10;
      let delta = isSpike ? (Math.random() * 0.60) - 0.30 : (Math.random() * 0.10) - 0.05;
      if (price > 0.90) delta -= 0.01;
      if (price < 0.50) delta += 0.01;
      price = Math.max(FUEL_MIN_PER_KG, Math.min(FUEL_MAX_PER_KG, price + delta));
      price = Math.round(price * 100) / 100;
      await pool.query(
        "INSERT INTO fuel_prices (price_per_liter, price_per_kg, created_at) VALUES ($1, $2, NOW() - ($3 * INTERVAL '1 hour'))",
        [price, Math.round(price * 1.25 * 100) / 100, i * 3]
      );
    }
    console.log(`[FuelPrice] Backfilled ${needed} historical price entries`);
  } catch (err) {
    console.error('backfillFuelPrices error:', err);
  }
}

// Generate a new fuel price — smooth random walk with occasional spikes
async function generateFuelPrice() {
  try {
    const lastResult = await pool.query('SELECT price_per_liter, created_at FROM fuel_prices ORDER BY created_at DESC LIMIT 1');
    let previousPrice = 0.75;
    if (lastResult.rows[0]) previousPrice = parseFloat(lastResult.rows[0].price_per_liter);

    const isSpike = Math.random() < 0.10;
    // Minimum absolute delta of 0.02 to guarantee visible change
    const sign = Math.random() < 0.5 ? 1 : -1;
    let delta = isSpike
      ? sign * (0.10 + Math.random() * 0.20)
      : sign * (0.02 + Math.random() * 0.08);
    if (previousPrice > 0.90) delta -= 0.02;
    if (previousPrice < 0.50) delta += 0.02;
    const newPrice = Math.max(FUEL_MIN_PER_KG, Math.min(FUEL_MAX_PER_KG, previousPrice + delta));
    const rounded = Math.round(newPrice * 100) / 100;

    await pool.query('INSERT INTO fuel_prices (price_per_liter, price_per_kg) VALUES ($1, $2)',
      [rounded, Math.round(rounded * 1.25 * 100) / 100]);

    // Keep only last 3 days of history
    await pool.query("DELETE FROM fuel_prices WHERE created_at < NOW() - INTERVAL '3 days'");

    console.log(`[FuelPrice] New price: $${rounded.toFixed(2)}/kg (prev $${previousPrice.toFixed(2)})${isSpike ? ' (spike)' : ''}`);
  } catch (err) {
    console.error('generateFuelPrice error:', err);
  }
}

// ── DEV: Route price calculator ───────────────────────────────────────────────
router.get('/dev/route-calc', authMiddleware, async (req, res) => {
  try {
    const { dep, arr, eco_price, biz_price, fir_price, condition = 100,
            service_profile_id, eco_cap, biz_cap, fir_cap } = req.query;

    if (!dep || !arr) return res.status(400).json({ error: 'dep and arr required' });

    function haversineKm(lat1, lon1, lat2, lon2) {
      const R = 6371, toRad = x => x * Math.PI / 180;
      const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
      return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
    }

    const getApt = async (code) => {
      const result = await pool.query('SELECT category, latitude, longitude, name FROM airports WHERE iata_code = $1', [code]);
      if (result.rows[0]) {
        const row = result.rows[0];
        return { category: row.category || 4, lat: row.latitude, lon: row.longitude, name: row.name };
      }
      return { category: 4, lat: null, lon: null, name: code };
    };

    const depApt = await getApt(dep.toUpperCase());
    const arrApt = await getApt(arr.toUpperCase());

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
    const svcEco     = await calcServiceFactor(spId, 'economy');
    const svcBiz     = await calcServiceFactor(spId, 'business');
    const svcFir     = await calcServiceFactor(spId, 'first');
    const condFactor = calcConditionFactor(cond);
    const baseRate   = calcBaseRate(distKm);
    const aptPremium = calcAirportPremium(depApt.category, arrApt.category);

    const ecoAttr = ecoPx > 0 ? calcPriceAttractiveness(ecoPx, mkt.eco)   : null;
    const bizAttr = bizPx > 0 ? calcPriceAttractiveness(bizPx, mkt.biz)   : null;
    const firAttr = firPx > 0 ? calcPriceAttractiveness(firPx, mkt.first) : null;

    const ecoRateHr = ecoPx > 0 ? baseDemand * 1.00 * ecoAttr * svcEco * condFactor : 0;
    const bizRateHr = bizPx > 0 ? baseDemand * 0.15 * bizAttr * svcBiz * condFactor : 0;
    const firRateHr = firPx > 0 ? baseDemand * 0.05 * firAttr * svcFir * condFactor : 0;

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

// Schedule fn to run at the next top-of-hour (:00:00), then every 60 min
function scheduleAtMinute13(fn, label) {
  const now = new Date();
  let minsUntil = (13 - now.getMinutes() + 60) % 60;
  if (minsUntil === 0) minsUntil = 60; // already past :13 this hour, wait for next
  const msUntil = minsUntil * 60000
                - now.getSeconds() * 1000
                - now.getMilliseconds();
  const minUntil = Math.round(msUntil / 60000);
  console.log(`[${label}] Next run in ${minUntil} min (at :13)`);
  setTimeout(() => {
    fn();
    setInterval(fn, 60 * 60 * 1000);
  }, msUntil);
}

function startFlightProcessor() {
  if (flightProcessorInterval) return;

  console.log('Starting flight processor...');
  // Generate flights, bookings, fuel price — all synced to :13 each hour
  scheduleAtMinute13(generateFlights, 'FlightGen');
  scheduleAtMinute13(processBookings, 'Bookings');
  // Fuel price: generate immediately on start, backfill history, then sync to :13
  generateFuelPrice();
  backfillFuelPrices();
  scheduleAtMinute13(generateFuelPrice, 'FuelPrice');
  // Process flight statuses every 10 seconds (status changes need to be fast)
  flightProcessorInterval = setInterval(processFlights, 10000);
  setTimeout(processFlights, 1000);
}

function stopFlightProcessor() {
  if (flightProcessorInterval) {
    clearInterval(flightProcessorInterval);
    flightProcessorInterval = null;
  }
}

// ── Client feedback: completed flights in last 24h with satisfaction issues ───
router.get('/client-feedback', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    const result = await pool.query(`
      SELECT f.id, f.flight_number, f.satisfaction_score, f.violated_rules,
             f.arrival_time, f.aircraft_id,
             COALESCE(r.departure_airport, ws.departure_airport) AS dep_iata,
             COALESCE(r.arrival_airport,   ws.arrival_airport)   AS arr_iata,
             ac.registration
      FROM flights f
      LEFT JOIN routes r ON f.route_id = r.id
      LEFT JOIN weekly_schedule ws ON f.weekly_schedule_id = ws.id
      LEFT JOIN aircraft ac ON f.aircraft_id = ac.id
      WHERE f.airline_id = $1
        AND f.status = 'completed'
        AND f.satisfaction_score IS NOT NULL
        AND f.satisfaction_score < 85
        AND f.violated_rules IS NOT NULL
        AND f.arrival_time >= NOW() - INTERVAL '24 hours'
      ORDER BY f.arrival_time DESC
      LIMIT 50
    `, [airlineId]);

    const items = result.rows.map(r => ({
      id: r.id, flight_number: r.flight_number, satisfaction_score: r.satisfaction_score,
      violated_rules: r.violated_rules ? JSON.parse(r.violated_rules) : [],
      arrival_time: r.arrival_time, aircraft_id: r.aircraft_id,
      departure_airport: r.dep_iata, arrival_airport: r.arr_iata,
      registration: r.registration,
    }));
    res.json({ items });
  } catch (err) {
    console.error('client-feedback error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Weekly flight schedule (all aircraft, all routes) ────────────────────────
router.get('/weekly-schedule', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const result = await pool.query(`
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
      WHERE ac.airline_id = $1
      ORDER BY arr.name ASC, ws.day_of_week ASC, ws.departure_time ASC
    `, [airlineId]);

    const entries = result.rows.map(r => ({
      id: r.id, day_of_week: r.day_of_week, flight_number: r.flight_number,
      departure_airport: r.departure_airport, arrival_airport: r.arrival_airport,
      departure_time: r.departure_time, arrival_time: r.arrival_time,
      aircraft_id: r.aircraft_id, registration: r.registration, is_active: r.is_active,
      aircraft_type: r.aircraft_type, departure_name: r.departure_name, arrival_name: r.arrival_name,
    }));
    res.json({ entries });
  } catch (error) {
    console.error('Weekly schedule error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
export { startFlightProcessor, stopFlightProcessor, processFlights, generateFlights, generateFuelPrice, calculateFlightDuration, processBookings, checkLevelUp, XP_THRESHOLDS };
