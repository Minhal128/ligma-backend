import { Router } from 'express';
import pool from '../db/pool.js';
import { broadcastToRoom } from '../ws/wsServer.js';
import { insertCanvasEvent } from '../services/eventStore.js';

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
    const r = await pool.query(
      `SELECT t.*, 
              COALESCE(t.title, t.content) AS title,
              u.username as author_name,
              assignee.username AS assigned_username
       FROM tasks t
       LEFT JOIN users u ON t.author_id = u.id
       LEFT JOIN users assignee ON assignee.id = t.assigned_to
       WHERE t.room_id=$1 ORDER BY t.created_at DESC`,
      [req.params.roomId]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('List tasks error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:roomId', async (req, res) => {
  try {
    const { title, assigned_to = null, status = 'todo' } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
    if (!['todo', 'in_progress', 'done'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const member = await pool.query(
      'SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2',
      [req.params.roomId, req.user.user_id]
    );
    if (!member.rows.length) return res.status(403).json({ error: 'Not a room member' });
    if (member.rows[0].role !== 'lead') return res.status(403).json({ error: 'Only leads can create tasks' });

    if (assigned_to) {
      const assignee = await pool.query(
        'SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2',
        [req.params.roomId, assigned_to]
      );
      if (!assignee.rows.length) return res.status(400).json({ error: 'Assignee must be a room member' });
    }

    const r = await pool.query(
      `INSERT INTO tasks (room_id, content, title, status, assigned_to, created_by, author_id, intent_label)
       VALUES ($1,$2,$3,$4,$5,$6,$6,'action_item')
       RETURNING *`,
      [req.params.roomId, title, title, status, assigned_to, req.user.user_id]
    );
    const task = r.rows[0];
    broadcastToRoom(req.params.roomId, { type: 'task_created', task });
    const inserted = await insertCanvasEvent(req.params.roomId, req.user.user_id, 'task_created', {
      task_id: task.id,
      title: task.title || task.content || '',
      assigned_to: task.assigned_to || null,
      status: task.status,
    });
    broadcastToRoom(req.params.roomId, {
      type: 'event_log_entry',
      event: {
        id: inserted.id,
        event_type: 'task_created',
        payload: {
          task_id: task.id,
          title: task.title || task.content || '',
          assigned_to: task.assigned_to || null,
          status: task.status,
        },
        created_at: inserted.created_at,
        user_id: req.user.user_id,
        username: req.user.username,
      }
    });
    res.json(task);
  } catch (e) {
    console.error('Create task error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/:roomId/:taskId', async (req, res) => {
  try {
    const member = await pool.query(
      'SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2',
      [req.params.roomId, req.user.user_id]
    );
    if (!member.rows.length) return res.status(403).json({ error: 'Not a room member' });
    const role = member.rows[0].role;

    const current = await pool.query('SELECT * FROM tasks WHERE id=$1 AND room_id=$2', [req.params.taskId, req.params.roomId]);
    if (!current.rows.length) return res.status(404).json({ error: 'Task not found' });
    const task = current.rows[0];

    const nextStatus = req.body.status ?? task.status;
    const nextTitle = req.body.title ?? task.title ?? task.content;
    const nextAssignee = req.body.assigned_to ?? task.assigned_to;

    if (!['todo', 'in_progress', 'done'].includes(nextStatus)) return res.status(400).json({ error: 'Invalid status' });

    if (role === 'viewer') return res.status(403).json({ error: 'Viewers cannot update tasks' });
    if (role === 'contributor' && task.assigned_to !== req.user.user_id) {
      return res.status(403).json({ error: 'Contributors can only update their assigned tasks' });
    }
    if (role !== 'lead' && req.body.assigned_to && req.body.assigned_to !== task.assigned_to) {
      return res.status(403).json({ error: 'Only leads can reassign tasks' });
    }

    const updated = await pool.query(
      `UPDATE tasks SET title=$1, content=$1, status=$2, assigned_to=$3
       WHERE id=$4 RETURNING *`,
      [nextTitle, nextStatus, nextAssignee, req.params.taskId]
    );
    broadcastToRoom(req.params.roomId, { type: 'task_updated', task: updated.rows[0] });
    const inserted = await insertCanvasEvent(req.params.roomId, req.user.user_id, 'task_updated', {
      task_id: updated.rows[0].id,
      title: updated.rows[0].title || updated.rows[0].content || '',
      assigned_to: updated.rows[0].assigned_to || null,
      status: updated.rows[0].status,
    });
    broadcastToRoom(req.params.roomId, {
      type: 'event_log_entry',
      event: {
        id: inserted.id,
        event_type: 'task_updated',
        payload: {
          task_id: updated.rows[0].id,
          title: updated.rows[0].title || updated.rows[0].content || '',
          assigned_to: updated.rows[0].assigned_to || null,
          status: updated.rows[0].status,
        },
        created_at: inserted.created_at,
        user_id: req.user.user_id,
        username: req.user.username,
      }
    });
    res.json(updated.rows[0]);
  } catch (e) {
    console.error('Update task error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
