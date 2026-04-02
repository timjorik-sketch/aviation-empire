import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import { getDatabase, saveDatabase } from '../database/db.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

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
      const db = getDatabase();

      // Check if user exists
      const checkStmt = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?');
      checkStmt.bind([email, username]);
      const userExists = checkStmt.step();
      checkStmt.free();

      if (userExists) {
        return res.status(400).json({ error: 'User already exists' });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      // Insert user
      const insertStmt = db.prepare('INSERT INTO users (email, username, password_hash) VALUES (?, ?, ?)');
      insertStmt.bind([email, username, passwordHash]);
      insertStmt.step();
      insertStmt.free();

      // Get the created user's ID
      const getUserStmt = db.prepare('SELECT id FROM users WHERE email = ?');
      getUserStmt.bind([email]);
      getUserStmt.step();
      const userId = getUserStmt.get()[0];
      getUserStmt.free();
      saveDatabase();

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
      const db = getDatabase();

      // Find user
      const findStmt = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?');
      findStmt.bind([username, username]);

      if (!findStmt.step()) {
        findStmt.free();
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const userRow = findStmt.get();
      findStmt.free();

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
      const updateStmt = db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?');
      updateStmt.bind([user.id]);
      updateStmt.step();
      updateStmt.free();
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

// Get current user profile
router.get('/profile', authMiddleware, (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare('SELECT id, username, email, created_at FROM users WHERE id = ?');
    stmt.bind([req.userId]);
    if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: 'User not found' }); }
    const row = stmt.get();
    stmt.free();
    res.json({ user: { id: row[0], username: row[1], email: row[2], created_at: row[3] } });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Change password
router.patch('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const db = getDatabase();
    const stmt = db.prepare('SELECT password_hash FROM users WHERE id = ?');
    stmt.bind([req.userId]);
    if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: 'User not found' }); }
    const hash = stmt.get()[0];
    stmt.free();

    const valid = await bcrypt.compare(currentPassword, hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const newHash = await bcrypt.hash(newPassword, 10);
    const upStmt = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
    upStmt.bind([newHash, req.userId]);
    upStmt.step();
    upStmt.free();
    saveDatabase();

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Change email
router.patch('/change-email', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newEmail } = req.body;
    if (!currentPassword || !newEmail) return res.status(400).json({ error: 'Password and new email required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return res.status(400).json({ error: 'Invalid email address' });

    const db = getDatabase();
    const stmt = db.prepare('SELECT password_hash FROM users WHERE id = ?');
    stmt.bind([req.userId]);
    if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: 'User not found' }); }
    const hash = stmt.get()[0];
    stmt.free();

    const valid = await bcrypt.compare(currentPassword, hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const checkStmt = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?');
    checkStmt.bind([newEmail, req.userId]);
    if (checkStmt.step()) { checkStmt.free(); return res.status(400).json({ error: 'Email already in use' }); }
    checkStmt.free();

    const upStmt = db.prepare('UPDATE users SET email = ? WHERE id = ?');
    upStmt.bind([newEmail, req.userId]);
    upStmt.step();
    upStmt.free();
    saveDatabase();

    res.json({ message: 'Email changed successfully', newEmail });
  } catch (error) {
    console.error('Change email error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete account (irreversible — cascades to all airlines, aircraft, routes, flights, etc.)
router.delete('/account', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });

    const db = getDatabase();

    // Verify password
    const stmt = db.prepare('SELECT password_hash FROM users WHERE id = ?');
    stmt.bind([req.userId]);
    if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: 'User not found' }); }
    const hash = stmt.get()[0];
    stmt.free();

    const valid = await bcrypt.compare(password, hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    // Delete user — cascades to airlines → aircraft, routes, flights, transactions, etc.
    const delStmt = db.prepare('DELETE FROM users WHERE id = ?');
    delStmt.bind([req.userId]);
    delStmt.step();
    delStmt.free();
    saveDatabase();

    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;