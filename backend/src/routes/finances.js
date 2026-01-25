import express from 'express';
import { getDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// Get financial overview
router.get('/overview', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();

    // Get airline
    const airlineStmt = db.prepare('SELECT id, balance, created_at FROM airlines WHERE user_id = ?');
    airlineStmt.bind([req.userId]);

    if (!airlineStmt.step()) {
      airlineStmt.free();
      return res.status(400).json({ error: 'No airline found' });
    }

    const airlineRow = airlineStmt.get();
    const airlineId = airlineRow[0];
    const balance = airlineRow[1];
    const createdAt = airlineRow[2];
    airlineStmt.free();

    // Get total revenue from completed flights
    const revenueStmt = db.prepare(`
      SELECT COALESCE(SUM(revenue), 0) as total_revenue,
             COUNT(*) as total_flights,
             COALESCE(SUM(seats_sold), 0) as total_passengers
      FROM flights
      WHERE airline_id = ? AND status = 'completed'
    `);
    revenueStmt.bind([airlineId]);
    revenueStmt.step();
    const revenueRow = revenueStmt.get();
    const totalRevenue = revenueRow[0];
    const totalFlights = revenueRow[1];
    const totalPassengers = revenueRow[2];
    revenueStmt.free();

    // Get total aircraft costs
    const costsStmt = db.prepare(`
      SELECT COALESCE(SUM(at.new_price), 0) as total_aircraft_cost,
             COUNT(*) as fleet_size
      FROM aircraft a
      JOIN aircraft_types at ON a.aircraft_type_id = at.id
      WHERE a.airline_id = ?
    `);
    costsStmt.bind([airlineId]);
    costsStmt.step();
    const costsRow = costsStmt.get();
    const totalAircraftCost = costsRow[0];
    const fleetSize = costsRow[1];
    costsStmt.free();

    // Calculate profit/loss (starting balance was 50M)
    const startingBalance = 50000000;
    const netProfit = balance - startingBalance;

    res.json({
      balance,
      totalRevenue,
      totalAircraftCost,
      netProfit,
      totalFlights,
      totalPassengers,
      fleetSize,
      createdAt
    });
  } catch (error) {
    console.error('Get financial overview error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get revenue by route
router.get('/revenue-by-route', authMiddleware, (req, res) => {
  try {
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

    // Get revenue grouped by route
    const routeRevenueStmt = db.prepare(`
      SELECT
        r.id,
        r.flight_number,
        r.departure_airport,
        r.arrival_airport,
        r.distance_km,
        COUNT(f.id) as flight_count,
        COALESCE(SUM(f.revenue), 0) as total_revenue,
        COALESCE(SUM(f.seats_sold), 0) as total_passengers,
        COALESCE(AVG(f.ticket_price), 0) as avg_ticket_price,
        COALESCE(AVG(CAST(f.seats_sold AS FLOAT) / f.total_seats * 100), 0) as avg_load_factor
      FROM routes r
      LEFT JOIN flights f ON r.id = f.route_id AND f.status = 'completed'
      WHERE r.airline_id = ?
      GROUP BY r.id
      ORDER BY total_revenue DESC
    `);
    routeRevenueStmt.bind([airlineId]);

    const routeRevenue = [];
    while (routeRevenueStmt.step()) {
      const row = routeRevenueStmt.get();
      routeRevenue.push({
        id: row[0],
        flight_number: row[1],
        departure_airport: row[2],
        arrival_airport: row[3],
        distance_km: row[4],
        flight_count: row[5],
        total_revenue: row[6],
        total_passengers: row[7],
        avg_ticket_price: Math.round(row[8]),
        avg_load_factor: Math.round(row[9])
      });
    }
    routeRevenueStmt.free();

    res.json({ routeRevenue });
  } catch (error) {
    console.error('Get revenue by route error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get aircraft costs and performance
router.get('/aircraft-costs', authMiddleware, (req, res) => {
  try {
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

    // Get aircraft with costs and revenue
    const aircraftStmt = db.prepare(`
      SELECT
        a.id,
        a.registration,
        a.name,
        a.purchased_at,
        at.full_name,
        at.new_price as purchase_price,
        at.max_seats,
        COUNT(f.id) as flights_completed,
        COALESCE(SUM(f.revenue), 0) as total_revenue,
        COALESCE(SUM(f.seats_sold), 0) as total_passengers
      FROM aircraft a
      JOIN aircraft_types at ON a.aircraft_type_id = at.id
      LEFT JOIN flights f ON a.id = f.aircraft_id AND f.status = 'completed'
      WHERE a.airline_id = ?
      GROUP BY a.id
      ORDER BY total_revenue DESC
    `);
    aircraftStmt.bind([airlineId]);

    const aircraftCosts = [];
    while (aircraftStmt.step()) {
      const row = aircraftStmt.get();
      const purchasePrice = row[5];
      const totalRevenue = row[8];
      aircraftCosts.push({
        id: row[0],
        registration: row[1],
        name: row[2],
        purchased_at: row[3],
        aircraft_type: row[4],
        purchase_price: purchasePrice,
        max_seats: row[6],
        flights_completed: row[7],
        total_revenue: totalRevenue,
        total_passengers: row[9],
        roi: purchasePrice > 0 ? Math.round((totalRevenue / purchasePrice) * 100) : 0
      });
    }
    aircraftStmt.free();

    res.json({ aircraftCosts });
  } catch (error) {
    console.error('Get aircraft costs error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get profit/loss over time (daily for last 30 days)
router.get('/profit-history', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();

    // Get airline
    const airlineStmt = db.prepare('SELECT id, created_at FROM airlines WHERE user_id = ?');
    airlineStmt.bind([req.userId]);

    if (!airlineStmt.step()) {
      airlineStmt.free();
      return res.status(400).json({ error: 'No airline found' });
    }

    const airlineRow = airlineStmt.get();
    const airlineId = airlineRow[0];
    airlineStmt.free();

    // Get daily revenue from completed flights (last 30 days)
    const revenueHistoryStmt = db.prepare(`
      SELECT
        date(arrival_time) as day,
        SUM(revenue) as daily_revenue,
        COUNT(*) as flight_count,
        SUM(seats_sold) as passengers
      FROM flights
      WHERE airline_id = ?
        AND status = 'completed'
        AND arrival_time >= datetime('now', '-30 days')
      GROUP BY date(arrival_time)
      ORDER BY day ASC
    `);
    revenueHistoryStmt.bind([airlineId]);

    const revenueHistory = [];
    while (revenueHistoryStmt.step()) {
      const row = revenueHistoryStmt.get();
      revenueHistory.push({
        date: row[0],
        revenue: row[1],
        flights: row[2],
        passengers: row[3]
      });
    }
    revenueHistoryStmt.free();

    // Get aircraft purchases by date
    const purchaseHistoryStmt = db.prepare(`
      SELECT
        date(a.purchased_at) as day,
        SUM(at.new_price) as daily_cost,
        COUNT(*) as aircraft_count
      FROM aircraft a
      JOIN aircraft_types at ON a.aircraft_type_id = at.id
      WHERE a.airline_id = ?
        AND a.purchased_at >= datetime('now', '-30 days')
      GROUP BY date(a.purchased_at)
      ORDER BY day ASC
    `);
    purchaseHistoryStmt.bind([airlineId]);

    const purchaseHistory = [];
    while (purchaseHistoryStmt.step()) {
      const row = purchaseHistoryStmt.get();
      purchaseHistory.push({
        date: row[0],
        cost: row[1],
        count: row[2]
      });
    }
    purchaseHistoryStmt.free();

    // Combine into daily profit/loss
    const days = new Map();

    // Add revenue data
    for (const entry of revenueHistory) {
      days.set(entry.date, {
        date: entry.date,
        revenue: entry.revenue,
        costs: 0,
        flights: entry.flights,
        passengers: entry.passengers
      });
    }

    // Add cost data
    for (const entry of purchaseHistory) {
      if (days.has(entry.date)) {
        days.get(entry.date).costs = entry.cost;
      } else {
        days.set(entry.date, {
          date: entry.date,
          revenue: 0,
          costs: entry.cost,
          flights: 0,
          passengers: 0
        });
      }
    }

    // Convert to array and calculate profit
    const profitHistory = Array.from(days.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(day => ({
        ...day,
        profit: day.revenue - day.costs
      }));

    res.json({ profitHistory });
  } catch (error) {
    console.error('Get profit history error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get recent transactions
router.get('/transactions', authMiddleware, (req, res) => {
  try {
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

    // Get recent transactions from flights (as revenue) and aircraft (as costs)
    // Since we don't have a transactions table populated yet, derive from data
    const transactions = [];

    // Get recent completed flights as revenue transactions
    const flightsStmt = db.prepare(`
      SELECT f.id, f.flight_number, f.revenue, f.arrival_time,
             r.departure_airport, r.arrival_airport
      FROM flights f
      JOIN routes r ON f.route_id = r.id
      WHERE f.airline_id = ? AND f.status = 'completed'
      ORDER BY f.arrival_time DESC
      LIMIT 20
    `);
    flightsStmt.bind([airlineId]);

    while (flightsStmt.step()) {
      const row = flightsStmt.get();
      transactions.push({
        id: `flight_${row[0]}`,
        type: 'flight_revenue',
        amount: row[2],
        description: `${row[1]}: ${row[4]} → ${row[5]}`,
        date: row[3]
      });
    }
    flightsStmt.free();

    // Get recent aircraft purchases as cost transactions
    const aircraftStmt = db.prepare(`
      SELECT a.id, a.registration, at.new_price, at.full_name, a.purchased_at
      FROM aircraft a
      JOIN aircraft_types at ON a.aircraft_type_id = at.id
      WHERE a.airline_id = ?
      ORDER BY a.purchased_at DESC
      LIMIT 10
    `);
    aircraftStmt.bind([airlineId]);

    while (aircraftStmt.step()) {
      const row = aircraftStmt.get();
      transactions.push({
        id: `aircraft_${row[0]}`,
        type: 'aircraft_purchase',
        amount: -row[2],
        description: `${row[3]} (${row[1]})`,
        date: row[4]
      });
    }
    aircraftStmt.free();

    // Sort by date descending
    transactions.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ transactions: transactions.slice(0, 25) });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
