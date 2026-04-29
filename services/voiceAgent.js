import { broadcastToRoom } from '../ws/wsServer.js';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function processVoiceAction(transcript, roomId, userId, x, y) {
  // 1. Check if it's a question or a general query
  const isQuestion = transcript.toLowerCase().includes('?') || 
                     /^(who|what|where|when|why|how|is|are|can|could|should|will|would|do|does|did)\s+/i.test(transcript.trim());

  if (isQuestion) {
    console.log(`[VoiceAgent] Question detected: "${transcript}"`);
    try {
      // Get current canvas state for context
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
          { role: "system", content: "You are an AI assistant helping with a collaborative architecture diagram. Answer the user's question concisely based on the current diagram content. If the answer is not in the diagram, provide a helpful general response." },
          { role: "user", content: `Diagram Content:\n${context}\n\nUser Question: ${transcript}` }
        ]
      });

      const answer = response.choices[0].message.content;
      console.log(`[VoiceAgent] AI Answer: "${answer}"`);

      // Create a new sticky note with the answer near the user's cursor
      const actions = [{
        type: 'create',
        shape: 'note',
        content: `AI: ${answer}`,
        color: 'purple',
        x: x || 500,
        y: y || 500
      }];
      
      broadcastToRoom(roomId, { type: 'canvas_agent_actions', actions, user_id: userId });
      return;
    } catch (err) {
      console.error('[VoiceAgent] AI Question Error:', err);
      // Fallback to local processing if OpenAI fails
    }
  }

  // Normalize transcript (handle common voice mishearings)
  let text = transcript.toLowerCase()
    .replace(/^(?:now|please|just|okay|ok)\s+/g, '') // Strip filler words
    .replace(/creative/g, 'create a')
    .replace(/additionally/g, 'add')
    .replace(/write a name/g, 'write')
    .replace(/(?:right|ride|rode|road|wrote|type)\s+/g, 'write ')
    .replace(/in it|inside it|into it/g, '');

  console.log(`[VoiceAgent] Local Processing: "${text}"`);
  
  // Split by "and" or "then" to handle multiple actions
  const parts = text.split(/\s+and\s+|\s+then\s+/);
  let actions = [];

  parts.forEach(part => {
    part = part.trim();
    if (!part) return;

    // 1. CREATE Command
    const createMatch = part.match(/(?:create|add|draw)(?: a)?\s*(\w+)?\s*(box|note|circle|text|shape)(?:\s+(?:with|saying|text|called|named|name)\s+(.+))?/i);
    if (createMatch) {
      const color = createMatch[1] || 'blue';
      const shapeType = createMatch[2];
      const content = createMatch[3] || '';
      
      actions.push({
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

    // 2. DELETE Command
    const deleteMatch = part.match(/(?:delete|remove|erase)(?: the)?\s*(\w+)?\s*(box|note|circle|shape|text)/i);
    if (deleteMatch) {
      const color = deleteMatch[1];
      const shape = deleteMatch[2];
      actions.push({
        type: 'delete',
        target: `${color || ''} ${shape || ''}`.trim()
      });
      return;
    }

    // 3. MODIFY Command: "write minhal", "set text to hello"
    const modifyMatch = part.match(/(?:change|set|update|enter|write|type|say|call)(?: the| my| name)?\s*(.+)/i);
    if (modifyMatch) {
      const rest = modifyMatch[1].trim();
      // Try to split rest into [target] [content]
      // Patterns: "blue box to hello", "text to hello", "hello"
      const contentMatch = rest.match(/^(?:the\s+)?(\w+)?\s*(box|note|circle|shape)?\s*(?:text|to|is|as|be)?\s*(?:to|as|is|be)?\s*(.+)$/i);
      
      if (contentMatch) {
        const color = contentMatch[1];
        const shape = contentMatch[2];
        const content = contentMatch[3];
        const isColor = ['black','grey','white','blue','green','yellow','orange','red','purple'].includes(color);
        
        actions.push({
          type: 'modify',
          target: isColor ? `${color || ''} ${shape || ''}`.trim() : '',
          content: isColor ? content : `${color || ''} ${shape || ''} ${content || ''}`.trim()
        });
      } else {
        // Just the content (e.g. "write minhal")
        actions.push({
          type: 'modify',
          target: '',
          content: rest
        });
      }
    }
  });

  if (actions.length > 0) {
    console.log('[VoiceAgent] Local Actions generated:', actions);
    broadcastToRoom(roomId, { type: 'canvas_agent_actions', actions, user_id: userId });
  }
}

