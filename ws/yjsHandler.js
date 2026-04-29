import * as Y from 'yjs';
import { encodeStateAsUpdate, applyUpdate } from 'yjs';
import pool from '../db/pool.js';

const yDocs = new Map(); // roomId -> Y.Doc
const yDocPromises = new Map(); // roomId -> Promise<Y.Doc>
const lastUpdateMap = new Map(); // roomId -> Map<nodeId, Map<userId, timestamp>>
const lastEditorMap = new Map(); // roomId:nodeId -> userId

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

    // Monitor changes for AI classification
    const yMap = doc.getMap('store');
    yMap.observe(async (event) => {
      const origin = event.transaction.origin;
      if (!origin) return; // Skip initial load or system updates

      event.changes.keys.forEach(async (change, id) => {
        if (change.action === 'add' || change.action === 'update') {
          const record = yMap.get(id);
          if (record && record.props && record.props.text) {
            // Store last editor for this node
            lastEditorMap.set(`${roomId}:${id}`, origin);
            
            const { classifyNodeText } = await import('../services/aiClassifier.js');
            classifyNodeText(id, record.props.text, roomId, origin);
          }
        }
      });
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
