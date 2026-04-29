import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import dotenv from 'dotenv';
import { setupWebSocket } from './ws/wsServer.js';
import authRoutes from './routes/auth.js';
import roomRoutes from './routes/rooms.js';
import taskRoutes from './routes/tasks.js';
import eventRoutes from './routes/events.js';
import sessionReportRoutes from './routes/session-report.js';
import pool from './db/pool.js';

dotenv.config();

const app = express();
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/session-report', sessionReportRoutes);

app.get('/api/conflicts/:roomId', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    const jwt = await import('jsonwebtoken');
    jwt.default.verify(token, process.env.JWT_SECRET || 'ligma-secret');
    const r = await pool.query(
      'SELECT * FROM conflict_events WHERE room_id=$1 ORDER BY resolved_at DESC',
      [req.params.roomId]
    );
    res.json(r.rows);
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.get('/api/security-events/:roomId', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    const jwt = await import('jsonwebtoken');
    jwt.default.verify(token, process.env.JWT_SECRET || 'ligma-secret');
    const r = await pool.query(
      `SELECT se.*, u.username FROM security_events se
       LEFT JOIN users u ON se.user_id = u.id
       WHERE se.room_id=$1 ORDER BY se.attempted_at DESC LIMIT 100`,
      [req.params.roomId]
    );
    res.json(r.rows);
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/', (_req, res) => res.send('Ligma codebase is running'));

const server = createServer(app);
setupWebSocket(server);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`LIGMA server listening on ${PORT}`);
});
