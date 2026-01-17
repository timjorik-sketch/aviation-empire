import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import { initDatabase, saveDatabase } from '../database/db.js';

const router = express.Router();

let db = null;

// Initialize database connection
(async () => {
  db = await initDatabase();
})();

// Register
router.post('/register',
  body('email').isEmail().normalizeEmail(),
  body('username').isLength({ min: 3, max: 20 }).trim(),
  body('password').isLength({ min: 6 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, username, password } = req.body;

      // Check if user exists
      const existingUser = db.exec('SELECT * FROM users WHERE email = ? OR username = ?', [email, username]);
      if (existingUser.length > 0 && existingUser[0].values.length > 0) {
        return res.status(400).json({ error: 'User already exists' });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      // Insert user
      db.run('INSERT INTO users (email, username, password_hash) VALUES (?, ?, ?)', [email, username, passwordHash]);
      saveDatabase();
      
      const result = db.exec('SELECT last_insert_rowid() as id');
      const userId = result[0].values[0][0];

      // Generate token
      const token = jwt.sign(
        { userId, username },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.status(201).json({
        message: 'User created successfully',
        token,
        user: { id: userId, username, email }
      });
    } catch (error) {
      console.error('Register error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Login
router.post('/login',
  body('username').trim(),
  body('password').exists(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { username, password } = req.body;

      // Find user
      const userResult = db.exec('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
      if (userResult.length === 0 || userResult[0].values.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const userRow = userResult[0].values[0];
      const user = {
        id: userRow[0],
        email: userRow[1],
        username: userRow[2],
        password_hash: userRow[3]
      };

      // Check password
      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Update last login
      db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
      saveDatabase();

      // Generate token
      const token = jwt.sign(
        { userId: user.id, username: user.username },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.json({
        message: 'Login successful',
        token,
        user: { id: user.id, username: user.username, email: user.email }
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

export default router;