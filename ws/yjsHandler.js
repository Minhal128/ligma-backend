import * as Y from 'yjs';
import { encodeStateAsUpdate, applyUpdate } from 'yjs';
import pool from '../db/pool.js';

const yDocs = new Map(); // roomId -> Y.Doc
const lastUpdateMap = new Map(); // roomId -> Map<nodeId, Map<userId, timestamp>>

export function getYDoc(roomId) {
  if (!yDocs.has(roomId)) {
    const doc = new Y.Doc();
    yDocs.set(roomId, doc);
    lastUpdateMap.set(roomId, new Map());
  }
  return yDocs.get(roomId);
}

export function getYDocState(roomId) {
  const doc = getYDoc(roomId);
  const update = encodeStateAsUpdate(doc);
  return Buffer.from(update).toString('base64');
}

export async function handleYjsUpdate(roomId, base64Update, userId) {
  const doc = getYDoc(roomId);
  const update = new Uint8Array(Buffer.from(base64Update, 'base64'));

  // Detect concurrent edit conflicts before applying
  try {
    const tempDoc = new Y.Doc();
    applyUpdate(tempDoc, encodeStateAsUpdate(doc));
    applyUpdate(tempDoc, update);

    // Inspect shared structures for changes
    const ymap = tempDoc.getMap('nodes');
    if (ymap) {
      for (const [nodeId, nodeMap] of ymap.entries()) {
        if (nodeMap && typeof nodeMap.get === 'function') {
          const lastEditKey = `__last_edit_${nodeId}`;
          const prevMeta = doc.getMap('meta');
          const prevLast = prevMeta ? prevMeta.get(lastEditKey) : null;
          const now = Date.now();

          const nodeTimestamps = lastUpdateMap.get(roomId) || new Map();
          const userTs = nodeTimestamps.get(nodeId) || new Map();

          // Check if another user edited this node within 2000ms
          for (const [otherUserId, ts] of userTs.entries()) {
            if (otherUserId !== userId && now - ts < 2000) {
              // Conflict detected
              await pool.query(
                'INSERT INTO conflict_events (room_id, node_id, user_a, user_b) VALUES ($1,$2,$3,$4)',
                [roomId, nodeId, otherUserId, userId]
              );
              const countRes = await pool.query(
                'SELECT COUNT(*) as cnt FROM conflict_events WHERE room_id=$1 AND node_id=$2',
                [roomId, nodeId]
              );
              const count = Number(countRes.rows[0].cnt);
              const { broadcastToRoom } = await import('./wsServer.js');
              broadcastToRoom(roomId, {
                type: 'conflict_detected',
                node_id: nodeId,
                user_a: otherUserId,
                user_b: userId,
                count,
              });
            }
          }

          userTs.set(userId, now);
          nodeTimestamps.set(nodeId, userTs);
          lastUpdateMap.set(roomId, nodeTimestamps);

          const meta = doc.getMap('meta');
          meta.set(lastEditKey, { userId, ts: now });
        }
      }
    }
  } catch (e) {
    // Conflict detection is best-effort
    console.error('Conflict detection error', e);
  }

  applyUpdate(doc, update);
}
