import express from 'express';
import { getDatabase, saveDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// Cost tiers by distance
function getCost(distKm) {
  if (distKm < 3000) return 20000;
  if (distKm <= 7000) return 80000;
  return 180000;
}

// Rating based on ratio actual/market
function getRating(actual, market) {
  if (!actual || !market) return null;
  const ratio = actual / market;
  if (ratio < 0.7) return 'UNDERPRICED';
  if (ratio < 0.9) return 'SLIGHTLY_LOW';
  if (ratio <= 1.15) return 'COMPETITIVE';
  if (ratio <= 1.35) return 'SLIGHTLY_HIGH';
  return 'OVERPRICED';
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
function getLimitsRow(db, airlineId) {
  const weekStart = getWeekStart();
  const stmt = db.prepare('SELECT week_start, analyses_this_week FROM analysis_limits WHERE airline_id = ?');
  stmt.bind([airlineId]);
  if (stmt.step()) {
    const row = stmt.get();
    stmt.free();
    if (row[0] !== weekStart) {
      // New week — reset counter
      const upd = db.prepare('UPDATE analysis_limits SET week_start = ?, analyses_this_week = 0 WHERE airline_id = ?');
      upd.bind([weekStart, airlineId]);
      upd.step();
      upd.free();
      return { week_start: weekStart, analyses_this_week: 0 };
    }
    return { week_start: row[0], analyses_this_week: row[1] };
  }
  stmt.free();
  // Insert new row
  const ins = db.prepare('INSERT INTO analysis_limits (airline_id, week_start, analyses_this_week) VALUES (?, ?, 0)');
  ins.bind([airlineId, weekStart]);
  ins.step();
  ins.free();
  return { week_start: weekStart, analyses_this_week: 0 };
}

// POST /api/market-analyses/request
router.post('/request', authMiddleware, (req, res) => {
  try {
    if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
    const { route_id } = req.body;
    if (!route_id) return res.status(400).json({ error: 'route_id required' });

    const db = getDatabase();

    // Verify route belongs to airline
    const routeStmt = db.prepare('SELECT id, distance_km, economy_price, business_price, first_price FROM routes WHERE id = ? AND airline_id = ?');
    routeStmt.bind([route_id, req.airlineId]);
    if (!routeStmt.step()) {
      routeStmt.free();
      return res.status(404).json({ error: 'Route not found' });
    }
    const routeRow = routeStmt.get();
    routeStmt.free();
    const distKm = routeRow[1];
    const ecoPrice = routeRow[2];
    const bizPrice = routeRow[3];
    const firstPrice = routeRow[4];

    // Route must have scheduled flights
    const schedStmt = db.prepare('SELECT COUNT(*) FROM weekly_schedule ws JOIN aircraft a ON ws.aircraft_id = a.id WHERE ws.route_id = ? AND a.airline_id = ?');
    schedStmt.bind([route_id, req.airlineId]);
    schedStmt.step();
    const schedCount = schedStmt.get()[0];
    schedStmt.free();
    if (schedCount === 0) return res.status(400).json({ error: 'Route has no scheduled flights' });

    // No duplicate pending analysis
    const dupStmt = db.prepare("SELECT id FROM market_analyses WHERE airline_id = ? AND route_id = ? AND status = 'pending'");
    dupStmt.bind([req.airlineId, route_id]);
    const hasDup = dupStmt.step();
    dupStmt.free();
    if (hasDup) return res.status(400).json({ error: 'A pending analysis already exists for this route' });

    // Weekly limit
    const limits = getLimitsRow(db, req.airlineId);
    if (limits.analyses_this_week >= 4) return res.status(400).json({ error: 'Weekly analysis limit reached (4/week)' });

    const cost = getCost(distKm);

    // Balance check
    const balStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    balStmt.bind([req.airlineId]);
    balStmt.step();
    const balance = balStmt.get()[0];
    balStmt.free();
    if (balance < cost) return res.status(400).json({ error: 'Insufficient balance' });

    // Calculate market price: use average of recent completed flights on this route
    // Market price = average market_price_economy/business/first from completed flights on route, last 30 days
    // Falls back to a distance-based formula if no flights
    function getMarketPrice(cabin) {
      const col = `market_price_${cabin}`;
      const mpStmt = db.prepare(`SELECT AVG(f.${col}) FROM flights f WHERE f.route_id = ? AND f.status = 'completed' AND f.${col} > 0 AND f.departure_time > datetime('now', '-30 days')`);
      mpStmt.bind([route_id]);
      mpStmt.step();
      const avg = mpStmt.get()[0];
      mpStmt.free();
      if (avg && avg > 0) return Math.round(avg);
      // Fallback: distance-based formula
      const base = { economy: 0.08, business: 0.20, first: 0.38 };
      return Math.round(distKm * (base[cabin] || 0.08));
    }

    const ecoMarket   = getMarketPrice('economy');
    const bizMarket   = getMarketPrice('business');
    const firstMarket = getMarketPrice('first');

    // completed_at = now + 12 hours
    const completedAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

    // Insert analysis
    const insStmt = db.prepare(`
      INSERT INTO market_analyses
        (airline_id, route_id, status, completed_at, cost,
         economy_price, business_price, first_price,
         economy_market_price, business_market_price, first_market_price)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insStmt.bind([
      req.airlineId, route_id, completedAt, cost,
      ecoPrice, bizPrice, firstPrice,
      ecoMarket, bizMarket, firstMarket
    ]);
    insStmt.step();
    insStmt.free();

    // Get new analysis id
    const idStmt = db.prepare('SELECT id FROM market_analyses WHERE airline_id = ? AND route_id = ? ORDER BY id DESC LIMIT 1');
    idStmt.bind([req.airlineId, route_id]);
    idStmt.step();
    const analysisId = idStmt.get()[0];
    idStmt.free();

    // Deduct cost
    const deductStmt = db.prepare('UPDATE airlines SET balance = balance - ? WHERE id = ?');
    deductStmt.bind([cost, req.airlineId]);
    deductStmt.step();
    deductStmt.free();

    // Record transaction
    const txStmt = db.prepare("INSERT INTO transactions (airline_id, amount, description) VALUES (?, ?, ?)");
    txStmt.bind([req.airlineId, -cost, 'Market Analysis']);
    txStmt.step();
    txStmt.free();

    // Increment weekly counter
    const updLimit = db.prepare('UPDATE analysis_limits SET analyses_this_week = analyses_this_week + 1 WHERE airline_id = ?');
    updLimit.bind([req.airlineId]);
    updLimit.step();
    updLimit.free();

    saveDatabase();

    // Return new balance
    const newBalStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    newBalStmt.bind([req.airlineId]);
    newBalStmt.step();
    const newBalance = newBalStmt.get()[0];
    newBalStmt.free();

    res.json({ analysis_id: analysisId, completed_at: completedAt, cost, new_balance: newBalance });
  } catch (e) {
    console.error('Market analysis request error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/market-analyses
router.get('/', authMiddleware, (req, res) => {
  try {
    if (!req.airlineId) return res.json({ analyses: [], week_used: 0, week_limit: 4, week_start: getWeekStart() });
    const db = getDatabase();

    const stmt = db.prepare(`
      SELECT ma.id, ma.route_id, ma.status, ma.requested_at, ma.completed_at, ma.cost,
             ma.economy_price, ma.business_price, ma.first_price,
             ma.economy_rating, ma.business_rating, ma.first_rating,
             r.departure_airport, r.arrival_airport, r.distance_km, r.flight_number
      FROM market_analyses ma
      JOIN routes r ON ma.route_id = r.id
      WHERE ma.airline_id = ?
      ORDER BY ma.requested_at DESC
    `);
    stmt.bind([req.airlineId]);
    const analyses = [];
    while (stmt.step()) {
      const row = stmt.get();
      analyses.push({
        id: row[0], route_id: row[1], status: row[2],
        requested_at: row[3], completed_at: row[4], cost: row[5],
        economy_price: row[6], business_price: row[7], first_price: row[8],
        economy_rating: row[9], business_rating: row[10], first_rating: row[11],
        departure_airport: row[12], arrival_airport: row[13],
        distance_km: row[14], flight_number: row[15],
      });
    }
    stmt.free();

    const limits = getLimitsRow(db, req.airlineId);

    res.json({ analyses, week_used: limits.analyses_this_week, week_limit: 4, week_start: limits.week_start });
  } catch (e) {
    console.error('Market analysis get error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start background processor — runs every 5 minutes
export function startMarketAnalysesProcessor() {
  setInterval(() => {
    try {
      const db = getDatabase();
      if (!db) return;
      processMarketAnalyses(db);
      saveDatabase();
    } catch (e) {
      console.error('[MarketAnalysis] Processor tick error:', e);
    }
  }, 5 * 60 * 1000);
}

// Background job: complete pending analyses
export function processMarketAnalyses(db) {
  try {
    const now = new Date().toISOString();
    const pendingStmt = db.prepare("SELECT id, economy_price, business_price, first_price, economy_market_price, business_market_price, first_market_price FROM market_analyses WHERE status = 'pending' AND completed_at <= ?");
    pendingStmt.bind([now]);
    const pending = [];
    while (pendingStmt.step()) {
      const r = pendingStmt.get();
      pending.push({ id: r[0], eco: r[1], biz: r[2], fir: r[3], ecoMkt: r[4], bizMkt: r[5], firMkt: r[6] });
    }
    pendingStmt.free();

    if (pending.length === 0) return;

    const updStmt = db.prepare("UPDATE market_analyses SET status = 'completed', economy_rating = ?, business_rating = ?, first_rating = ? WHERE id = ?");
    for (const p of pending) {
      const ecoRating = getRating(p.eco, p.ecoMkt);
      const bizRating = getRating(p.biz, p.bizMkt);
      const firRating = getRating(p.fir, p.firMkt);
      updStmt.bind([ecoRating, bizRating, firRating, p.id]);
      updStmt.step();
      updStmt.reset();
    }
    updStmt.free();

    console.log(`[MarketAnalysis] Completed ${pending.length} analysis(es)`);
  } catch (e) {
    console.error('[MarketAnalysis] Background job error:', e);
  }
}

export default router;
