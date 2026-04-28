import { Router } from 'express';
import { analyzeSession } from '../services/sessionAnalyzer.js';
import pool from '../db/pool.js';

const router = Router();

router.use(async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const jwt = await import('jsonwebtoken');
    req.user = jwt.default.verify(token, process.env.JWT_SECRET || 'ligma-secret');
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

router.get('/:roomId', async (req, res) => {
  try {
    const member = await pool.query(
      'SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2',
      [req.params.roomId, req.user.user_id]
    );
    if (!member.rows.length) return res.status(403).json({ error: 'Not a room member' });
    const report = await analyzeSession(req.params.roomId);
    res.json(report);
  } catch (e) {
    console.error('Session report error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
