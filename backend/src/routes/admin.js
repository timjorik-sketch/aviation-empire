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
