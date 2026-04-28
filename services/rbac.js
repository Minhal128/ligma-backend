import jwt from 'jsonwebtoken';
import pool from '../db/pool.js';

const JWT_SECRET = process.env.JWT_SECRET || 'ligma-secret';

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export async function getRoomRole(roomId, userId) {
  const r = await pool.query(
    'SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2',
    [roomId, userId]
  );
  if (r.rows.length) return r.rows[0].role;
  return null;
}

export async function getNodeACL(nodeId) {
  const r = await pool.query('SELECT acl FROM canvas_nodes WHERE id=$1', [nodeId]);
  if (r.rows.length) return r.rows[0].acl || {};
  return {};
}

export async function canMutate(roomId, userId, nodeId, action) {
  const roomRole = await getRoomRole(roomId, userId);
  if (!roomRole) return { allowed: false, reason: 'Not a room member' };

  const acl = await getNodeACL(nodeId);
  const required = action === 'read' ? 'read' : action === 'comment' ? 'comment' : 'write';
  const levels = { read: 1, comment: 2, write: 3 };

  if (!acl[roomRole]) {
    // Default: lead=write, contributor=write, viewer=read
    const defaults = { lead: 'write', contributor: 'write', viewer: 'read' };
    const effective = defaults[roomRole];
    if (levels[effective] >= levels[required]) return { allowed: true, role: roomRole };
    return { allowed: false, reason: `Room role '${roomRole}' lacks '${required}' permission` };
  }

  const effective = acl[roomRole];
  if (levels[effective] >= levels[required]) return { allowed: true, role: roomRole };
  return { allowed: false, reason: `Node ACL denies '${required}' for role '${roomRole}'` };
}

export async function canCreateNode(roomId, userId) {
  const roomRole = await getRoomRole(roomId, userId);
  if (!roomRole) return { allowed: false, reason: 'Not a room member' };
  if (roomRole === 'viewer') return { allowed: false, reason: 'Viewers cannot create nodes' };
  return { allowed: true, role: roomRole };
}

export async function logSecurityEvent(roomId, userId, nodeId, attemptedAction, denialReason) {
  await pool.query(
    'INSERT INTO security_events (room_id, user_id, node_id, attempted_action, denial_reason) VALUES ($1,$2,$3,$4,$5)',
    [roomId, userId, nodeId, attemptedAction, denialReason]
  );
}
