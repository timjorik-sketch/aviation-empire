import express from 'express';
import { body, validationResult } from 'express-validator';
import { getDatabase, saveDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// Get all aircraft types available for purchase
router.get('/types', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();

    // Get user's airline to check level
    const airlineStmt = db.prepare('SELECT level FROM airlines WHERE user_id = ?');
    airlineStmt.bind([req.userId]);

    if (!airlineStmt.step()) {
      airlineStmt.free();
      return res.status(400).json({ error: 'No airline found' });
    }

    const airlineLevel = airlineStmt.get()[0];
    airlineStmt.free();

    const result = db.exec('SELECT * FROM aircraft_types ORDER BY required_level, new_price');

    if (!result.length) {
      return res.json({ aircraft_types: [], airline_level: airlineLevel });
    }

    const aircraftTypes = result[0].values.map(row => ({
      id: row[0],
      manufacturer: row[1],
      model: row[2],
      full_name: row[3],
      max_seats: row[4],
      range_km: row[5],
      new_price: row[6],
      required_level: row[7],
      can_purchase: airlineLevel >= row[7]
    }));

    res.json({ aircraft_types: aircraftTypes, airline_level: airlineLevel });
  } catch (error) {
    console.error('Get aircraft types error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's fleet
router.get('/fleet', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();

    // Get airline ID
    const airlineStmt = db.prepare('SELECT id FROM airlines WHERE user_id = ?');
    airlineStmt.bind([req.userId]);

    if (!airlineStmt.step()) {
      airlineStmt.free();
      return res.status(400).json({ error: 'No airline found' });
    }

    const airlineId = airlineStmt.get()[0];
    airlineStmt.free();

    // Get fleet with aircraft type details
    const fleetStmt = db.prepare(`
      SELECT a.id, a.registration, a.name, a.purchased_at,
             t.manufacturer, t.model, t.full_name, t.max_seats, t.range_km
      FROM aircraft a
      JOIN aircraft_types t ON a.aircraft_type_id = t.id
      WHERE a.airline_id = ?
      ORDER BY a.purchased_at DESC
    `);
    fleetStmt.bind([airlineId]);

    const fleet = [];
    while (fleetStmt.step()) {
      const row = fleetStmt.get();
      fleet.push({
        id: row[0],
        registration: row[1],
        name: row[2],
        purchased_at: row[3],
        manufacturer: row[4],
        model: row[5],
        full_name: row[6],
        max_seats: row[7],
        range_km: row[8]
      });
    }
    fleetStmt.free();

    res.json({ fleet });
  } catch (error) {
    console.error('Get fleet error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Generate unique registration based on country prefix
function generateRegistration(db, prefix) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let attempts = 0;
  const maxAttempts = 100;

  while (attempts < maxAttempts) {
    let reg = prefix + '-';
    for (let i = 0; i < 4; i++) {
      reg += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // Check if registration exists
    const checkStmt = db.prepare('SELECT id FROM aircraft WHERE registration = ?');
    checkStmt.bind([reg]);
    const exists = checkStmt.step();
    checkStmt.free();

    if (!exists) {
      return reg;
    }
    attempts++;
  }

  throw new Error('Could not generate unique registration');
}

// Purchase aircraft
router.post('/purchase',
  authMiddleware,
  body('aircraft_type_id').isInt({ min: 1 }).withMessage('Invalid aircraft type'),
  body('name').optional().isLength({ max: 50 }).trim(),
  (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { aircraft_type_id, name } = req.body;
      const db = getDatabase();

      // Get airline details
      const airlineStmt = db.prepare(`
        SELECT a.id, a.balance, a.level, a.home_airport_code, ap.registration_prefix
        FROM airlines a
        JOIN airports ap ON a.home_airport_code = ap.iata_code
        WHERE a.user_id = ?
      `);
      airlineStmt.bind([req.userId]);

      if (!airlineStmt.step()) {
        airlineStmt.free();
        return res.status(400).json({ error: 'No airline found' });
      }

      const airlineRow = airlineStmt.get();
      const airline = {
        id: airlineRow[0],
        balance: airlineRow[1],
        level: airlineRow[2],
        home_airport_code: airlineRow[3],
        registration_prefix: airlineRow[4]
      };
      airlineStmt.free();

      // Get aircraft type
      const typeStmt = db.prepare('SELECT * FROM aircraft_types WHERE id = ?');
      typeStmt.bind([aircraft_type_id]);

      if (!typeStmt.step()) {
        typeStmt.free();
        return res.status(400).json({ error: 'Aircraft type not found' });
      }

      const typeRow = typeStmt.get();
      const aircraftType = {
        id: typeRow[0],
        manufacturer: typeRow[1],
        model: typeRow[2],
        full_name: typeRow[3],
        max_seats: typeRow[4],
        range_km: typeRow[5],
        new_price: typeRow[6],
        required_level: typeRow[7]
      };
      typeStmt.free();

      // Check level requirement
      if (airline.level < aircraftType.required_level) {
        return res.status(400).json({
          error: `Requires level ${aircraftType.required_level}. Your airline is level ${airline.level}.`
        });
      }

      // Check balance
      if (airline.balance < aircraftType.new_price) {
        return res.status(400).json({
          error: `Insufficient funds. Need $${aircraftType.new_price.toLocaleString()}, have $${airline.balance.toLocaleString()}`
        });
      }

      // Generate registration
      const registration = generateRegistration(db, airline.registration_prefix);

      // Deduct balance
      const newBalance = airline.balance - aircraftType.new_price;
      const updateBalanceStmt = db.prepare('UPDATE airlines SET balance = ? WHERE id = ?');
      updateBalanceStmt.bind([newBalance, airline.id]);
      updateBalanceStmt.step();
      updateBalanceStmt.free();

      // Create aircraft
      const insertStmt = db.prepare(
        'INSERT INTO aircraft (airline_id, aircraft_type_id, registration, name) VALUES (?, ?, ?, ?)'
      );
      insertStmt.bind([airline.id, aircraft_type_id, registration, name || null]);
      insertStmt.step();
      insertStmt.free();

      // Get the created aircraft
      const fetchStmt = db.prepare('SELECT id FROM aircraft WHERE registration = ?');
      fetchStmt.bind([registration]);
      fetchStmt.step();
      const aircraftId = fetchStmt.get()[0];
      fetchStmt.free();

      saveDatabase();

      res.status(201).json({
        message: 'Aircraft purchased successfully',
        aircraft: {
          id: aircraftId,
          registration,
          name: name || null,
          full_name: aircraftType.full_name,
          manufacturer: aircraftType.manufacturer,
          model: aircraftType.model,
          max_seats: aircraftType.max_seats,
          range_km: aircraftType.range_km
        },
        new_balance: newBalance
      });
    } catch (error) {
      console.error('Purchase aircraft error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

export default router;
