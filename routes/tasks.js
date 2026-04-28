import { Router } from 'express';
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
    const r = await pool.query(
      `SELECT t.*, u.username as author_name FROM tasks t
       LEFT JOIN users u ON t.author_id = u.id
       WHERE t.room_id=$1 ORDER BY t.created_at DESC`,
      [req.params.roomId]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('List tasks error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
