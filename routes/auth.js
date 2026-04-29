import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../db/pool.js';
import { sendOTP, sendPasswordReset, generateOTP, generateResetToken } from '../services/emailService.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'ligma-secret';

router.post('/register', async (req, res) => {
  try {
    const { username, password, role = 'contributor', email = null } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      'INSERT INTO users (username, password_hash, role, email) VALUES ($1,$2,$3,$4) RETURNING id, username, role, email',
      [username, hash, role, email]
    );
    const user = r.rows[0];
    const token = jwt.sign({ user_id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { user_id: user.id, username: user.username, role: user.role, email: user.email } });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    console.error('Register error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const r = await pool.query('SELECT id, username, password_hash, role FROM users WHERE username=$1', [username]);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ user_id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { user_id: user.id, username: user.username, role: user.role } });
  } catch (e) {
    console.error('Login error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Forgot Password - Request OTP
router.post('/forgot-password', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });

    const r = await pool.query('SELECT id, username, email FROM users WHERE username=$1', [username]);
    if (!r.rows.length) {
      // Don't reveal if user exists
      return res.json({ ok: true, message: 'If account exists, OTP sent' });
    }

    const user = r.rows[0];
    if (!user.email) {
      return res.status(400).json({ error: 'No email associated with this account' });
    }

    // Generate OTP
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await pool.query(
      'UPDATE users SET otp_code=$1, otp_expires_at=$2 WHERE id=$3',
      [otp, expiresAt, user.id]
    );

    // Send email
    await sendOTP(user.email, user.username, otp);

    res.json({ ok: true, message: 'OTP sent to registered email' });
  } catch (e) {
    console.error('Forgot password error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Verify OTP
router.post('/verify-otp', async (req, res) => {
  try {
    const { username, otp } = req.body;
    if (!username || !otp) return res.status(400).json({ error: 'Username and OTP required' });

    const r = await pool.query(
      'SELECT id, otp_code, otp_expires_at FROM users WHERE username=$1',
      [username]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Invalid request' });

    const user = r.rows[0];
    
    if (user.otp_code !== otp) {
      return res.status(401).json({ error: 'Invalid OTP' });
    }

    if (new Date() > new Date(user.otp_expires_at)) {
      return res.status(401).json({ error: 'OTP expired' });
    }

    // Generate reset token
    const resetToken = generateResetToken();
    const tokenExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      'UPDATE users SET reset_token=$1, reset_token_expires_at=$2, otp_code=NULL, otp_expires_at=NULL WHERE id=$3',
      [resetToken, tokenExpires, user.id]
    );

    res.json({ ok: true, resetToken });
  } catch (e) {
    console.error('Verify OTP error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset Password
router.post('/reset-password', async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;
    if (!resetToken || !newPassword) return res.status(400).json({ error: 'Reset token and new password required' });

    const r = await pool.query(
      'SELECT id, reset_token, reset_token_expires_at FROM users WHERE reset_token=$1',
      [resetToken]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Invalid reset token' });

    const user = r.rows[0];

    if (new Date() > new Date(user.reset_token_expires_at)) {
      return res.status(401).json({ error: 'Reset token expired' });
    }

    // Hash new password
    const hash = await bcrypt.hash(newPassword, 12);

    await pool.query(
      'UPDATE users SET password_hash=$1, reset_token=NULL, reset_token_expires_at=NULL WHERE id=$2',
      [hash, user.id]
    );

    res.json({ ok: true, message: 'Password reset successful' });
  } catch (e) {
    console.error('Reset password error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Resend OTP
router.post('/resend-otp', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });

    const r = await pool.query('SELECT id, username, email FROM users WHERE username=$1', [username]);
    if (!r.rows.length) {
      return res.json({ ok: true, message: 'If account exists, OTP sent' });
    }

    const user = r.rows[0];
    if (!user.email) {
      return res.status(400).json({ error: 'No email associated with this account' });
    }

    // Generate new OTP
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      'UPDATE users SET otp_code=$1, otp_expires_at=$2 WHERE id=$3',
      [otp, expiresAt, user.id]
    );

    await sendOTP(user.email, user.username, otp);

    res.json({ ok: true, message: 'New OTP sent' });
  } catch (e) {
    console.error('Resend OTP error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
