import express from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../utils/email.js';

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function frontendBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
}

async function issueVerificationEmail(user) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  await pool.query(
    `INSERT INTO email_verifications (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
    [user.id, tokenHash]
  );
  const verifyUrl = `${frontendBase()}/?verify_token=${rawToken}`;
  try {
    const result = await sendVerificationEmail({
      to: user.email, username: user.username, verifyUrl,
    });
    if (result?.skipped) {
      console.log(`[verify-email] SMTP off — link for ${user.email}: ${verifyUrl}`);
    }
  } catch (mailErr) {
    console.error('[verify-email] email send failed:', mailErr);
  }
}

const router = express.Router();

// Register
router.post('/register',
  body('email').isEmail().normalizeEmail(),
  body('username').isLength({ min: 3, max: 20 }).trim(),
  body('password').isLength({ min: 6 }),
  body('invite_code').isString().trim().notEmpty().withMessage('Invite code required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, username, password, invite_code } = req.body;

      // Validate invite code
      const codeResult = await pool.query(
        'SELECT id, used_by, revoked FROM invite_codes WHERE code = $1',
        [invite_code.toUpperCase()]
      );
      if (!codeResult.rows[0]) {
        return res.status(400).json({ error: 'Invalid invite code' });
      }
      const inviteRow = codeResult.rows[0];
      if (inviteRow.revoked) {
        return res.status(400).json({ error: 'Invite code has been revoked' });
      }
      if (inviteRow.used_by) {
        return res.status(400).json({ error: 'Invite code has already been used' });
      }

      // Check if user exists
      const checkResult = await pool.query(
        'SELECT id FROM users WHERE email = $1 OR username = $2',
        [email, username]
      );
      if (checkResult.rows[0]) {
        return res.status(400).json({ error: 'User already exists' });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      // Insert user with RETURNING
      const insertResult = await pool.query(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id, is_admin',
        [email, username, passwordHash]
      );
      const userId = insertResult.rows[0].id;
      const isAdmin = insertResult.rows[0].is_admin || false;

      // Mark invite code as used
      await pool.query(
        'UPDATE invite_codes SET used_by = $1, used_at = NOW() WHERE id = $2',
        [userId, inviteRow.id]
      );

      // Soft email verification — never block registration on mailer errors.
      try {
        await issueVerificationEmail({ id: userId, email, username });
      } catch (e) {
        console.error('[register] verification issue failed:', e);
      }

      // Generate token
      const token = jwt.sign(
        { userId, username },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.status(201).json({
        message: 'User created successfully',
        token,
        user: { id: userId, username, email, is_admin: isAdmin, email_verified: false }
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
      const findResult = await pool.query(
        'SELECT id, email, username, password_hash, is_admin, is_banned, email_verified FROM users WHERE username = $1 OR email = $1',
        [username]
      );

      if (!findResult.rows[0]) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = findResult.rows[0];

      // Check password
      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      if (user.is_banned) {
        return res.status(403).json({ error: 'This account has been banned.' });
      }

      // Update last login
      await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

      // Generate token
      const token = jwt.sign(
        { userId: user.id, username: user.username },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.json({
        message: 'Login successful',
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          is_admin: user.is_admin || false,
          email_verified: user.email_verified || false,
        }
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Request a password reset — always returns 200 to avoid leaking which emails exist.
// Rate-limited to one email per user per minute.
router.post('/forgot-password',
  body('email').isEmail().normalizeEmail(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      // Generic success response used for every branch
      const genericOk = () => res.json({
        message: 'If an account exists for that email, a reset link has been sent.'
      });

      if (!errors.isEmpty()) return genericOk();

      const { email } = req.body;
      const userResult = await pool.query(
        'SELECT id, username, email, is_banned FROM users WHERE email = $1',
        [email]
      );
      const user = userResult.rows[0];
      if (!user || user.is_banned) return genericOk();

      // Rate-limit: skip new email if one was issued within 60s
      const recent = await pool.query(
        `SELECT created_at FROM password_resets
         WHERE user_id = $1 AND created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY created_at DESC LIMIT 1`,
        [user.id]
      );
      if (recent.rows[0]) return genericOk();

      // Invalidate any older unused tokens for this user
      await pool.query(
        `UPDATE password_resets SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );

      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      await pool.query(
        `INSERT INTO password_resets (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
        [user.id, tokenHash]
      );

      const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
      const resetUrl = `${base}/?reset_token=${rawToken}`;

      try {
        const result = await sendPasswordResetEmail({
          to: user.email,
          username: user.username,
          resetUrl,
        });
        if (result?.skipped) {
          console.log(`[forgot-password] SMTP off — link for ${user.email}: ${resetUrl}`);
        }
      } catch (mailErr) {
        // Log but still respond generically — user shouldn't see mailer errors
        console.error('[forgot-password] email send failed:', mailErr);
      }

      return genericOk();
    } catch (error) {
      console.error('Forgot password error:', error);
      // Still generic — don't leak internals
      return res.json({
        message: 'If an account exists for that email, a reset link has been sent.'
      });
    }
  }
);

// Complete password reset using the one-time token
router.post('/reset-password',
  body('token').isString().isLength({ min: 32, max: 128 }).trim(),
  body('newPassword').isLength({ min: 6 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Invalid request' });
      }

      const { token, newPassword } = req.body;
      const tokenHash = hashToken(token);

      const resetResult = await pool.query(
        `SELECT id, user_id, expires_at, used_at
         FROM password_resets WHERE token_hash = $1`,
        [tokenHash]
      );
      const row = resetResult.rows[0];
      if (!row) return res.status(400).json({ error: 'Invalid or expired token' });
      if (row.used_at) return res.status(400).json({ error: 'This reset link has already been used' });
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return res.status(400).json({ error: 'This reset link has expired' });
      }

      const userResult = await pool.query(
        'SELECT id, is_banned FROM users WHERE id = $1',
        [row.user_id]
      );
      const user = userResult.rows[0];
      if (!user) return res.status(400).json({ error: 'Invalid or expired token' });
      if (user.is_banned) return res.status(403).json({ error: 'This account has been banned.' });

      const newHash = await bcrypt.hash(newPassword, 10);
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);
      await pool.query(
        `UPDATE password_resets SET used_at = NOW() WHERE id = $1`,
        [row.id]
      );
      // Also invalidate any other outstanding tokens for this user
      await pool.query(
        `UPDATE password_resets SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );

      res.json({ message: 'Password has been reset. You can now log in.' });
    } catch (error) {
      console.error('Reset password error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Verify email via one-time token
router.post('/verify-email',
  body('token').isString().isLength({ min: 32, max: 128 }).trim(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Invalid token' });
      }

      const { token } = req.body;
      const tokenHash = hashToken(token);

      const lookup = await pool.query(
        `SELECT id, user_id, expires_at, used_at FROM email_verifications WHERE token_hash = $1`,
        [tokenHash]
      );
      const row = lookup.rows[0];
      if (!row) return res.status(400).json({ error: 'Invalid or expired token' });

      // Idempotent: re-clicking an already-used link is a friendly success.
      if (row.used_at) {
        return res.json({ message: 'Email already verified.', already: true });
      }
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return res.status(400).json({ error: 'This verification link has expired' });
      }

      await pool.query(
        `UPDATE users SET email_verified = TRUE, email_verified_at = NOW() WHERE id = $1`,
        [row.user_id]
      );
      await pool.query(
        `UPDATE email_verifications SET used_at = NOW() WHERE id = $1`,
        [row.id]
      );
      // Invalidate any other outstanding tokens for this user
      await pool.query(
        `UPDATE email_verifications SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [row.user_id]
      );

      res.json({ message: 'Email verified. Thanks!' });
    } catch (error) {
      console.error('Verify email error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Resend verification email (requires login). Rate-limited to 60s per user.
router.post('/resend-verification', authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT id, email, username, email_verified FROM users WHERE id = $1',
      [req.userId]
    );
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.email_verified) {
      return res.json({ message: 'Email already verified.', already: true });
    }

    const recent = await pool.query(
      `SELECT created_at FROM email_verifications
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '60 seconds'
       ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    if (recent.rows[0]) {
      return res.status(429).json({ error: 'Please wait a minute before requesting another email.' });
    }

    // Invalidate any older unused tokens for this user
    await pool.query(
      `UPDATE email_verifications SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL`,
      [user.id]
    );

    await issueVerificationEmail(user);
    res.json({ message: 'Verification email sent.' });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user profile
router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, created_at, is_admin, email_verified FROM users WHERE id = $1',
      [req.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    const row = result.rows[0];
    res.json({ user: {
      id: row.id, username: row.username, email: row.email, created_at: row.created_at,
      is_admin: row.is_admin || false,
      email_verified: row.email_verified || false,
    } });
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

    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    const hash = result.rows[0].password_hash;

    const valid = await bcrypt.compare(currentPassword, hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.userId]);

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

    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    const hash = result.rows[0].password_hash;

    const valid = await bcrypt.compare(currentPassword, hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const checkResult = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND id != $2',
      [newEmail, req.userId]
    );
    if (checkResult.rows[0]) return res.status(400).json({ error: 'Email already in use' });

    await pool.query(
      'UPDATE users SET email = $1, email_verified = FALSE, email_verified_at = NULL WHERE id = $2',
      [newEmail, req.userId]
    );
    // Fire a fresh verification email to the new address
    try {
      const userRow = await pool.query('SELECT id, username FROM users WHERE id = $1', [req.userId]);
      if (userRow.rows[0]) {
        await issueVerificationEmail({
          id: req.userId, email: newEmail, username: userRow.rows[0].username,
        });
      }
    } catch (e) {
      console.error('[change-email] verification issue failed:', e);
    }

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

    // Verify password
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    const hash = result.rows[0].password_hash;

    const valid = await bcrypt.compare(password, hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    // Clear FK references without CASCADE, then delete user
    await pool.query('UPDATE users SET active_airline_id = NULL WHERE id = $1', [req.userId]);
    await pool.query('UPDATE airlines SET active_airline_id = NULL WHERE user_id = $1', [req.userId]);
    await pool.query('DELETE FROM market_analyses WHERE airline_id IN (SELECT id FROM airlines WHERE user_id = $1)', [req.userId]);
    await pool.query('DELETE FROM analysis_limits WHERE airline_id IN (SELECT id FROM airlines WHERE user_id = $1)', [req.userId]);

    // Delete user — cascades to airlines → aircraft, routes, flights, transactions, etc.
    await pool.query('DELETE FROM users WHERE id = $1', [req.userId]);

    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
