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

    // Inject active airline context so route handlers don't need to look it up
    try {
      const userResult = await pool.query(
        'SELECT active_airline_id FROM users WHERE id = $1',
        [req.userId]
      );
      const activeAirlineId = userResult.rows[0]?.active_airline_id;
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
      // DB error in middleware — still allow request through (auth succeeded)
    }

    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

export default authMiddleware;
