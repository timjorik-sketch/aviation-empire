import express from 'express';
import crypto from 'crypto';
import pool from '../database/postgres.js';

const router = express.Router();

function hashIp(ip) {
  const salt = process.env.INTEREST_HASH_SALT || 'apron-empire';
  return crypto.createHash('sha256').update(`${salt}:${ip || 'unknown'}`).digest('hex');
}

// Public: register interest. Dedup per IP within 24h.
router.post('/', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim()
      || req.ip
      || 'unknown';
    const ipHash = hashIp(ip);
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 300);

    const recent = await pool.query(
      `SELECT id FROM interest_clicks
       WHERE ip_hash = $1 AND created_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [ipHash]
    );

    if (!recent.rows[0]) {
      await pool.query(
        `INSERT INTO interest_clicks (ip_hash, user_agent) VALUES ($1, $2)`,
        [ipHash, ua]
      );
    }

    const countResult = await pool.query('SELECT COUNT(*)::int AS total FROM interest_clicks');
    res.json({
      total: countResult.rows[0].total,
      alreadyCounted: !!recent.rows[0],
    });
  } catch (e) {
    console.error('Interest click error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Public: current count (used to display on the landing)
router.get('/count', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*)::int AS total FROM interest_clicks');
    res.json({ total: result.rows[0].total });
  } catch (e) {
    console.error('Interest count error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
