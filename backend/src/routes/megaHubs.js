import express from 'express';
import { getDatabase, saveDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

const MAX_MEGA_HUBS = 5;
const HUB_BASE_COSTS = [2_000_000, 2_500_000, 3_000_000, 3_500_000, 4_000_000];
const DEPARTURES_PER_SLOT = 100;

export function calculateHubCost(hubNumber, category) {
  return category * HUB_BASE_COSTS[hubNumber - 1];
}

// GET /api/mega-hubs
router.get('/', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.json({ mega_hubs: [], home_base: null, next_hub_number: 1, max_hubs: MAX_MEGA_HUBS });
  try {
    const db = getDatabase();

    // Home base info
    const homeStmt = db.prepare(`
      SELECT a.home_airport_code, ap.name, ap.category
      FROM airlines a LEFT JOIN airports ap ON ap.iata_code = a.home_airport_code
      WHERE a.id = ?
    `);
    homeStmt.bind([req.airlineId]);
    let homeBase = null;
    if (homeStmt.step()) {
      const r = homeStmt.get();
      homeBase = { airport_code: r[0], airport_name: r[1], category: r[2] };
    }
    homeStmt.free();

    // Purchased mega hubs
    const stmt = db.prepare(`
      SELECT mh.id, mh.airport_code, ap.name, mh.hub_number, mh.category, mh.cost, mh.purchased_at
      FROM mega_hubs mh LEFT JOIN airports ap ON ap.iata_code = mh.airport_code
      WHERE mh.airline_id = ?
      ORDER BY mh.hub_number
    `);
    stmt.bind([req.airlineId]);
    const mega_hubs = [];
    while (stmt.step()) {
      const r = stmt.get();
      mega_hubs.push({
        id: r[0], airport_code: r[1], airport_name: r[2],
        hub_number: r[3], category: r[4], cost: r[5], purchased_at: r[6],
      });
    }
    stmt.free();

    const nextHubNumber = mega_hubs.length + 1;
    // Cost preview for purchasable airports (home base category as fallback)
    res.json({ mega_hubs, home_base: homeBase, next_hub_number: nextHubNumber, max_hubs: MAX_MEGA_HUBS });
  } catch (error) {
    console.error('Get mega hubs error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/mega-hubs/purchase
router.post('/purchase', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const { airport_code } = req.body;
    if (!airport_code) return res.status(400).json({ error: 'airport_code required' });
    const code = airport_code.toUpperCase();
    const db = getDatabase();

    // Not home base
    const homeStmt = db.prepare('SELECT home_airport_code FROM airlines WHERE id = ?');
    homeStmt.bind([req.airlineId]);
    homeStmt.step();
    const homeCode = homeStmt.get()[0];
    homeStmt.free();
    if (homeCode === code) return res.status(400).json({ error: 'Home Base already has Hub privileges.' });

    // Not already a mega hub
    const existStmt = db.prepare('SELECT id FROM mega_hubs WHERE airline_id = ? AND airport_code = ?');
    existStmt.bind([req.airlineId, code]);
    if (existStmt.step()) { existStmt.free(); return res.status(400).json({ error: 'Already a Mega Hub.' }); }
    existStmt.free();

    // Destination must be opened
    const destStmt = db.prepare('SELECT id FROM airline_destinations WHERE airline_id = ? AND airport_code = ?');
    destStmt.bind([req.airlineId, code]);
    if (!destStmt.step()) { destStmt.free(); return res.status(400).json({ error: 'Open this destination first.' }); }
    destStmt.free();

    // Count existing mega hubs
    const countStmt = db.prepare('SELECT COUNT(*) FROM mega_hubs WHERE airline_id = ?');
    countStmt.bind([req.airlineId]);
    countStmt.step();
    const currentCount = countStmt.get()[0];
    countStmt.free();
    if (currentCount >= MAX_MEGA_HUBS) return res.status(400).json({ error: `Maximum ${MAX_MEGA_HUBS} Mega Hubs allowed.` });

    const hubNumber = currentCount + 1;

    // Airport category
    const apStmt = db.prepare('SELECT category FROM airports WHERE iata_code = ?');
    apStmt.bind([code]);
    if (!apStmt.step()) { apStmt.free(); return res.status(404).json({ error: 'Airport not found.' }); }
    const category = apStmt.get()[0] || 4;
    apStmt.free();

    const cost = calculateHubCost(hubNumber, category);

    // Balance check
    const balStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    balStmt.bind([req.airlineId]);
    balStmt.step();
    const balance = balStmt.get()[0];
    balStmt.free();
    if (balance < cost) return res.status(400).json({ error: `Insufficient balance. This Mega Hub costs $${cost.toLocaleString()}.` });

    // Deduct
    const deduct = db.prepare('UPDATE airlines SET balance = balance - ? WHERE id = ?');
    deduct.bind([cost, req.airlineId]);
    deduct.step(); deduct.free();

    // Transaction
    const tx = db.prepare("INSERT INTO transactions (airline_id, type, amount, description) VALUES (?, 'other', ?, ?)");
    tx.bind([req.airlineId, -cost, `Mega Hub #${hubNumber} purchased: ${code}`]);
    tx.step(); tx.free();

    // Insert
    const ins = db.prepare('INSERT INTO mega_hubs (airline_id, airport_code, hub_number, category, cost) VALUES (?, ?, ?, ?, ?)');
    ins.bind([req.airlineId, code, hubNumber, category, cost]);
    ins.step(); ins.free();

    // New balance
    const newBalStmt = db.prepare('SELECT balance FROM airlines WHERE id = ?');
    newBalStmt.bind([req.airlineId]);
    newBalStmt.step();
    const newBalance = newBalStmt.get()[0];
    newBalStmt.free();

    saveDatabase();
    res.json({ message: `${code} is now Mega Hub #${hubNumber}`, new_balance: newBalance });
  } catch (error) {
    console.error('Purchase mega hub error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/mega-hubs/cost-preview?airport_code=XXX
// Returns cost for the next hub purchase at a given airport
router.get('/cost-preview', authMiddleware, (req, res) => {
  if (!req.airlineId) return res.status(400).json({ error: 'No active airline' });
  try {
    const code = (req.query.airport_code || '').toUpperCase();
    if (!code) return res.status(400).json({ error: 'airport_code required' });
    const db = getDatabase();

    const apStmt = db.prepare('SELECT category FROM airports WHERE iata_code = ?');
    apStmt.bind([code]);
    if (!apStmt.step()) { apStmt.free(); return res.status(404).json({ error: 'Airport not found.' }); }
    const category = apStmt.get()[0] || 4;
    apStmt.free();

    const countStmt = db.prepare('SELECT COUNT(*) FROM mega_hubs WHERE airline_id = ?');
    countStmt.bind([req.airlineId]);
    countStmt.step();
    const currentCount = countStmt.get()[0];
    countStmt.free();

    const hubNumber = currentCount + 1;
    if (hubNumber > MAX_MEGA_HUBS) return res.json({ hub_number: hubNumber, cost: null, max_reached: true });

    const cost = calculateHubCost(hubNumber, category);
    res.json({ hub_number: hubNumber, category, cost, max_reached: false });
  } catch (error) {
    console.error('Hub cost preview error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
