import * as Y from 'yjs';
import { encodeStateAsUpdate, applyUpdate } from 'yjs';
import pool from '../db/pool.js';

const yDocs = new Map(); // roomId -> Y.Doc
const yDocPromises = new Map(); // roomId -> Promise<Y.Doc>
const lastUpdateMap = new Map(); // roomId -> Map<nodeId, Map<userId, timestamp>>

export async function getYDoc(roomId) {
  if (yDocs.has(roomId)) return yDocs.get(roomId);
  if (yDocPromises.has(roomId)) return yDocPromises.get(roomId);

  const promise = (async () => {
    const doc = new Y.Doc();
    lastUpdateMap.set(roomId, new Map());
    try {
      const res = await pool.query('SELECT yjs_state FROM rooms WHERE id = $1', [roomId]);
      if (res.rows.length && res.rows[0].yjs_state) {
        const update = new Uint8Array(Buffer.from(res.rows[0].yjs_state, 'base64'));
        applyUpdate(doc, update);
      }
    } catch (e) {
      console.error('Failed to load yjs state from DB', e);
    }
    
    // Save to DB periodically when it changes
    doc.on('update', async (updateMsg) => {
      try {
        const fullUpdate = encodeStateAsUpdate(doc);
        const base64Update = Buffer.from(fullUpdate).toString('base64');
        await pool.query('UPDATE rooms SET yjs_state = $1 WHERE id = $2', [base64Update, roomId]);
      } catch (err) {
        console.error('Failed to save yjs state to DB', err);
      }
    });

    yDocs.set(roomId, doc);
    yDocPromises.delete(roomId);
    return doc;
  })();
  
  yDocPromises.set(roomId, promise);
  return promise;
}

export async function getYDocState(roomId) {
  const doc = await getYDoc(roomId);
  const update = encodeStateAsUpdate(doc);
  return Buffer.from(update).toString('base64');
}

export async function handleYjsUpdate(roomId, base64Update, userId) {
  const doc = await getYDoc(roomId);
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
