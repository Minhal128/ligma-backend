import * as Y from 'yjs';
import { encodeStateAsUpdate, applyUpdate } from 'yjs';
import pool from '../db/pool.js';
import { insertCanvasEvent } from '../services/eventStore.js';

const yDocs = new Map(); // roomId -> Y.Doc
const yDocPromises = new Map(); // roomId -> Promise<Y.Doc>
const lastUpdateMap = new Map(); // roomId -> Map<nodeId, Map<userId, timestamp>>
const lastEditorMap = new Map(); // roomId:nodeId -> userId
const moveEventThrottle = new Map(); // roomId:nodeId:userId -> timestamp

// Helper to check if a record is a shape that should be logged/tracked
function isShapeRecord(record) {
  return record && record.typeName === 'shape';
}


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

    // Monitor changes for AI classification and event logging
    const yMap = doc.getMap('store');
    yMap.observe(async (event) => {
      const origin = event.transaction.origin;
      // We skip 'local-sync' and 'remote' only if we want to avoid loops, 
      // but in the backend, 'origin' should be the userId.
      if (!origin || origin === 'local-sync' || origin === 'remote') return;

      let username = null;
      try {
        const u = await pool.query('SELECT username FROM users WHERE id=$1', [origin]);
        username = u.rows[0]?.username || null;
      } catch (e) {
        console.error('Failed to fetch username for origin', origin, e);
      }

      const emitEvent = async (eventType, payload) => {
        try {
          const inserted = await insertCanvasEvent(roomId, origin, eventType, payload);
          const { broadcastToRoom } = await import('./wsServer.js');
          broadcastToRoom(roomId, {
            type: 'event_log_entry',
            event: {
              id: inserted.id,
              event_type: eventType,
              payload,
              created_at: inserted.created_at,
              user_id: origin,
              username,
            }
          });
        } catch (e) {
          console.error('Failed to emit realtime canvas event', e);
        }
      };

      const jobs = [];
      event.changes.keys.forEach((change, id) => {
        if (change.action === 'add' || change.action === 'update') {
          const record = yMap.get(id);
          const previous = change.oldValue;
          
          // Tldraw records have typeName, and shapes have type
          if (record && record.typeName === 'shape') {
            const nextText = record?.props?.text || '';
            const prevText = previous?.props?.text || '';
            const textChanged = nextText !== prevText;
            const moved = previous && (record.x !== previous.x || record.y !== previous.y);

            if (change.action === 'add') {
              jobs.push(emitEvent('node_created', { node_id: id, text: nextText, shape: record.type }));
            } else {
              if (textChanged) {
                jobs.push(emitEvent('node_text_changed', { node_id: id, text: nextText }));
              }
              if (moved) {
                const moveKey = `${roomId}:${id}:${origin}`;
                const now = Date.now();
                const last = moveEventThrottle.get(moveKey) || 0;
                if (now - last > 1000) {
                  moveEventThrottle.set(moveKey, now);
                  jobs.push(emitEvent('node_moved', { node_id: id, x: Math.round(record.x), y: Math.round(record.y) }));
                }
              }
            }

            if (nextText && textChanged) {
              // Store last editor for this node
              lastEditorMap.set(`${roomId}:${id}`, origin);
              jobs.push((async () => {
                const { classifyNodeText } = await import('../services/aiClassifier.js');
                await classifyNodeText(id, nextText, roomId, origin);
              })());
            }
          }
        } else if (change.action === 'delete') {
          const previous = change.oldValue;
          if (previous && previous.typeName === 'shape') {
            jobs.push(emitEvent('node_deleted', { node_id: id, text: previous?.props?.text || '', shape: previous.type }));
          }
        }
      });
      await Promise.allSettled(jobs);
    });

    // Save to DB periodically when it changes
    let saveTimeout = null;
    doc.on('update', () => {
      if (saveTimeout) return;
      saveTimeout = setTimeout(async () => {
        saveTimeout = null; // Clear first so next update can schedule
        try {
          const fullUpdate = Y.encodeStateAsUpdate(doc);
          const base64Update = Buffer.from(fullUpdate).toString('base64');
          await pool.query('UPDATE rooms SET yjs_state = $1 WHERE id = $2', [base64Update, roomId]);
          console.log(`[Yjs] Saved state for room ${roomId}`);
        } catch (err) {
          console.error('Failed to save yjs state to DB', err);
        }
      }, 1000); // Save at most once every 1 second
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
  const update = Y.encodeStateAsUpdate(doc);
  return Buffer.from(update).toString('base64');
}

export async function handleYjsUpdate(roomId, base64Update, userId) {
  const doc = await getYDoc(roomId);
  const update = new Uint8Array(Buffer.from(base64Update, 'base64'));
  
  // Apply update with userId as origin for the observer
  applyUpdate(doc, update, userId);
}
