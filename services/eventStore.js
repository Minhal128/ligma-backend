import pool from '../db/pool.js';

export async function insertCanvasEvent(roomId, userId, eventType, payload) {
  const r = await pool.query(
    'INSERT INTO canvas_events (room_id, user_id, event_type, payload) VALUES ($1,$2,$3,$4) RETURNING id,created_at',
    [roomId, userId, eventType, JSON.stringify(payload)]
  );
  return r.rows[0];
}

export async function getEventsAfter(roomId, lastEventId) {
  const r = await pool.query(
    'SELECT * FROM canvas_events WHERE room_id=$1 AND id > $2 ORDER BY id ASC LIMIT 500',
    [roomId, lastEventId || 0]
  );
  return r.rows;
}

export async function getEventsBefore(roomId, before) {
  const r = await pool.query(
    'SELECT * FROM canvas_events WHERE room_id=$1 AND created_at <= $2 ORDER BY id ASC LIMIT 500',
    [roomId, before]
  );
  return r.rows;
}

export async function getEventsForRoom(roomId, limit = 50) {
  const r = await pool.query(
    'SELECT ce.*, u.username FROM canvas_events ce LEFT JOIN users u ON ce.user_id = u.id WHERE ce.room_id=$1 ORDER BY ce.id DESC LIMIT $2',
    [roomId, limit]
  );
  return r.rows;
}
