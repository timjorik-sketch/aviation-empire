import jwt from 'jsonwebtoken';
import { getDatabase } from '../database/db.js';

export const authMiddleware = (req, res, next) => {
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
    const db = getDatabase();
    if (db) {
      const userStmt = db.prepare('SELECT active_airline_id FROM users WHERE id = ?');
      userStmt.bind([req.userId]);
      if (userStmt.step()) {
        const activeAirlineId = userStmt.get()[0];
        userStmt.free();
        if (activeAirlineId) {
          const airlineStmt = db.prepare(
            'SELECT id, airline_code, level FROM airlines WHERE id = ? AND user_id = ?'
          );
          airlineStmt.bind([activeAirlineId, req.userId]);
          if (airlineStmt.step()) {
            const row = airlineStmt.get();
            req.airlineId = row[0];
            req.airlineCode = row[1];
            req.airlineLevel = row[2];
          }
          airlineStmt.free();
        }
      } else {
        userStmt.free();
      }
    }

    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

export default authMiddleware;
