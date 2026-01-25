import express from 'express';
import { body, validationResult } from 'express-validator';
import { getDatabase, saveDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// Get user's airline
router.get('/', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM airlines WHERE user_id = ?');
    stmt.bind([req.userId]);

    if (!stmt.step()) {
      stmt.free();
      return res.json({ airline: null });
    }

    const row = stmt.get();
    stmt.free();

    const airline = {
      id: row[0],
      user_id: row[1],
      name: row[2],
      airline_code: row[3],
      home_airport_code: row[4],
      balance: row[5],
      image_score: row[6],
      level: row[7],
      total_points: row[8],
      created_at: row[9]
    };

    res.json({ airline });
  } catch (error) {
    console.error('Get airline error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create airline
router.post('/',
  authMiddleware,
  body('name').isLength({ min: 3, max: 50 }).trim().withMessage('Airline name must be 3-50 characters'),
  body('airline_code').matches(/^[A-Z]{2,3}$/).withMessage('Airline code must be 2-3 uppercase letters'),
  body('home_airport_code').matches(/^[A-Z]{3}$/).withMessage('Invalid airport code'),
  (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, airline_code, home_airport_code } = req.body;
      const db = getDatabase();

      // Check if user already has an airline
      const checkUserStmt = db.prepare('SELECT id FROM airlines WHERE user_id = ?');
      checkUserStmt.bind([req.userId]);
      if (checkUserStmt.step()) {
        checkUserStmt.free();
        return res.status(400).json({ error: 'You already have an airline' });
      }
      checkUserStmt.free();

      // Check if airline code is taken
      const checkCodeStmt = db.prepare('SELECT id FROM airlines WHERE airline_code = ?');
      checkCodeStmt.bind([airline_code]);
      if (checkCodeStmt.step()) {
        checkCodeStmt.free();
        return res.status(400).json({ error: 'Airline code already taken' });
      }
      checkCodeStmt.free();

      // Verify airport exists
      const checkAirportStmt = db.prepare('SELECT iata_code FROM airports WHERE iata_code = ?');
      checkAirportStmt.bind([home_airport_code]);
      if (!checkAirportStmt.step()) {
        checkAirportStmt.free();
        return res.status(400).json({ error: 'Invalid airport code' });
      }
      checkAirportStmt.free();

      // Create airline
      const insertStmt = db.prepare(
        'INSERT INTO airlines (user_id, name, airline_code, home_airport_code) VALUES (?, ?, ?, ?)'
      );
      insertStmt.bind([req.userId, name, airline_code, home_airport_code]);
      insertStmt.step();
      insertStmt.free();

      // Fetch the created airline by user_id (guaranteed unique)
      const fetchStmt = db.prepare('SELECT * FROM airlines WHERE user_id = ?');
      fetchStmt.bind([req.userId]);
      fetchStmt.step();
      const row = fetchStmt.get();
      fetchStmt.free();
      saveDatabase();

      const airline = {
        id: row[0],
        user_id: row[1],
        name: row[2],
        airline_code: row[3],
        home_airport_code: row[4],
        balance: row[5],
        image_score: row[6],
        level: row[7],
        total_points: row[8],
        created_at: row[9]
      };

      res.status(201).json({
        message: 'Airline created successfully',
        airline
      });
    } catch (error) {
      console.error('Create airline error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Get all airports
router.get('/airports', (req, res) => {
  try {
    const db = getDatabase();
    const result = db.exec('SELECT iata_code, name, country FROM airports ORDER BY country, name');

    if (!result.length) {
      return res.json({ airports: [] });
    }

    const airports = result[0].values.map(row => ({
      iata_code: row[0],
      name: row[1],
      country: row[2]
    }));

    res.json({ airports });
  } catch (error) {
    console.error('Get airports error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
