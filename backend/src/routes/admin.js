import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';
import adminMiddleware from '../middleware/admin.js';
import { logEvent, reqInfo } from '../utils/auditLog.js';
import { XP_THRESHOLDS, calcBaseDemandPerHour, calcPriceAttractiveness } from './flights.js';
import { calcMarketPrices } from '../utils/marketPricing.js';

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const router = express.Router();

router.use(authMiddleware);
router.use(adminMiddleware);

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCode(len = 8) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

// List all invite codes
router.get('/invite-codes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ic.id, ic.code, ic.created_at, ic.used_at, ic.revoked, ic.note,
             uc.username AS created_by_username,
             uu.username AS used_by_username
      FROM invite_codes ic
      LEFT JOIN users uc ON ic.created_by = uc.id
      LEFT JOIN users uu ON ic.used_by = uu.id
      ORDER BY ic.created_at DESC
    `);
    res.json({ codes: result.rows });
  } catch (e) {
    console.error('List codes error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Generate new invite code
router.post('/invite-codes', async (req, res) => {
  try {
    const { note } = req.body || {};
    // retry if rare collision on UNIQUE
    let attempt = 0;
    while (attempt < 5) {
      const code = generateCode(8);
      try {
        const result = await pool.query(
          `INSERT INTO invite_codes (code, created_by, note)
           VALUES ($1, $2, $3)
           RETURNING id, code, created_at, note, revoked`,
          [code, req.userId, note || null]
        );
        logEvent({ eventType: 'admin_invite_create', actorUserId: req.userId, ...reqInfo(req),
          metadata: { code_id: result.rows[0].id, has_note: !!note } });
        return res.status(201).json({ code: result.rows[0] });
      } catch (err) {
        if (err.code === '23505') { attempt++; continue; }
        throw err;
      }
    }
    res.status(500).json({ error: 'Failed to generate unique code' });
  } catch (e) {
    console.error('Create code error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── INTEREST COUNTER ────────────────────────────────────────────────────────
router.get('/interest-stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS last_7d,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last_24h
      FROM interest_clicks
    `);
    res.json(result.rows[0]);
  } catch (e) {
    console.error('Interest stats error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PLAYER MANAGEMENT ───────────────────────────────────────────────────────

// List / search players (paginated, 15 per page)
router.get('/players', async (req, res) => {
  try {
    const pageRaw = parseInt(req.query.page, 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const pageSize = 15;
    const offset = (page - 1) * pageSize;
    const search = (req.query.search || '').toString().trim();

    const whereParts = [];
    const params = [];
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      whereParts.push(`(LOWER(u.username) LIKE $${params.length} OR LOWER(u.email) LIKE $${params.length})`);
    }
    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM users u ${whereSql}`,
      params
    );
    const total = countResult.rows[0].total;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const listParams = [...params, pageSize, offset];
    const result = await pool.query(
      `SELECT u.id, u.username, u.email, u.is_admin, u.is_banned, u.created_at,
              COALESCE(a.airline_count, 0)::int AS airline_count,
              COALESCE(a.max_level, 0)::int AS max_level
       FROM users u
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS airline_count, MAX(level) AS max_level
         FROM airlines GROUP BY user_id
       ) a ON a.user_id = u.id
       ${whereSql}
       ORDER BY u.id ASC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    res.json({
      players: result.rows,
      page,
      pageSize,
      total,
      totalPages,
    });
  } catch (e) {
    console.error('List players error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get airlines owned by a player (used for the Update User modal)
router.get('/players/:id/airlines', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, airline_code, balance, level, total_points
       FROM airlines WHERE user_id = $1 ORDER BY id ASC`,
      [req.params.id]
    );
    res.json({ airlines: result.rows });
  } catch (e) {
    console.error('Get player airlines error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle ban
router.patch('/players/:id/ban', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.userId) {
      return res.status(400).json({ error: 'Cannot ban yourself' });
    }
    const result = await pool.query(
      `UPDATE users SET is_banned = NOT COALESCE(is_banned, FALSE)
       WHERE id = $1 RETURNING id, is_banned`,
      [id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Player not found' });
    logEvent({ eventType: 'admin_ban_toggle', actorUserId: req.userId, targetUserId: id,
      ...reqInfo(req), metadata: { is_banned: result.rows[0].is_banned } });
    res.json({ id: result.rows[0].id, is_banned: result.rows[0].is_banned });
  } catch (e) {
    console.error('Toggle ban error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle admin
router.patch('/players/:id/admin', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.userId) {
      return res.status(400).json({ error: 'Cannot change your own admin role' });
    }
    const result = await pool.query(
      `UPDATE users SET is_admin = NOT COALESCE(is_admin, FALSE)
       WHERE id = $1 RETURNING id, is_admin`,
      [id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Player not found' });
    logEvent({ eventType: 'admin_role_toggle', actorUserId: req.userId, targetUserId: id,
      ...reqInfo(req), metadata: { is_admin: result.rows[0].is_admin } });
    res.json({ id: result.rows[0].id, is_admin: result.rows[0].is_admin });
  } catch (e) {
    console.error('Toggle admin error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Adjust airline balance (positive = add, negative = subtract)
// Audit M1: cap to ±$10B per call to prevent fat-finger overflows, and tag
// the transaction with the acting admin's user id so the action is traceable
// in the transactions table without an external audit log.
const ADMIN_BALANCE_CAP = 10_000_000_000;

router.post('/players/:id/adjust-balance', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { airline_id, amount, note } = req.body || {};
    const amt = Number(amount);
    if (!airline_id) return res.status(400).json({ error: 'airline_id required' });
    if (!Number.isFinite(amt) || amt === 0) {
      return res.status(400).json({ error: 'amount must be a non-zero number' });
    }
    if (Math.abs(amt) > ADMIN_BALANCE_CAP) {
      return res.status(400).json({
        error: `amount exceeds cap of ±$${ADMIN_BALANCE_CAP.toLocaleString()}`,
      });
    }

    const airlineResult = await pool.query(
      'SELECT id, balance, user_id FROM airlines WHERE id = $1',
      [airline_id]
    );
    if (!airlineResult.rows[0]) return res.status(404).json({ error: 'Airline not found' });
    if (airlineResult.rows[0].user_id !== userId) {
      return res.status(400).json({ error: 'Airline does not belong to this player' });
    }

    const updated = await pool.query(
      `UPDATE airlines SET balance = balance + $1 WHERE id = $2 RETURNING id, balance`,
      [amt, airline_id]
    );

    const noteText = note && note.toString().trim();
    const description = noteText
      ? `Admin adjustment by user#${req.userId}: ${noteText}`
      : `Admin balance adjustment by user#${req.userId}`;
    await pool.query(
      `INSERT INTO transactions (airline_id, type, amount, description)
       VALUES ($1, 'other', $2, $3)`,
      [airline_id, amt, description]
    );

    logEvent({ eventType: 'admin_balance_adjust', actorUserId: req.userId, targetUserId: userId,
      ...reqInfo(req), metadata: { airline_id, amount: amt, note: noteText || null } });

    res.json({ id: updated.rows[0].id, balance: updated.rows[0].balance });
  } catch (e) {
    console.error('Adjust balance error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Adjust airline XP / total_points (positive = add, negative = subtract).
// Recomputes level afterwards so a points bump can trigger a level-up and a
// negative adjustment can demote the airline if it drops below the threshold.
const ADMIN_POINTS_CAP = 10_000_000;

router.post('/players/:id/adjust-points', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { airline_id, amount, note } = req.body || {};
    const amt = Math.trunc(Number(amount));
    if (!airline_id) return res.status(400).json({ error: 'airline_id required' });
    if (!Number.isFinite(amt) || amt === 0) {
      return res.status(400).json({ error: 'amount must be a non-zero integer' });
    }
    if (Math.abs(amt) > ADMIN_POINTS_CAP) {
      return res.status(400).json({
        error: `amount exceeds cap of ±${ADMIN_POINTS_CAP.toLocaleString()} points`,
      });
    }

    const airlineResult = await pool.query(
      'SELECT id, total_points, level, user_id FROM airlines WHERE id = $1',
      [airline_id]
    );
    if (!airlineResult.rows[0]) return res.status(404).json({ error: 'Airline not found' });
    if (airlineResult.rows[0].user_id !== userId) {
      return res.status(400).json({ error: 'Airline does not belong to this player' });
    }

    const oldLevel = Number(airlineResult.rows[0].level || 1);
    const newTotal = Math.max(0, Number(airlineResult.rows[0].total_points || 0) + amt);

    let newLevel = 1;
    while (newLevel < XP_THRESHOLDS.length && newTotal >= XP_THRESHOLDS[newLevel]) {
      newLevel++;
    }

    // If we raise the level, force acknowledged_level back to the old level so
    // the player gets the level-up celebration on next poll/login. Without
    // this, an airline whose acknowledged_level was NULL (or already equal to
    // the new level for any reason) would silently skip the popup.
    const updated = newLevel > oldLevel
      ? await pool.query(
          `UPDATE airlines SET total_points = $1, level = $2,
                  acknowledged_level = LEAST(COALESCE(acknowledged_level, $3), $3)
           WHERE id = $4
           RETURNING id, total_points, level, acknowledged_level`,
          [newTotal, newLevel, oldLevel, airline_id]
        )
      : await pool.query(
          `UPDATE airlines SET total_points = $1, level = $2 WHERE id = $3
           RETURNING id, total_points, level, acknowledged_level`,
          [newTotal, newLevel, airline_id]
        );

    const noteText = note && note.toString().trim();
    logEvent({ eventType: 'admin_points_adjust', actorUserId: req.userId, targetUserId: userId,
      ...reqInfo(req), metadata: { airline_id, amount: amt, new_total: newTotal,
        new_level: newLevel, note: noteText || null } });

    res.json({
      id: updated.rows[0].id,
      total_points: updated.rows[0].total_points,
      level: updated.rows[0].level,
    });
  } catch (e) {
    console.error('Adjust points error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── AUDIT LOG VIEWER ────────────────────────────────────────────────────────
// Paginated list of recent audit events. Read-only — no editing or deleting.
// Default page size 50, max 200. Optional ?event_type=... filter.
router.get('/audit-log', async (req, res) => {
  try {
    const pageRaw = parseInt(req.query.page, 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const sizeRaw = parseInt(req.query.page_size, 10);
    const pageSize = Math.min(200, Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : 50);
    const offset = (page - 1) * pageSize;
    const eventType = (req.query.event_type || '').toString().trim();

    const whereParts = [];
    const params = [];
    if (eventType) {
      params.push(eventType);
      whereParts.push(`event_type = $${params.length}`);
    }
    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM audit_log ${whereSql}`,
      params
    );
    const total = countResult.rows[0].total;

    const listParams = [...params, pageSize, offset];
    const result = await pool.query(
      `SELECT al.id, al.created_at, al.event_type,
              al.actor_user_id,  ua.username AS actor_username,
              al.target_user_id, ut.username AS target_username,
              al.ip, al.user_agent, al.metadata
       FROM audit_log al
       LEFT JOIN users ua ON al.actor_user_id  = ua.id
       LEFT JOIN users ut ON al.target_user_id = ut.id
       ${whereSql}
       ORDER BY al.id DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    res.json({
      events: result.rows,
      page, pageSize, total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (e) {
    console.error('List audit log error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Revoke an unused code
router.delete('/invite-codes/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT used_by, revoked FROM invite_codes WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    if (result.rows[0].used_by) return res.status(400).json({ error: 'Code already used — cannot revoke' });
    if (result.rows[0].revoked) return res.status(400).json({ error: 'Already revoked' });
    await pool.query('UPDATE invite_codes SET revoked = TRUE WHERE id = $1', [req.params.id]);
    logEvent({ eventType: 'admin_invite_revoke', actorUserId: req.userId, ...reqInfo(req),
      metadata: { code_id: parseInt(req.params.id, 10) } });
    res.json({ message: 'Revoked' });
  } catch (e) {
    console.error('Revoke code error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: market price reference for an airport pair. Returns the fair-market
// eco/biz/first prices plus the distance. Players never see this — game design
// keeps the model hidden — but admins use it to set test-routes intentionally
// near the 119% ceiling.
//
// Optional `eco_cap`/`biz_cap`/`fir_cap` query params enable capacity-aware
// suggestions: the highest price (in $10 steps, ratio ≤ 1.19) at which the
// 72h expected pax still fills ~95% of that class's seats. Returned alongside
// `market` as `suggested`. If even ratio 0.80 can't fill the cabin, 0.80 is
// returned anyway — flags the route/aircraft pairing as undersized demand.
const RATIO_LADDER = [1.19, 1.14, 1.09, 1.05, 1.00, 0.90, 0.80];
const TARGET_LF = 0.95;
const CLASS_SHARE = { eco: 1.00, biz: 0.15, fir: 0.05 };

function suggestedForClass(market, cap, depCat, arrCat, share) {
  if (!market || market <= 0 || !cap || cap <= 0) return null;
  const baseDemand = calcBaseDemandPerHour(depCat, arrCat);
  const target = cap * TARGET_LF;
  for (const ratio of RATIO_LADDER) {
    const attr = calcPriceAttractiveness(market * ratio, market);
    const expectedPax = baseDemand * share * attr * 72;
    if (expectedPax >= target) return Math.floor((market * ratio) / 10) * 10;
  }
  return Math.floor((market * RATIO_LADDER[RATIO_LADDER.length - 1]) / 10) * 10;
}

router.get('/market-price', async (req, res) => {
  try {
    const dep = String(req.query.dep || '').toUpperCase();
    const arr = String(req.query.arr || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(dep) || !/^[A-Z]{3}$/.test(arr) || dep === arr) {
      return res.status(400).json({ error: 'dep and arr must be distinct 3-letter IATA codes' });
    }
    const result = await pool.query(
      'SELECT iata_code, latitude, longitude, category FROM airports WHERE iata_code = ANY($1)',
      [[dep, arr]]
    );
    const byCode = Object.fromEntries(result.rows.map(r => [r.iata_code, r]));
    const d = byCode[dep], a = byCode[arr];
    if (!d || !a) return res.status(404).json({ error: 'Airport not found' });
    if (d.latitude == null || a.latitude == null) {
      return res.status(400).json({ error: 'Airport coordinates missing' });
    }
    const distKm = Math.round(haversineKm(d.latitude, d.longitude, a.latitude, a.longitude));
    const prices = calcMarketPrices(distKm, d.category, a.category);

    const ecoCap = parseInt(req.query.eco_cap, 10) || 0;
    const bizCap = parseInt(req.query.biz_cap, 10) || 0;
    const firCap = parseInt(req.query.fir_cap, 10) || 0;
    const hasCaps = ecoCap > 0 || bizCap > 0 || firCap > 0;
    const suggested = hasCaps ? {
      eco:   suggestedForClass(prices.eco,   ecoCap, d.category, a.category, CLASS_SHARE.eco),
      biz:   suggestedForClass(prices.biz,   bizCap, d.category, a.category, CLASS_SHARE.biz),
      first: suggestedForClass(prices.first, firCap, d.category, a.category, CLASS_SHARE.fir),
    } : null;

    res.json({ dep, arr, distance_km: distKm, market: prices, suggested });
  } catch (e) {
    console.error('Market price error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
