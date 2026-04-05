import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// Cost tiers by distance
function getCost(distKm) {
  if (distKm < 1000) return 100000;
  if (distKm <= 3000) return 450000;
  return 1000000;
}

// Rating based on ratio actual/market — aligned with attractiveness curve
function getRating(actual, market) {
  if (!actual || !market) return null;
  const ratio = actual / market;
  if (ratio < 0.80) return 'UNDERPRICED';
  if (ratio < 1.00) return 'SLIGHTLY_LOW';
  if (ratio <= 1.10) return 'COMPETITIVE';
  if (ratio <= 1.20) return 'SLIGHTLY_HIGH';
  if (ratio <= 1.40) return 'OVERPRICED';
  return 'STRONGLY_OVERPRICED';
}

// Market price formula (mirrors flights.js calcMarketPrices)
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

// Get current week start (Monday 00:00 UTC as ISO date string YYYY-MM-DD)
function getWeekStart() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon...
  const diff = (day === 0 ? -6 : 1 - day);
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10);
}

// Get or create analysis_limits row; resets if week changed
async function getLimitsRow(airlineId) {
  const weekStart = getWeekStart();
  const result = await pool.query(
    'SELECT week_start, analyses_this_week FROM analysis_limits WHERE airline_id = $1',
    [airlineId]
  );
  if (result.rows[0]) {
    const row = result.rows[0];
    if (row.week_start !== weekStart) {
      // New week — reset counter
      await pool.query(
        'UPDATE analysis_limits SET week_start = $1, analyses_this_week = 0 WHERE airline_id = $2',
        [weekStart, airlineId]
      );
      return { week_start: weekStart, analyses_this_week: 0 };
    }
    return { week_start: row.week_start, analyses_this_week: row.analyses_this_week };
  }
  // Insert new row
  await pool.query(
    'INSERT INTO analysis_limits (airline_id, week_start, analyses_this_week) VALUES ($1, $2, 0)',
    [airlineId, weekStart]
  );
  return { week_start: weekStart, analyses_this_week: 0 };
}

