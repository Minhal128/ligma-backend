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
    const { before, after, limit = 50 } = req.query;
    let sql = 'SELECT ce.*, u.username FROM canvas_events ce LEFT JOIN users u ON ce.user_id = u.id WHERE ce.room_id=$1';
    const args = [req.params.roomId];
    if (after) {
      args.push(Number(after));
      sql += ' AND ce.id > $' + args.length;
    }
    if (before) {
      args.push(before);
      sql += ' AND ce.created_at <= $' + args.length;
    }
    sql += ' ORDER BY ce.id DESC LIMIT $' + (args.length + 1);
    args.push(Number(limit) || 50);
    const r = await pool.query(sql, args);
    res.json(r.rows);
  } catch (e) {
    console.error('List events error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
