import Groq from 'groq-sdk';
import pool from '../db/pool.js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const debounceMap = new Map(); // nodeId -> { timeout, lastText }

export async function classifyNodeText(nodeId, text, roomId, userId) {
  const key = `${roomId}:${nodeId}`;
  const existing = debounceMap.get(key);
  if (existing) clearTimeout(existing.timeout);

  debounceMap.set(key, {
    timeout: setTimeout(async () => {
      debounceMap.delete(key);
      try {
        const chat = await groq.chat.completions.create({
          model: 'llama3-8b-8192',
          messages: [
            {
              role: 'system',
              content: 'You are a classifier. Respond ONLY with valid JSON. No explanation.'
            },
            {
              role: 'user',
              content: `Classify this text into exactly one category: action_item, decision, open_question, or reference.\nText: '${text}'\nRespond with: {"label": "<category>", "confidence": <0-1>}`
            }
          ],
          temperature: 0,
          max_tokens: 64,
        });
        const raw = chat.choices[0]?.message?.content?.trim() || '{}';
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          const m = raw.match(/\{[\s\S]*?\}/);
          if (m) parsed = JSON.parse(m[0]);
          else parsed = {};
        }
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
    const chat = await groq.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [
        {
          role: 'system',
          content: 'You are a classifier. Respond ONLY with valid JSON. No explanation.'
        },
        {
          role: 'user',
          content: `Classify this text into exactly one category: action_item, decision, open_question, or reference.\nText: '${text}'\nRespond with: {"label": "<category>", "confidence": <0-1>}`
        }
      ],
      temperature: 0,
      max_tokens: 64,
    });
    const raw = chat.choices[0]?.message?.content?.trim() || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*?\}/);
      if (m) parsed = JSON.parse(m[0]);
      else parsed = {};
    }
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