// POST /api/market-analyses/request
router.post('/request', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
    const { route_id } = req.body;
    if (!route_id) return res.status(400).json({ error: 'route_id required' });

    // Verify route belongs to airline
    const routeResult = await pool.query(
      'SELECT id, distance_km, economy_price, business_price, first_price FROM routes WHERE id = $1 AND airline_id = $2',
      [route_id, req.airlineId]
    );
    if (!routeResult.rows[0]) {
      return res.status(404).json({ error: 'Route not found' });
    }
    const routeRow = routeResult.rows[0];
    const distKm = routeRow.distance_km;
    const ecoPrice = routeRow.economy_price;
    const bizPrice = routeRow.business_price;
    const firstPrice = routeRow.first_price;

    // No duplicate pending analysis
    const dupResult = await pool.query(
      "SELECT id FROM market_analyses WHERE airline_id = $1 AND route_id = $2 AND status = 'pending'",
      [req.airlineId, route_id]
    );
    if (dupResult.rows[0]) return res.status(400).json({ error: 'A pending analysis already exists for this route' });

    // Weekly limit
    const limits = await getLimitsRow(req.airlineId);
    if (limits.analyses_this_week >= 4) return res.status(400).json({ error: 'Weekly analysis limit reached (4/week)' });

    const cost = getCost(distKm);

    // Balance check
    const balResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const balance = balResult.rows[0].balance;
    if (balance < cost) return res.status(400).json({ error: 'Insufficient balance' });

    // Get airport categories for fallback formula
    const routeAptResult = await pool.query(
      `SELECT a.iata_code, a.category, r.departure_airport, r.arrival_airport
       FROM routes r
       JOIN airports a ON a.iata_code IN (r.departure_airport, r.arrival_airport)
       WHERE r.id = $1`,
      [route_id]
    );
    let depCat = 4, arrCat = 4;
    if (routeAptResult.rows.length > 0) {
      const depCode = routeAptResult.rows[0].departure_airport;
      for (const r of routeAptResult.rows) {
        if (r.iata_code === depCode) depCat = r.category || 4;
        else arrCat = r.category || 4;
      }
    }
    const formulaPrices = calcMarketPrices(distKm, depCat, arrCat);

    const ecoMarket   = formulaPrices.eco;
    const bizMarket   = formulaPrices.biz;
    const firstMarket = formulaPrices.first;

    // completed_at = now + 1 minute (testing)
    const completedAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

    // Insert analysis with RETURNING id
    const insResult = await pool.query(`
      INSERT INTO market_analyses
        (airline_id, route_id, status, completed_at, cost,
         economy_price, business_price, first_price,
         economy_market_price, business_market_price, first_market_price)
      VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `, [
      req.airlineId, route_id, completedAt, cost,
      ecoPrice, bizPrice, firstPrice,
      ecoMarket, bizMarket, firstMarket
    ]);
    const analysisId = insResult.rows[0].id;

    // Deduct cost
    await pool.query('UPDATE airlines SET balance = balance - $1 WHERE id = $2', [cost, req.airlineId]);

    // Record transaction
    await pool.query(
      "INSERT INTO transactions (airline_id, type, amount, description) VALUES ($1, 'other', $2, $3)",
      [req.airlineId, -cost, 'Market Analysis']
    );

    // Increment weekly counter
    await pool.query(
      'UPDATE analysis_limits SET analyses_this_week = analyses_this_week + 1 WHERE airline_id = $1',
      [req.airlineId]
    );

    // Return new balance
    const newBalResult = await pool.query('SELECT balance FROM airlines WHERE id = $1', [req.airlineId]);
    const newBalance = newBalResult.rows[0].balance;

    res.json({ analysis_id: analysisId, completed_at: completedAt, cost, new_balance: newBalance });
  } catch (e) {
    console.error('Market analysis request error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/market-analyses
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (!req.airlineId) return res.json({ analyses: [], week_used: 0, week_limit: 4, week_start: getWeekStart() });

    // Process any due analyses before returning results
    await processMarketAnalyses();

    const result = await pool.query(`
      SELECT ma.id, ma.route_id, ma.status, ma.requested_at, ma.completed_at, ma.cost,
             ma.economy_price, ma.business_price, ma.first_price,
             ma.economy_rating, ma.business_rating, ma.first_rating,
             r.departure_airport, r.arrival_airport, r.distance_km, r.flight_number
      FROM market_analyses ma
      JOIN routes r ON ma.route_id = r.id
      WHERE ma.airline_id = $1
      ORDER BY ma.requested_at DESC
      LIMIT 8
    `, [req.airlineId]);

    // Delete any older analyses beyond the 8 most recent
    await pool.query(`
      DELETE FROM market_analyses
      WHERE airline_id = $1
        AND id NOT IN (
          SELECT id FROM market_analyses WHERE airline_id = $1
          ORDER BY requested_at DESC LIMIT 8
        )
    `, [req.airlineId]);

    const analyses = result.rows.map(row => ({
      id: row.id, route_id: row.route_id, status: row.status,
      requested_at: row.requested_at, completed_at: row.completed_at, cost: row.cost,
      economy_price: row.economy_price, business_price: row.business_price,
      first_price: row.first_price, economy_rating: row.economy_rating,
      business_rating: row.business_rating, first_rating: row.first_rating,
      departure_airport: row.departure_airport, arrival_airport: row.arrival_airport,
      distance_km: row.distance_km, flight_number: row.flight_number,
    }));

    const limits = await getLimitsRow(req.airlineId);

    res.json({ analyses, week_used: limits.analyses_this_week, week_limit: 4, week_start: limits.week_start });
  } catch (e) {
    console.error('Market analysis get error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start background processor — runs every 5 minutes
export function startMarketAnalysesProcessor() {
  setInterval(async () => {
    try {
      await processMarketAnalyses();
    } catch (e) {
      console.error('[MarketAnalysis] Processor tick error:', e);
    }
  }, 5 * 60 * 1000);
}

// Background job: complete pending analyses
export async function processMarketAnalyses() {
  try {
    const now = new Date().toISOString();
    const pendingResult = await pool.query(
      "SELECT id, economy_price, business_price, first_price, economy_market_price, business_market_price, first_market_price FROM market_analyses WHERE status = 'pending' AND completed_at <= $1",
      [now]
    );

    if (pendingResult.rows.length === 0) return;

    for (const r of pendingResult.rows) {
      const ecoRating = getRating(r.economy_price, r.economy_market_price);
      const bizRating = getRating(r.business_price, r.business_market_price);
      const firRating = getRating(r.first_price, r.first_market_price);
      await pool.query(
        "UPDATE market_analyses SET status = 'completed', economy_rating = $1, business_rating = $2, first_rating = $3 WHERE id = $4",
        [ecoRating, bizRating, firRating, r.id]
      );
    }

    console.log(`[MarketAnalysis] Completed ${pendingResult.rows.length} analysis(es)`);
  } catch (e) {
    console.error('[MarketAnalysis] Background job error:', e);
  }
}

export default router;
