import jwt from 'jsonwebtoken';
import pool from '../database/postgres.js';

export const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    req.username = decoded.username;

    // Inject active airline context so route handlers don't need to look it up.
    // Also enforce is_banned per-request (audit M6): without this, banned users
    // keep API access for the lifetime of any JWT issued before the ban.
    try {
      const userResult = await pool.query(
        'SELECT active_airline_id, is_banned FROM users WHERE id = $1',
        [req.userId]
      );
      const userRow = userResult.rows[0];
      if (userRow?.is_banned) {
        return res.status(403).json({ error: 'Account suspended' });
      }
      const activeAirlineId = userRow?.active_airline_id;
      if (activeAirlineId) {
        const airlineResult = await pool.query(
          'SELECT id, airline_code, level FROM airlines WHERE id = $1 AND user_id = $2',
          [activeAirlineId, req.userId]
        );
        if (airlineResult.rows[0]) {
          const row = airlineResult.rows[0];
          req.airlineId = row.id;
          req.airlineCode = row.airline_code;
          req.airlineLevel = row.level;
        }
      }
    } catch (e) {
      // DB error in middleware — still allow request through (auth succeeded).
      // Note: this fail-open path means a DB outage briefly bypasses the ban
      // check. Acceptable trade-off vs. taking the whole API down.
    }

    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

export default authMiddleware;
