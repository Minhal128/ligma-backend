import Groq from 'groq-sdk';
import { broadcastToRoom } from '../ws/wsServer.js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function processVoiceAction(transcript, roomId, userId, x, y) {
  // Normalize transcript (handle common voice mishearings)
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
