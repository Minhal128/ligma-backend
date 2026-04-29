import { broadcastToRoom } from '../ws/wsServer.js';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function processVoiceAction(transcript, roomId, userId, x, y) {
  // Normalize transcript (handle common voice mishearings)
  let normalized = transcript.toLowerCase()
    .replace(/^(?:now|please|just|okay|ok)\s+/g, '') // Strip filler words
    .replace(/creative/g, 'create a')
    .replace(/additionally/g, 'add')
    .replace(/write a name/g, 'write')
    .replace(/(?:right|ride|rode|road|wrote|type)\s+/g, 'write ')
    .replace(/in it|inside it|into it/g, '');

  console.log(`[VoiceAgent] Processing: "${transcript}" (normalized: "${normalized}")`);
  
  // 1. Try Local Regex Processing First (Fast)
  const parts = normalized.split(/\s+and\s+|\s+then\s+/);
  let localActions = [];

  parts.forEach(part => {
    part = part.trim();
    if (!part) return;

    // CREATE Command
    const createMatch = part.match(/(?:create|add|draw)(?: a)?\s*(\w+)?\s*(box|note|circle|text|shape)(?:\s+(?:with|saying|text|called|named|name)\s+(.+))?/i);
    if (createMatch) {
      const color = createMatch[1] || 'blue';
      const shapeType = createMatch[2];
      const content = createMatch[3] || '';
      localActions.push({
        type: 'create',
        shape: shapeType === 'note' ? 'note' : 'geo',
        content: content.trim(),
        color: ['black','grey','white','blue','green','yellow','orange','red','purple'].includes(color) ? color : 'blue',
        x: x || 500,
        y: y || 500,
        props: { geo: shapeType === 'circle' ? 'ellipse' : 'rectangle' }
      });
      return;
    }

    // DELETE Command
    const deleteMatch = part.match(/(?:delete|remove|erase)(?: the)?\s*(\w+)?\s*(box|note|circle|shape|text)/i);
    if (deleteMatch) {
      const color = deleteMatch[1];
      const shape = deleteMatch[2];
      localActions.push({ type: 'delete', target: `${color || ''} ${shape || ''}`.trim() });
      return;
    }

    // MODIFY Command
    const modifyMatch = part.match(/(?:change|set|update|enter|write|type|say|call)(?: the| my| name)?\s*(.+)/i);
    if (modifyMatch) {
      const rest = modifyMatch[1].trim();
      const contentMatch = rest.match(/^(?:the\s+)?(\w+)?\s*(box|note|circle|shape)?\s*(?:text|to|is|as|be)?\s*(?:to|as|is|be)?\s*(.+)$/i);
      if (contentMatch) {
        const color = contentMatch[1];
        const shape = contentMatch[2];
        const content = contentMatch[3];
        const isColor = ['black','grey','white','blue','green','yellow','orange','red','purple'].includes(color);
        localActions.push({
          type: 'modify',
          target: isColor ? `${color || ''} ${shape || ''}`.trim() : '',
          content: isColor ? content : `${color || ''} ${shape || ''} ${content || ''}`.trim()
        });
      } else {
        localActions.push({ type: 'modify', target: '', content: rest });
      }
    }
  });

  if (localActions.length > 0) {
    console.log('[VoiceAgent] Local Actions generated:', localActions);
    broadcastToRoom(roomId, { type: 'canvas_agent_actions', actions: localActions, user_id: userId });
    return;
  }

  // 2. Fallback to AI Processing (Smart)
  console.log(`[VoiceAgent] No local match. Falling back to AI for: "${transcript}"`);
  try {
    const { getYDoc } = await import('../ws/yjsHandler.js');
    const doc = await getYDoc(roomId);
    const yMap = doc.getMap('store');
    
    const shapes = [];
    yMap.forEach((record) => {
      if (record && record.typeName === 'shape') {
        shapes.push({
          type: record.type,
          text: record.props?.text || '',
          color: record.props?.color || 'default',
          position: { x: record.x, y: record.y }
        });
      }
    });

    const context = shapes.map(s => `[${s.type} ${s.color}] "${s.text}" at (${Math.round(s.position.x)}, ${Math.round(s.position.y)})`).join('\n');
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a canvas assistant. Interpret the user's intent. \nIf it's a question, answer it concisely.\nIf it's a command like 'create a blue box' (even if misspelled like 'bob'), output JSON in this format: {\"actions\": [{\"type\": \"create\", \"shape\": \"geo\", \"color\": \"blue\", \"content\": \"\"}]}. \nValid shapes: note, box, circle, text. Valid colors: black, grey, white, blue, green, yellow, orange, red, purple. \nAnswer strictly as JSON for commands, or plain text for questions." },
        { role: "user", content: `Context:\n${context}\n\nTranscript: ${transcript}` }
      ]
    });

    const aiMsg = response.choices[0].message.content;
    
    // Check if it's JSON (a command)
    if (aiMsg.trim().startsWith('{')) {
      try {
        const data = JSON.parse(aiMsg);
        if (data.actions) {
          const processedActions = data.actions.map(a => ({
            ...a,
            x: x || 500,
            y: y || 500,
            shape: a.shape === 'note' ? 'note' : 'geo',
            props: { geo: a.shape === 'circle' ? 'ellipse' : 'rectangle' }
          }));
          console.log('[VoiceAgent] AI Actions generated:', processedActions);
          broadcastToRoom(roomId, { type: 'canvas_agent_actions', actions: processedActions, user_id: userId });
          return;
        }
      } catch (e) {
        console.error('[VoiceAgent] AI JSON Parse Error:', e);
      }
    }

    // Otherwise treat as a question/answer
    console.log(`[VoiceAgent] AI Answer: "${aiMsg}"`);
    const answerActions = [{
      type: 'create',
      shape: 'note',
      content: `AI: ${aiMsg}`,
      color: 'purple',
      x: x || 500,
      y: y || 500
    }];
    broadcastToRoom(roomId, { type: 'canvas_agent_actions', actions: answerActions, user_id: userId });

  } catch (err) {
    console.error('[VoiceAgent] AI Fallback Error:', err);
  }
}

