import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';
import adminMiddleware from '../middleware/admin.js';

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

// Get airlines owned by a player (used for money-adjust modal)
router.get('/players/:id/airlines', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, airline_code, balance, level
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
    res.json({ id: result.rows[0].id, is_admin: result.rows[0].is_admin });
  } catch (e) {
    console.error('Toggle admin error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Adjust airline balance (positive = add, negative = subtract)
router.post('/players/:id/adjust-balance', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { airline_id, amount, note } = req.body || {};
    const amt = Number(amount);
    if (!airline_id) return res.status(400).json({ error: 'airline_id required' });
    if (!Number.isFinite(amt) || amt === 0) {
      return res.status(400).json({ error: 'amount must be a non-zero number' });
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

    const description = note && note.toString().trim()
      ? `Admin adjustment: ${note.toString().trim()}`
      : 'Admin balance adjustment';
    await pool.query(
      `INSERT INTO transactions (airline_id, type, amount, description)
       VALUES ($1, 'other', $2, $3)`,
      [airline_id, amt, description]
    );

    res.json({ id: updated.rows[0].id, balance: updated.rows[0].balance });
  } catch (e) {
    console.error('Adjust balance error:', e);
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
    res.json({ message: 'Revoked' });
  } catch (e) {
    console.error('Revoke code error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
