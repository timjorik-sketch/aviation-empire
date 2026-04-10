import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// Get financial overview
router.get('/overview', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const airlineResult = await pool.query('SELECT balance, created_at FROM airlines WHERE id = $1', [airlineId]);
    if (!airlineResult.rows[0]) return res.status(400).json({ error: 'No airline found' });
    const { balance, created_at: createdAt } = airlineResult.rows[0];

    // Get total revenue from completed flights
    const revenueResult = await pool.query(`
      SELECT COALESCE(SUM(revenue), 0) as total_revenue,
             COUNT(*) as total_flights,
             COALESCE(SUM(seats_sold), 0) as total_passengers
      FROM flights
      WHERE airline_id = $1 AND status = 'completed'
    `, [airlineId]);
    const { total_revenue: totalRevenue, total_flights: totalFlights, total_passengers: totalPassengers } = revenueResult.rows[0];

    // Get total aircraft costs
    const costsResult = await pool.query(`
      SELECT COALESCE(SUM(at.new_price_usd), 0) as total_aircraft_cost,
             COUNT(*) as fleet_size
      FROM aircraft a
      JOIN aircraft_types at ON a.aircraft_type_id = at.id
      WHERE a.airline_id = $1
    `, [airlineId]);
    const { total_aircraft_cost: totalAircraftCost, fleet_size: fleetSize } = costsResult.rows[0];

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
router.get('/revenue-by-route', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const result = await pool.query(`
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
        COALESCE(AVG(CAST(f.seats_sold AS FLOAT) / NULLIF(f.total_seats, 0) * 100), 0) as avg_load_factor
      FROM routes r
      LEFT JOIN flights f ON r.id = f.route_id AND f.status = 'completed'
      WHERE r.airline_id = $1
      GROUP BY r.id, r.flight_number, r.departure_airport, r.arrival_airport, r.distance_km
      ORDER BY total_revenue DESC
    `, [airlineId]);

    const routeRevenue = result.rows.map(row => ({
      id: row.id,
      flight_number: row.flight_number,
      departure_airport: row.departure_airport,
      arrival_airport: row.arrival_airport,
      distance_km: row.distance_km,
      flight_count: parseInt(row.flight_count),
      total_revenue: parseFloat(row.total_revenue),
      total_passengers: parseInt(row.total_passengers),
      avg_ticket_price: Math.round(parseFloat(row.avg_ticket_price)),
      avg_load_factor: Math.round(parseFloat(row.avg_load_factor))
    }));

    res.json({ routeRevenue });
  } catch (error) {
    console.error('Get revenue by route error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get aircraft costs and performance
router.get('/aircraft-costs', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const result = await pool.query(`
      SELECT
        a.id,
        a.registration,
        a.name,
        a.purchased_at,
        at.full_name,
        at.new_price_usd as purchase_price,
        at.max_passengers,
        COUNT(f.id) as flights_completed,
        COALESCE(SUM(f.revenue), 0) as total_revenue,
        COALESCE(SUM(f.seats_sold), 0) as total_passengers
      FROM aircraft a
      JOIN aircraft_types at ON a.aircraft_type_id = at.id
      LEFT JOIN flights f ON a.id = f.aircraft_id AND f.status = 'completed'
      WHERE a.airline_id = $1
      GROUP BY a.id, a.registration, a.name, a.purchased_at, at.full_name, at.new_price_usd, at.max_passengers
      ORDER BY total_revenue DESC
    `, [airlineId]);

    const aircraftCosts = result.rows.map(row => {
      const purchasePrice = parseFloat(row.purchase_price);
      const totalRevenue = parseFloat(row.total_revenue);
      return {
        id: row.id,
        registration: row.registration,
        name: row.name,
        purchased_at: row.purchased_at,
        aircraft_type: row.full_name,
        purchase_price: purchasePrice,
        max_passengers: row.max_passengers,
        flights_completed: parseInt(row.flights_completed),
        total_revenue: totalRevenue,
        total_passengers: parseInt(row.total_passengers),
        roi: purchasePrice > 0 ? Math.round((totalRevenue / purchasePrice) * 100) : 0
      };
    });

    res.json({ aircraftCosts });
  } catch (error) {
    console.error('Get aircraft costs error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get profit/loss over time (daily for last 30 days)
router.get('/profit-history', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Get daily revenue from completed flights (last 30 days)
    const revenueResult = await pool.query(`
      SELECT
        DATE(arrival_time) as day,
        SUM(revenue) as daily_revenue,
        COUNT(*) as flight_count,
        SUM(seats_sold) as passengers
      FROM flights
      WHERE airline_id = $1
        AND status = 'completed'
        AND arrival_time >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(arrival_time)
      ORDER BY day ASC
    `, [airlineId]);

    const revenueHistory = revenueResult.rows.map(row => ({
      date: row.day,
      revenue: parseFloat(row.daily_revenue),
      flights: parseInt(row.flight_count),
      passengers: parseInt(row.passengers)
    }));

    // Get aircraft purchases by date
    const purchaseResult = await pool.query(`
      SELECT
        DATE(a.purchased_at) as day,
        SUM(at.new_price_usd) as daily_cost,
        COUNT(*) as aircraft_count
      FROM aircraft a
      JOIN aircraft_types at ON a.aircraft_type_id = at.id
      WHERE a.airline_id = $1
        AND a.purchased_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(a.purchased_at)
      ORDER BY day ASC
    `, [airlineId]);

    const purchaseHistory = purchaseResult.rows.map(row => ({
      date: row.day,
      cost: parseFloat(row.daily_cost),
      count: parseInt(row.aircraft_count)
    }));

    // Combine into daily profit/loss
    const days = new Map();

    for (const entry of revenueHistory) {
      days.set(entry.date, {
        date: entry.date,
        revenue: entry.revenue,
        costs: 0,
        flights: entry.flights,
        passengers: entry.passengers
      });
    }

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
router.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const transactions = [];

    // Get recent completed flights as revenue transactions
    const flightsResult = await pool.query(`
      SELECT f.id, f.flight_number, f.revenue, f.arrival_time,
             r.departure_airport, r.arrival_airport
      FROM flights f
      JOIN routes r ON f.route_id = r.id
      WHERE f.airline_id = $1 AND f.status = 'completed'
      ORDER BY f.arrival_time DESC
      LIMIT 20
    `, [airlineId]);

    for (const row of flightsResult.rows) {
      transactions.push({
        id: `flight_${row.id}`,
        type: 'flight_revenue',
        amount: parseFloat(row.revenue),
        description: `${row.flight_number}: ${row.departure_airport} → ${row.arrival_airport}`,
        date: row.arrival_time
      });
    }

    // Get recent aircraft purchases as cost transactions
    const aircraftResult = await pool.query(`
      SELECT a.id, a.registration, at.new_price_usd, at.full_name, a.purchased_at
      FROM aircraft a
      JOIN aircraft_types at ON a.aircraft_type_id = at.id
      WHERE a.airline_id = $1
      ORDER BY a.purchased_at DESC
      LIMIT 10
    `, [airlineId]);

    for (const row of aircraftResult.rows) {
      transactions.push({
        id: `aircraft_${row.id}`,
        type: 'aircraft_purchase',
        amount: -parseFloat(row.new_price_usd),
        description: `${row.full_name} (${row.registration})`,
        date: row.purchased_at
      });
    }

    // Sort by date descending
    transactions.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ transactions: transactions.slice(0, 25) });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get operational cost breakdown from completed flights
router.get('/cost-breakdown', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const result = await pool.query(`
      SELECT
        COALESCE(SUM(atc_fee), 0)  as total_atc,
        COALESCE(SUM(fuel_cost), 0) as total_fuel,
        COUNT(*) as completed_flights
      FROM flights
      WHERE airline_id = $1 AND status = 'completed' AND booking_revenue_collected = 1
    `, [airlineId]);
    const row = result.rows[0];

    res.json({
      total_atc: Math.round(parseFloat(row.total_atc)),
      total_fuel: Math.round(parseFloat(row.total_fuel)),
      completed_flights: parseInt(row.completed_flights)
    });
  } catch (error) {
    console.error('Get cost breakdown error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Comprehensive dashboard endpoint
router.get('/dashboard', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const balResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [airlineId]);
    if (!balResult.rows[0]) return res.status(400).json({ error: 'No airline found' });
    const balance = parseFloat(balResult.rows[0].balance);

    // Helper: single-row query returning first row
    const q = async (sql, params) => {
      const r = await pool.query(sql, params);
      return r.rows[0];
    };

    // ── Weekly KPIs ──────────────────────────────────────────────────────────
    const weeklyRevenueRow     = await q(`SELECT COALESCE(SUM(amount),0) as val FROM transactions WHERE airline_id=$1 AND type='flight_revenue' AND created_at>=NOW()-INTERVAL '7 days'`, [airlineId]);
    const prevWeeklyRevenueRow = await q(`SELECT COALESCE(SUM(amount),0) as val FROM transactions WHERE airline_id=$1 AND type='flight_revenue' AND created_at>=NOW()-INTERVAL '14 days' AND created_at<NOW()-INTERVAL '7 days'`, [airlineId]);
    const weeklyCostsRow       = await q(`SELECT COALESCE(SUM(ABS(amount)),0) as val FROM transactions WHERE airline_id=$1 AND amount<0 AND created_at>=NOW()-INTERVAL '7 days'`, [airlineId]);
    const prevWeeklyCostsRow   = await q(`SELECT COALESCE(SUM(ABS(amount)),0) as val FROM transactions WHERE airline_id=$1 AND amount<0 AND created_at>=NOW()-INTERVAL '14 days' AND created_at<NOW()-INTERVAL '7 days'`, [airlineId]);

    const weeklyRevenue     = parseFloat(weeklyRevenueRow.val) || 0;
    const prevWeeklyRevenue = parseFloat(prevWeeklyRevenueRow.val) || 0;
    const weeklyCosts       = parseFloat(weeklyCostsRow.val) || 0;
    const prevWeeklyCosts   = parseFloat(prevWeeklyCostsRow.val) || 0;
    const weeklyProfit     = weeklyRevenue - weeklyCosts;
    const prevWeeklyProfit = prevWeeklyRevenue - prevWeeklyCosts;
    const balancePrevWeek  = balance - weeklyProfit;

    // ── Daily history (5 days) ───────────────────────────────────────────────
    const dailyRevResult = await pool.query(
      `SELECT DATE(created_at) as d, COALESCE(SUM(amount),0) as rev FROM transactions WHERE airline_id=$1 AND type='flight_revenue' AND created_at>=NOW()-INTERVAL '7 days' GROUP BY d ORDER BY d ASC`,
      [airlineId]
    );
    const dailyMap = new Map();
    for (const r of dailyRevResult.rows) {
      const key = r.d.toISOString ? r.d.toISOString().slice(0, 10) : String(r.d);
      dailyMap.set(key, { date: key, revenue: parseFloat(r.rev), costs: 0 });
    }

    const dailyCostResult = await pool.query(
      `SELECT DATE(created_at) as d, COALESCE(SUM(ABS(amount)),0) as cost FROM transactions WHERE airline_id=$1 AND amount<0 AND created_at>=NOW()-INTERVAL '7 days' GROUP BY d ORDER BY d ASC`,
      [airlineId]
    );
    for (const r of dailyCostResult.rows) {
      const key = r.d.toISOString ? r.d.toISOString().slice(0, 10) : String(r.d);
      if (dailyMap.has(key)) {
        dailyMap.get(key).costs = parseFloat(r.cost);
      } else {
        dailyMap.set(key, { date: key, revenue: 0, costs: parseFloat(r.cost) });
      }
    }
    const dailyHistory = Array.from(dailyMap.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(d => ({ ...d, profit: d.revenue - d.costs }));

    // ── Revenue breakdown (this week) ────────────────────────────────────────
    const ticketRevenueRow    = await q(`SELECT COALESCE(SUM(amount),0) as val FROM transactions WHERE airline_id=$1 AND type='flight_revenue' AND created_at>=NOW()-INTERVAL '7 days'`, [airlineId]);
    const aircraftSalesRevRow = await q(`SELECT COALESCE(SUM(amount),0) as val FROM transactions WHERE airline_id=$1 AND amount>0 AND type!='flight_revenue' AND description LIKE '%Sale%' AND created_at>=NOW()-INTERVAL '7 days'`, [airlineId]);
    const otherRevenueRow     = await q(`SELECT COALESCE(SUM(amount),0) as val FROM transactions WHERE airline_id=$1 AND amount>0 AND type!='flight_revenue' AND description NOT LIKE '%Sale%' AND created_at>=NOW()-INTERVAL '7 days'`, [airlineId]);

    const ticketRevenue    = parseFloat(ticketRevenueRow.val) || 0;
    const aircraftSalesRev = parseFloat(aircraftSalesRevRow.val) || 0;
    const otherRevenue     = parseFloat(otherRevenueRow.val) || 0;

    // ── Cost breakdown (this week) ───────────────────────────────────────────
    const fcRow = await q(
      `SELECT COALESCE(SUM(fuel_cost),0) as fuel, COALESCE(SUM(atc_fee),0) as atc, COUNT(*) as cnt, COALESCE(SUM(seats_sold),0) as pax, COALESCE(AVG(CAST(seats_sold AS FLOAT)/NULLIF(total_seats,0)*100),0) as lf FROM flights WHERE airline_id=$1 AND status='completed' AND arrival_time>=NOW()-INTERVAL '7 days'`,
      [airlineId]
    );
    const weekFuel = Math.round(parseFloat(fcRow.fuel));
    const weekAtc  = Math.round(parseFloat(fcRow.atc));
    const weekFlights    = parseInt(fcRow.cnt);
    const weekPassengers = parseInt(fcRow.pax);
    const weekLoadFactor = Math.round(parseFloat(fcRow.lf));

    const totalFlightCostTxRow = await q(`SELECT COALESCE(SUM(ABS(amount)),0) as val FROM transactions WHERE airline_id=$1 AND description LIKE 'Flight Costs%' AND created_at>=NOW()-INTERVAL '7 days'`, [airlineId]);
    const totalFlightCostTx = parseFloat(totalFlightCostTxRow.val) || 0;
    const airportFeesCatering = Math.max(0, Math.round(totalFlightCostTx - weekFuel - weekAtc));

    const weekMaintenanceRow   = await q(`SELECT COALESCE(SUM(ABS(amount)),0) as val FROM transactions WHERE airline_id=$1 AND (type='maintenance' OR description LIKE '%Maintenance%') AND amount<0 AND created_at>=NOW()-INTERVAL '7 days'`, [airlineId]);
    const weekCancellationsRow = await q(`SELECT COALESCE(SUM(ABS(amount)),0) as val FROM transactions WHERE airline_id=$1 AND (description ILIKE '%cancel%' OR description ILIKE '%penalty%') AND amount<0 AND created_at>=NOW()-INTERVAL '7 days'`, [airlineId]);
    const weekAircraftPurchRow = await q(`SELECT COALESCE(SUM(ABS(amount)),0) as val FROM transactions WHERE airline_id=$1 AND type='aircraft_purchase' AND created_at>=NOW()-INTERVAL '7 days'`, [airlineId]);
    const weekPayrollRow       = await q(`SELECT COALESCE(SUM(ABS(amount)),0) as val FROM transactions WHERE airline_id=$1 AND description='Wöchentliche Personalkosten' AND amount<0 AND created_at>=NOW()-INTERVAL '7 days'`, [airlineId]);
    const weekExpansionRow     = await q(`SELECT COALESCE(SUM(ABS(amount)),0) as val FROM transactions WHERE airline_id=$1 AND amount<0 AND (description LIKE 'Opened destination%' OR description LIKE 'Mega Hub%' OR description LIKE 'Airport slot%' OR description LIKE 'Airport expansion%') AND created_at>=NOW()-INTERVAL '7 days'`, [airlineId]);
    const weekOtherCostsRow    = await q(`SELECT COALESCE(SUM(ABS(amount)),0) as val FROM transactions WHERE airline_id=$1 AND amount<0 AND type NOT IN ('maintenance','aircraft_purchase') AND description NOT LIKE 'Flight Costs%' AND description NOT ILIKE '%cancel%' AND description NOT ILIKE '%penalty%' AND description!='Wöchentliche Personalkosten' AND description NOT LIKE 'Opened destination%' AND description NOT LIKE 'Mega Hub%' AND description NOT LIKE 'Airport slot%' AND description NOT LIKE 'Airport expansion%' AND created_at>=NOW()-INTERVAL '7 days'`, [airlineId]);

    const weekMaintenance   = Math.round(parseFloat(weekMaintenanceRow.val) || 0);
    const weekCancellations = Math.round(parseFloat(weekCancellationsRow.val) || 0);
    const weekAircraftPurch = Math.round(parseFloat(weekAircraftPurchRow.val) || 0);
    const weekPayroll       = Math.round(parseFloat(weekPayrollRow.val) || 0);
    const weekExpansion     = Math.round(parseFloat(weekExpansionRow.val) || 0);
    const weekOtherCosts    = Math.round(parseFloat(weekOtherCostsRow.val) || 0);

    // ── Fuel price ───────────────────────────────────────────────────────────
    const fuelResult = await pool.query(
      'SELECT price_per_liter FROM fuel_prices ORDER BY created_at DESC LIMIT 2'
    );
    let currentFuelPriceL = 0.64;
    let prevFuelPriceL = null;
    if (fuelResult.rows[0]) currentFuelPriceL = parseFloat(fuelResult.rows[0].price_per_liter);
    if (fuelResult.rows[1]) prevFuelPriceL = parseFloat(fuelResult.rows[1].price_per_liter);

    // ── Ops stats ────────────────────────────────────────────────────────────
    const activeAircraftRow = await q(`SELECT COUNT(*) as val FROM aircraft WHERE airline_id=$1 AND is_active=1`, [airlineId]);
    const activeRoutesRow   = await q(`SELECT COUNT(DISTINCT ws.route_id) as val FROM weekly_schedule ws JOIN aircraft a ON a.id = ws.aircraft_id WHERE a.airline_id=$1 AND a.is_active=1 AND ws.route_id IS NOT NULL`, [airlineId]);
    const destinationsRow   = await q(`SELECT COUNT(DISTINCT arrival_airport) as val FROM routes WHERE airline_id=$1`, [airlineId]);

    const activeAircraft = parseInt(activeAircraftRow.val);
    const activeRoutes   = parseInt(activeRoutesRow.val);
    const destinations   = parseInt(destinationsRow.val);

    // ── Recent transactions (last 50) ────────────────────────────────────────
    const txResult = await pool.query(
      `SELECT id, type, amount, description, created_at FROM transactions WHERE airline_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [airlineId]
    );
    const txRows = txResult.rows.map(r => ({
      id: r.id, type: r.type, amount: parseFloat(r.amount),
      description: r.description, created_at: r.created_at
    }));

    let runningBalance = balance;
    const transactions = txRows.map(tx => {
      const balAfter = Math.round(runningBalance);
      runningBalance -= tx.amount;
      return { ...tx, balance_after: balAfter };
    });

    res.json({
      balance: Math.round(balance),
      balance_prev_week: Math.round(balancePrevWeek),
      weekly: {
        revenue: Math.round(weeklyRevenue), revenue_prev: Math.round(prevWeeklyRevenue),
        costs: Math.round(weeklyCosts),     costs_prev: Math.round(prevWeeklyCosts),
        profit: Math.round(weeklyProfit),   profit_prev: Math.round(prevWeeklyProfit),
      },
      daily_history: dailyHistory,
      revenue_breakdown: {
        tickets: Math.round(ticketRevenue),
        aircraft_sales: Math.round(aircraftSalesRev),
        other: Math.round(Math.max(0, otherRevenue)),
        total: Math.round(weeklyRevenue),
      },
      cost_breakdown: {
        fuel: weekFuel,
        atc: weekAtc,
        airport_fees_catering: airportFeesCatering,
        maintenance: weekMaintenance,
        cancellations: weekCancellations,
        aircraft_purchases: weekAircraftPurch,
        payroll: weekPayroll,
        expansion: weekExpansion,
        other: weekOtherCosts,
        total: Math.round(weeklyCosts),
        fuel_price_per_liter: currentFuelPriceL,
        fuel_price_prev_liter: prevFuelPriceL,
      },
      ops_stats: {
        flights_completed: weekFlights,
        total_passengers: weekPassengers,
        avg_load_factor: weekLoadFactor,
        active_aircraft: activeAircraft,
        active_routes: activeRoutes,
        destinations,
      },
      transactions,
    });
  } catch (error) {
    console.error('Get finances dashboard error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get fuel price history (last 24 hours, public — no auth needed)
router.get('/fuel-price-history', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT price_per_liter, created_at
      FROM fuel_prices
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY created_at ASC
    `);

    const prices = result.rows.map(row => ({
      price_per_liter: parseFloat(row.price_per_liter),
      created_at: row.created_at
    }));

    // Current price = most recent entry
    const currentResult = await pool.query(
      'SELECT price_per_liter FROM fuel_prices ORDER BY created_at DESC LIMIT 1'
    );
    const currentPrice = currentResult.rows[0] ? parseFloat(currentResult.rows[0].price_per_liter) : 0.64;

    res.json({ prices, currentPrice });
  } catch (error) {
    console.error('Get fuel price history error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
