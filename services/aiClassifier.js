import pool from '../db/pool.js';

const debounceMap = new Map(); // nodeId -> { timeout, lastText }

export async function classifyNodeText(nodeId, text, roomId, userId) {
  const key = `${roomId}:${nodeId}`;
  const existing = debounceMap.get(key);
  if (existing) clearTimeout(existing.timeout);

  debounceMap.set(key, {
    timeout: setTimeout(async () => {
      debounceMap.delete(key);
      try {
        const parsed = { label: 'reference', confidence: 0 };
        const label = parsed.label;
        const confidence = Number(parsed.confidence) || 0;

        if (label === 'action_item' && confidence > 0.7) {
          const r = await pool.query(
            'INSERT INTO tasks (room_id, canvas_node_id, content, author_id, intent_label) VALUES ($1,$2,$3,$4,$5) RETURNING *',
            [roomId, nodeId, text, userId, label]
          );
          const task = r.rows[0];
          const { broadcastToRoom } = await import('../ws/wsServer.js');
          broadcastToRoom(roomId, {
            type: 'task_created',
            task: {
              id: task.id,
              content: task.content,
              author: userId,
              canvas_node_id: task.canvas_node_id,
              intent_label: task.intent_label,
              created_at: task.created_at,
            }
          });
        }
      } catch (e) {
        console.error('AI classify error', e);
      }
    }, 800),
    lastText: text
  });
}

export async function classifyVoiceNode(nodeId, text, roomId, userId) {
  // No debounce for voice — already a complete thought
  try {
    const parsed = { label: 'reference', confidence: 0 };
    const label = parsed.label;
    const confidence = Number(parsed.confidence) || 0;

    console.log(`[AI Voice Classify] Label: ${label}, Confidence: ${confidence}, Text: "${text}"`);

    if ((label === 'action_item' || label === 'task') && confidence > 0.5) {
      const r = await pool.query(
        'INSERT INTO tasks (room_id, canvas_node_id, content, author_id, intent_label) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [roomId, nodeId, text, userId, label]
      );
      const task = r.rows[0];
      const { broadcastToRoom } = await import('../ws/wsServer.js');
      broadcastToRoom(roomId, {
        type: 'task_created',
        task: {
          id: task.id,
          content: task.content,
          author: userId,
          canvas_node_id: task.canvas_node_id,
          intent_label: task.intent_label,
          created_at: task.created_at,
        }
      });
    }
  } catch (e) {
    console.error('AI classify voice error', e);
  }
}
