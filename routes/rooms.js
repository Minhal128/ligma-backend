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

router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    const r = await pool.query(
      'INSERT INTO rooms (name, created_by) VALUES ($1,$2) RETURNING *',
      [name || 'Untitled Room', req.user.user_id]
    );
    const room = r.rows[0];
    await pool.query(
      'INSERT INTO room_members (room_id, user_id, role) VALUES ($1,$2,$3)',
      [room.id, req.user.user_id, 'lead']
    );
    res.json(room);
  } catch (e) {
    console.error('Create room error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT r.*, rm.role as my_role FROM rooms r
       JOIN room_members rm ON r.id = rm.room_id
       WHERE rm.user_id=$1 ORDER BY r.created_at DESC`,
      [req.user.user_id]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('List rooms error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT r.*, rm.role as my_role FROM rooms r
       JOIN room_members rm ON r.id = rm.room_id
       WHERE r.id=$1 AND rm.user_id=$2`,
      [req.params.id, req.user.user_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Room not found or not a member' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('Get room error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/members', async (req, res) => {
  try {
    const { user_id, role = 'contributor' } = req.body;
    await pool.query(
      'INSERT INTO room_members (room_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [req.params.id, user_id, role]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Add member error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id/members', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.username, rm.role FROM room_members rm
       JOIN users u ON rm.user_id = u.id WHERE rm.room_id=$1`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('List members error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
