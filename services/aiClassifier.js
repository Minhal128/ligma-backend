import OpenAI from 'openai';
import pool from '../db/pool.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const debounceMap = new Map(); // roomId:nodeId -> { timeout, lastText }

const CLASSIFICATION_PROMPT = `
Classify the following text from a collaborative workspace note into exactly one of these categories:
- action_item: A task or something someone needs to do.
- decision: A conclusion, agreement, or choice made by the team.
- open_question: A query, unknown, or something that needs more discussion.
- reference: General information, title, or label with no specific action.

Return ONLY a JSON object in this format:
{
  "label": "category_name",
  "confidence": 0.95,
  "assignee": "username or null",
  "due": "date/time or null"
}

Text: "{text}"
`;

async function updateNodeProps(roomId, nodeId, props) {
  try {
    const { getYDoc } = await import('../ws/yjsHandler.js');
    const doc = await getYDoc(roomId);
    const yMap = doc.getMap('store');
    const record = yMap.get(nodeId);
    
    if (record) {
      const updatedRecord = {
        ...record,
        props: {
          ...record.props,
          ...props
        }
      };
      yMap.set(nodeId, updatedRecord);
      
      // The yjsHandler's doc.on('update') will handle broadcasting and saving
    }
  } catch (e) {
    console.error('Failed to update node props after classification', e);
  }
}

export async function classifyNodeText(nodeId, text, roomId, userId) {
  if (!text || text.length < 5) return;
  if (!process.env.OPENAI_API_KEY) {
    console.warn('AI Classifier: No OPENAI_API_KEY found');
    return;
  }

  const key = `${roomId}:${nodeId}`;
  const existing = debounceMap.get(key);
  if (existing) {
    if (existing.lastText === text) return;
    clearTimeout(existing.timeout);
  }

  debounceMap.set(key, {
    timeout: setTimeout(async () => {
      debounceMap.delete(key);
      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: CLASSIFICATION_PROMPT.replace('{text}', text) }],
          response_format: { type: "json_object" }
        });

        const parsed = JSON.parse(response.choices[0].message.content);
        const label = parsed.label;
        const confidence = Number(parsed.confidence) || 0;
        const aiTag = {
          type: label,
          assignee: parsed.assignee || null,
          due: parsed.due || null,
          confidence,
          updated_at: new Date().toISOString(),
        };

        console.log(`[AI Classify] "${text}" -> ${label} (${confidence})`);

        if (confidence < 0.7) return;

        if (label === 'action_item') {
          // Check if task already exists for this node to avoid duplicates
          const exists = await pool.query('SELECT id FROM tasks WHERE canvas_node_id = $1', [nodeId]);
          if (exists.rows.length > 0) {
            await pool.query('UPDATE tasks SET content = $1 WHERE canvas_node_id = $2', [text, nodeId]);
          } else {
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
          // Action items could be red
          await updateNodeProps(roomId, nodeId, { color: 'red', aiTag });
        } 
        else if (label === 'decision') {
          // Decisions are blue
          await updateNodeProps(roomId, nodeId, { color: 'blue', aiTag });
        } 
        else if (label === 'open_question') {
          // Questions are orange/yellow
          await updateNodeProps(roomId, nodeId, { color: 'orange', aiTag });
        } else if (label === 'reference') {
          await updateNodeProps(roomId, nodeId, { aiTag });
        }
      } catch (e) {
        console.error('AI classify error', e);
      }
    }, 2000),
    lastText: text
  });
}

export async function classifyVoiceNode(nodeId, text, roomId, userId) {
  // Voice is already complete, no debounce needed
  classifyNodeText(nodeId, text, roomId, userId);
}
