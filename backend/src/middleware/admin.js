import pool from '../database/postgres.js';

export default async function adminMiddleware(req, res, next) {
  try {
    const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
    if (!result.rows[0]?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (e) {
    console.error('Admin middleware error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
