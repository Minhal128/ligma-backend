import { Router } from 'express';
import pool from '../db/pool.js';
import { generateInviteToken, sendRoomInvite } from '../services/emailService.js';

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

const VALID_ROLES = ['lead', 'contributor', 'viewer'];
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

async function isRoomLead(roomId, userId) {
  const r = await pool.query(
    'SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2',
    [roomId, userId]
  );
  return r.rows.length > 0 && r.rows[0].role === 'lead';
}

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
    
    // Broadcast to lobby clients
    const { broadcastToLobby } = await import('../ws/wsServer.js');
    room.my_role = 'lead';
    broadcastToLobby({ type: 'room_created', room });

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

// Search users by username (for inviting)
router.get('/users/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }
    const r = await pool.query(
      `SELECT id, username FROM users 
       WHERE username ILIKE $1 AND id != $2
       LIMIT 10`,
      [`%${q}%`, req.user.user_id]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('Search users error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id/members', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.username, u.email, rm.role FROM room_members rm
       JOIN users u ON rm.user_id = u.id WHERE rm.room_id=$1`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('List members error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id/invites', async (req, res) => {
  try {
    if (!await isRoomLead(req.params.id, req.user.user_id)) {
      return res.status(403).json({ error: 'Only leads can view invites' });
    }
    const r = await pool.query(
      `SELECT id, email, role, created_at, accepted_at 
       FROM room_invites WHERE room_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('List invites error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add member to room (lead only)
router.post('/:id/invite', async (req, res) => {
  try {
    const { username, role = 'contributor' } = req.body;
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    
    // Check if current user is lead
    if (!await isRoomLead(req.params.id, req.user.user_id)) {
      return res.status(403).json({ error: 'Only leads can invite members' });
    }
    
    // Find user by username
    const userResult = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );
    if (!userResult.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userId = userResult.rows[0].id;
    
    // Add member
    await pool.query(
      'INSERT INTO room_members (room_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (room_id, user_id) DO UPDATE SET role = $3',
      [req.params.id, userId, role]
    );
    
    res.json({ ok: true, invited: username, role });
  } catch (e) {
    console.error('Invite error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/invite-email', async (req, res) => {
  try {
    const { email, role = 'contributor' } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (!await isRoomLead(req.params.id, req.user.user_id)) {
      return res.status(403).json({ error: 'Only leads can invite members' });
    }

    const roomRes = await pool.query('SELECT id, name FROM rooms WHERE id=$1', [req.params.id]);
    if (!roomRes.rows.length) return res.status(404).json({ error: 'Room not found' });
    const room = roomRes.rows[0];

    const token = generateInviteToken();
    await pool.query(
      `INSERT INTO room_invites (room_id, email, role, invited_by, token)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (room_id, email) DO UPDATE SET role=$3, invited_by=$4, token=$5, accepted_at=NULL`,
      [room.id, email.toLowerCase(), role, req.user.user_id, token]
    );

    const inviteUrl = `${FRONTEND_URL}/#/login?invite=${token}`;
    await sendRoomInvite(email, req.user.username, room.name, role, inviteUrl);

    const maybeUser = await pool.query('SELECT id FROM users WHERE lower(email)=lower($1)', [email]);
    if (maybeUser.rows.length) {
      await pool.query(
        `INSERT INTO room_members (room_id, user_id, role)
         VALUES ($1,$2,$3)
         ON CONFLICT (room_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [room.id, maybeUser.rows[0].id, role]
      );
      await pool.query(
        'UPDATE room_invites SET accepted_by=$1, accepted_at=NOW() WHERE room_id=$2 AND email=lower($3)',
        [maybeUser.rows[0].id, room.id, email]
      );
    }

    res.json({ ok: true, invited: email, role });
  } catch (e) {
    console.error('Invite by email error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/invites/accept', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Invite token required' });
    const inviteRes = await pool.query(
      'SELECT room_id, role FROM room_invites WHERE token=$1',
      [token]
    );
    if (!inviteRes.rows.length) return res.status(404).json({ error: 'Invite not found' });
    const invite = inviteRes.rows[0];
    await pool.query(
      `INSERT INTO room_members (room_id, user_id, role)
       VALUES ($1,$2,$3)
       ON CONFLICT (room_id, user_id) DO UPDATE SET role=EXCLUDED.role`,
      [invite.room_id, req.user.user_id, invite.role]
    );
    await pool.query(
      'UPDATE room_invites SET accepted_by=$1, accepted_at=NOW() WHERE token=$2',
      [req.user.user_id, token]
    );
    res.json({ ok: true, room_id: invite.room_id, role: invite.role });
  } catch (e) {
    console.error('Accept invite error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update member role (lead only)
router.patch('/:id/members/:userId/role', async (req, res) => {
  try {
    const { role } = req.body;
    const { id: roomId, userId } = req.params;
    
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    
    // Check if current user is lead
    if (!await isRoomLead(roomId, req.user.user_id)) {
      return res.status(403).json({ error: 'Only leads can change roles' });
    }
    
    // Prevent changing own role if you're the last lead
    if (userId === req.user.user_id) {
      const leads = await pool.query(
        'SELECT COUNT(*) as count FROM room_members WHERE room_id=$1 AND role=$2',
        [roomId, 'lead']
      );
      if (leads.rows[0].count <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last lead' });
      }
    }
    
    await pool.query(
      'UPDATE room_members SET role=$1 WHERE room_id=$2 AND user_id=$3',
      [role, roomId, userId]
    );
    
    res.json({ ok: true, userId, role });
  } catch (e) {
    console.error('Update role error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Remove member from room (lead only)
router.delete('/:id/members/:userId', async (req, res) => {
  try {
    const { id: roomId, userId } = req.params;
    
    // Check if current user is lead
    if (!await isRoomLead(roomId, req.user.user_id)) {
      return res.status(403).json({ error: 'Only leads can remove members' });
    }
    
    // Cannot remove self if last lead
    if (userId === req.user.user_id) {
      const leads = await pool.query(
        'SELECT COUNT(*) as count FROM room_members WHERE room_id=$1 AND role=$2',
        [roomId, 'lead']
      );
      if (leads.rows[0].count <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last lead' });
      }
    }
    
    await pool.query(
      'DELETE FROM room_members WHERE room_id=$1 AND user_id=$2',
      [roomId, userId]
    );
    
    res.json({ ok: true });
  } catch (e) {
    console.error('Remove member error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Lock/Unlock room - leads can lock the architecture diagram
router.post('/:id/lock', async (req, res) => {
  try {
    const { locked } = req.body;
    const roomId = req.params.id;
    
    // Check if current user is lead
    if (!await isRoomLead(roomId, req.user.user_id)) {
      return res.status(403).json({ error: 'Only leads can lock/unlock the room' });
    }
    
    // Store lock status in room settings (using a settings JSONB column or separate field)
    await pool.query(
      'UPDATE rooms SET is_locked=$1 WHERE id=$2',
      [locked, roomId]
    );
    
    res.json({ ok: true, locked });
  } catch (e) {
    console.error('Lock room error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get room lock status
router.get('/:id/lock', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT is_locked FROM rooms WHERE id=$1',
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Room not found' });
    res.json({ locked: r.rows[0].is_locked || false });
  } catch (e) {
    console.error('Get lock status error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/lead/dashboard', async (req, res) => {
  try {
    const rooms = await pool.query(
      `SELECT r.id, r.name, r.created_at
       FROM rooms r
       JOIN room_members rm ON rm.room_id=r.id
       WHERE rm.user_id=$1 AND rm.role='lead'
       ORDER BY r.created_at DESC`,
      [req.user.user_id]
    );

    if (!rooms.rows.length) return res.json([]);

    const roomIds = rooms.rows.map((r) => r.id);
    const tasks = await pool.query(
      `SELECT t.id, t.room_id, COALESCE(t.title, t.content) AS title, t.status, t.created_at,
              u.username AS assigned_username
       FROM tasks t
       LEFT JOIN users u ON u.id=t.assigned_to
       WHERE t.room_id = ANY($1::uuid[])
       ORDER BY t.created_at DESC`,
      [roomIds]
    );

    const grouped = new Map();
    for (const room of rooms.rows) grouped.set(room.id, { ...room, tasks: [] });
    for (const task of tasks.rows) grouped.get(task.room_id)?.tasks.push(task);
    res.json(Array.from(grouped.values()));
  } catch (e) {
    console.error('Lead dashboard error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
