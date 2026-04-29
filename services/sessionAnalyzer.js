import pool from '../db/pool.js';

export async function analyzeSession(roomId) {
  const eventsRes = await pool.query(
    'SELECT * FROM canvas_events WHERE room_id=$1 ORDER BY created_at ASC',
    [roomId]
  );
  const events = eventsRes.rows;

  const tasksRes = await pool.query(
    'SELECT t.*, u.username FROM tasks t LEFT JOIN users u ON t.author_id = u.id WHERE t.room_id=$1',
    [roomId]
  );
  const tasks = tasksRes.rows;

  const conflictsRes = await pool.query(
    'SELECT node_id, COUNT(*) as cnt FROM conflict_events WHERE room_id=$1 GROUP BY node_id ORDER BY cnt DESC',
    [roomId]
  );
  const conflictNodes = conflictsRes.rows;

  const participantsMap = new Map();
  const timelineMap = new Map();
  const decisions = [];
  const actionItems = [];
  const openQuestions = [];
  let totalEvents = events.length;

  let sessionStart = null;
  let sessionEnd = null;

  for (const e of events) {
    if (!sessionStart || e.created_at < sessionStart) sessionStart = e.created_at;
    if (!sessionEnd || e.created_at > sessionEnd) sessionEnd = e.created_at;

    const uid = e.user_id || 'unknown';
    if (!participantsMap.has(uid)) {
      participantsMap.set(uid, { user_id: uid, editCount: 0, nodesCreated: 0, tasksCreated: 0 });
    }
    const p = participantsMap.get(uid);
    p.editCount++;
    if (e.event_type === 'node_created' || e.event_type === 'node_created_via_voice') p.nodesCreated++;
    if (e.event_type === 'task_created') p.tasksCreated++;

    const hour = new Date(e.created_at).toISOString().slice(0, 13) + ':00';
    timelineMap.set(hour, (timelineMap.get(hour) || 0) + 1);
  }

  for (const t of tasks) {
    if (t.intent_label === 'decision') decisions.push(t.content);
    if (t.intent_label === 'action_item') actionItems.push({ content: t.content, author: t.author_id });
    if (t.intent_label === 'open_question') openQuestions.push(t.content);
  }

  const usernamesRes = await pool.query(
    'SELECT id, username FROM users WHERE id = ANY($1::uuid[])',
    [Array.from(participantsMap.keys()).filter(Boolean)]
  );
  const userMap = new Map(usernamesRes.rows.map(u => [u.id, u.username]));

  const participants = Array.from(participantsMap.values()).map(p => ({
    username: userMap.get(p.user_id) || p.user_id || 'unknown',
    editCount: p.editCount,
    nodesCreated: p.nodesCreated,
    tasksCreated: p.tasksCreated,
  }));

  const topContributor = participants.reduce((a, b) => (a.editCount > b.editCount ? a : b), participants[0]);

  const durationMs = sessionStart && sessionEnd ? new Date(sessionEnd) - new Date(sessionStart) : 0;
  const hours = Math.floor(durationMs / 3600000);
  const minutes = Math.floor((durationMs % 3600000) / 60000);

  const activityTimeline = Array.from(timelineMap.entries())
    .map(([hour, eventCount]) => ({ hour, eventCount }))
    .sort((a, b) => a.hour.localeCompare(b.hour));

  const summary = {
    totalEvents,
    sessionDuration: `${hours}h ${minutes}m`,
    participants,
    topContributor: topContributor?.username || 'none',
    decisions,
    actionItems,
    openQuestions,
    conflictNodes: conflictNodes.map(c => c.node_id),
    activityTimeline,
  };

  let aiBrief = {};

  // Compute collaboration score: higher when edits are evenly distributed
  let collaborationScore = 50;
  if (participants.length > 1) {
    const edits = participants.map(p => p.editCount);
    const total = edits.reduce((a, b) => a + b, 0) || 1;
    const avg = total / edits.length;
    const variance = edits.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / edits.length;
    const std = Math.sqrt(variance);
    // Lower std relative to avg = more even distribution = higher score
    const evenness = Math.max(0, 1 - std / (avg || 1));
    collaborationScore = Math.round(50 + evenness * 50);
  }

  return {
    ...summary,
    executiveSummary: aiBrief.executiveSummary || 'No summary generated.',
    keyDecisions: aiBrief.keyDecisions || decisions,
    assignedTasks: aiBrief.assignedTasks || actionItems.map(a => ({ task: a.content, suggestedOwner: a.author })),
    openQuestions: aiBrief.openQuestions || openQuestions,
    collaborationScore: aiBrief.collaborationScore || collaborationScore,
    riskFlags: aiBrief.riskFlags || [],
  };
}
