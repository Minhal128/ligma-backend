import { WebSocketServer } from 'ws';
import url from 'url';
import pool from '../db/pool.js';
import { verifyToken } from '../services/rbac.js';
import { handleYjsUpdate, getYDocState } from './yjsHandler.js';
import { insertCanvasEvent } from '../services/eventStore.js';

const rooms = new Map(); // roomId -> Map<userId, { ws, username, color, role, last_event_id }>
const cursorColors = [
  '#e94560', '#0f3460', '#533483', '#16a085', '#f39c12',
  '#8e44ad', '#2ecc71', '#e74c3c', '#3498db', '#1abc9c'
];

function assignColor(roomId) {
  const room = rooms.get(roomId);
  const used = room ? Array.from(room.values()).map(u => u.color) : [];
  for (const c of cursorColors) {
    if (!used.includes(c)) return c;
  }
  return cursorColors[Math.floor(Math.random() * cursorColors.length)];
}

export const lobbyClients = new Set();

export function broadcastToLobby(message) {
  const payload = JSON.stringify(message);
  for (const ws of lobbyClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

export function broadcastToRoom(roomId, message, excludeUserId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = JSON.stringify(message);
  for (const [uid, info] of room.entries()) {
    if (excludeUserId && uid === excludeUserId) continue;
    if (info.ws.readyState === 1) info.ws.send(payload);
  }
}

export function broadcastToLeads(roomId, message) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = JSON.stringify(message);
  for (const [, info] of room.entries()) {
    if (info.role === 'lead' && info.ws.readyState === 1) {
      info.ws.send(payload);
    }
  }
}

export function broadcastToUser(roomId, userId, message) {
  const room = rooms.get(roomId);
  if (!room) return;
  const info = room.get(userId);
  if (info && info.ws.readyState === 1) {
    info.ws.send(JSON.stringify(message));
  }
}

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    let userCtx = null;
    let currentRoomId = null;

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        console.log(`[WS Incoming] Type: ${msg.type}`, msg);

        if (msg.type === 'join_lobby') {
          lobbyClients.add(ws);
          ws.on('close', () => lobbyClients.delete(ws));
          return;
        }

        if (msg.type === 'join_room') {
          const token = msg.token;
          const payload = verifyToken(token);
          if (!payload) {
            ws.send(JSON.stringify({ type: 'error', code: 'AUTH_REQUIRED', message: 'Invalid token' }));
            ws.close();
            return;
          }
          const roomId = msg.room_id;
          const member = await pool.query(
            'SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2',
            [roomId, payload.user_id]
          );
          if (!member.rows.length) {
            ws.send(JSON.stringify({ type: 'error', code: 'AUTH_REQUIRED', message: 'Not a room member' }));
            ws.close();
            return;
          }
          currentRoomId = roomId;
          const color = assignColor(roomId);
          const userInfo = {
            ws,
            username: payload.username,
            color,
            role: member.rows[0].role,
            last_event_id: msg.last_event_id || 0,
            user_id: payload.user_id,
          };
          if (!rooms.has(roomId)) rooms.set(roomId, new Map());
          rooms.get(roomId).set(payload.user_id, userInfo);
          userCtx = payload;

          // Send Yjs initial sync
          const state = await getYDocState(roomId);
          ws.send(JSON.stringify({ type: 'yjs_update', update: state }));

          await insertCanvasEvent(roomId, payload.user_id, 'user_joined', {
            username: payload.username,
            role: member.rows[0].role,
          });
          broadcastToRoom(roomId, {
            type: 'event_log_entry',
            event: { event_type: 'user_joined', payload: { username: payload.username }, created_at: new Date().toISOString() }
          }, payload.user_id);

          // Broadcast cursors of existing users to this client
          for (const [uid, u] of rooms.get(roomId).entries()) {
            if (uid !== payload.user_id) {
              ws.send(JSON.stringify({
                type: 'cursor_update',
                user_id: uid,
                username: u.username,
                x: 0,
                y: 0,
                color: u.color,
              }));
            }
          }
          return;
        }

        if (!userCtx || !currentRoomId) {
          ws.send(JSON.stringify({ type: 'error', code: 'AUTH_REQUIRED', message: 'Join room first' }));
          return;
        }

        if (msg.type === 'yjs_update') {
          const { getRoomRole, logSecurityEvent } = await import('../services/rbac.js');
          const role = await getRoomRole(currentRoomId, userCtx.user_id);
          if (!role || role === 'viewer') {
            ws.send(JSON.stringify({ type: 'error', code: 'RBAC_DENIED', message: 'Viewers cannot edit canvas' }));
            await logSecurityEvent(currentRoomId, userCtx.user_id, null, 'yjs_update', 'Viewers denied canvas mutations');
            broadcastToLeads(currentRoomId, {
              type: 'security_violation',
              user_id: userCtx.user_id,
              username: userCtx.username,
              node_id: null,
              attempted_action: 'yjs_update',
              attempted_at: new Date().toISOString(),
            });
            return;
          }
          
          // Check if room is locked - only leads can edit when locked
          const roomCheck = await pool.query('SELECT is_locked FROM rooms WHERE id=$1', [currentRoomId]);
          const isLocked = roomCheck.rows[0]?.is_locked || false;
          if (isLocked && role !== 'lead') {
            ws.send(JSON.stringify({ type: 'error', code: 'ROOM_LOCKED', message: 'Room is locked. Only leads can edit. Contributors can comment.' }));
            await logSecurityEvent(currentRoomId, userCtx.user_id, null, 'yjs_update', 'Room locked - contributor denied');
            broadcastToLeads(currentRoomId, {
              type: 'security_violation',
              user_id: userCtx.user_id,
              username: userCtx.username,
              node_id: null,
              attempted_action: 'yjs_update_locked_room',
              attempted_at: new Date().toISOString(),
            });
            return;
          }
          
          await handleYjsUpdate(currentRoomId, msg.update, userCtx.user_id);
          broadcastToRoom(currentRoomId, { type: 'yjs_update', update: msg.update }, userCtx.user_id);
          return;
        }

        if (msg.type === 'cursor_move') {
          broadcastToRoom(currentRoomId, {
            type: 'cursor_update',
            user_id: userCtx.user_id,
            username: userCtx.username,
            x: msg.x,
            y: msg.y,
            color: rooms.get(currentRoomId)?.get(userCtx.user_id)?.color,
          }, userCtx.user_id);
          return;
        }

        if (msg.type === 'node_text_change') {
          const { canMutate } = await import('../services/rbac.js');
          const check = await canMutate(currentRoomId, userCtx.user_id, msg.node_id, 'write');
          if (!check.allowed) {
            ws.send(JSON.stringify({ type: 'error', code: 'RBAC_DENIED', message: check.reason }));
            const { logSecurityEvent } = await import('../services/rbac.js');
            await logSecurityEvent(currentRoomId, userCtx.user_id, msg.node_id, 'node_text_change', check.reason);
            broadcastToLeads(currentRoomId, {
              type: 'security_violation',
              user_id: userCtx.user_id,
              username: userCtx.username,
              node_id: msg.node_id,
              attempted_action: 'node_text_change',
              attempted_at: new Date().toISOString(),
            });
            return;
          }
          await pool.query('UPDATE canvas_nodes SET content=$1 WHERE id=$2', [msg.text, msg.node_id]);
          await insertCanvasEvent(currentRoomId, userCtx.user_id, 'node_text_changed', { node_id: msg.node_id, text: msg.text });
          const { classifyNodeText } = await import('../services/aiClassifier.js');
          classifyNodeText(msg.node_id, msg.text, currentRoomId, userCtx.user_id);
          return;
        }

        if (msg.type === 'node_acl_set') {
          const { canMutate } = await import('../services/rbac.js');
          const check = await canMutate(currentRoomId, userCtx.user_id, msg.node_id, 'write');
          if (!check.allowed) {
            ws.send(JSON.stringify({ type: 'error', code: 'RBAC_DENIED', message: check.reason }));
            const { logSecurityEvent } = await import('../services/rbac.js');
            await logSecurityEvent(currentRoomId, userCtx.user_id, msg.node_id, 'node_acl_set', check.reason);
            broadcastToLeads(currentRoomId, {
              type: 'security_violation',
              user_id: userCtx.user_id,
              username: userCtx.username,
              node_id: msg.node_id,
              attempted_action: 'node_acl_set',
              attempted_at: new Date().toISOString(),
            });
            return;
          }
          await pool.query('UPDATE canvas_nodes SET acl=$1 WHERE id=$2', [JSON.stringify(msg.acl), msg.node_id]);
          await insertCanvasEvent(currentRoomId, userCtx.user_id, 'node_acl_changed', { node_id: msg.node_id, acl: msg.acl });
          broadcastToRoom(currentRoomId, {
            type: 'event_log_entry',
            event: { event_type: 'node_acl_changed', payload: { node_id: msg.node_id, acl: msg.acl }, created_at: new Date().toISOString(), username: userCtx.username }
          });
          return;
        }

        if (msg.type === 'reconnect_sync') {
          const { getEventsAfter } = await import('../services/eventStore.js');
          const events = await getEventsAfter(currentRoomId, msg.last_event_id);
          ws.send(JSON.stringify({ type: 'missed_events', events }));
          return;
        }

        if (msg.type === 'voice_node_create') {
          const { canCreateNode } = await import('../services/rbac.js');
          const check = await canCreateNode(currentRoomId, userCtx.user_id);
          if (!check.allowed) {
            ws.send(JSON.stringify({ type: 'error', code: 'RBAC_DENIED', message: check.reason }));
            return;
          }

          const { processVoiceAction } = await import('../services/voiceAgent.js');
          await processVoiceAction(msg.text, currentRoomId, userCtx.user_id, msg.x, msg.y);
          return;
        }
      } catch (e) {
        console.error('WS handler error', e);
        ws.send(JSON.stringify({ type: 'error', code: 'INTERNAL', message: String(e.message) }));
      }
    });

    ws.on('close', async () => {
      if (userCtx && currentRoomId && rooms.has(currentRoomId)) {
        rooms.get(currentRoomId).delete(userCtx.user_id);
        if (rooms.get(currentRoomId).size === 0) rooms.delete(currentRoomId);
        await insertCanvasEvent(currentRoomId, userCtx.user_id, 'user_left', { username: userCtx.username });
        broadcastToRoom(currentRoomId, {
          type: 'event_log_entry',
          event: { event_type: 'user_left', payload: { username: userCtx.username }, created_at: new Date().toISOString(), username: userCtx.username }
        });
      }
    });
  });

  return wss;
}
