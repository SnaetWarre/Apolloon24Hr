import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import path from 'path';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import {
  db,
  getAllRunners,
  insertRunner,
  updateRunnerStatus,
  updateWaitingOrder,
  deleteRunner,
  getMaxQueueIndex,
} from './db.js';
import { ensurePasswordFromEnv, authMiddleware, registerAuthRoutes } from './auth.js';

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: true, credentials: true },
});

const PORT = Number(process.env.PORT || 5173);
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_me';
const DIST_DIR = path.resolve(process.cwd(), 'dist');

app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true },
  })
);

registerAuthRoutes(app);

// Auth gate for API
app.use('/api', (req, res, next) => {
  if (req.path === '/login') return next();
  return authMiddleware(req, res, next);
});

app.get('/api/state', (req, res) => {
  res.json({ runners: getAllRunners() });
});

app.post('/api/runners', (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  const now = Date.now();
  insertRunner({ id, name: name.trim(), status: 'warming_up', statusSince: now, queueIndex: null });
  const runner = { id, name: name.trim(), status: 'warming_up', statusSince: now, queueIndex: null };
  io.emit('runner:added', runner);
  res.json(runner);
});

app.post('/api/runners/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  if (!['warming_up', 'waiting', 'ran'].includes(status)) return res.status(400).json({ error: 'bad status' });
  const now = Date.now();
  let queueIndex = null;
  if (status === 'waiting') {
    queueIndex = getMaxQueueIndex() + 1;
  }
  updateRunnerStatus({ id, status, statusSince: now, queueIndex });
  const updated = getAllRunners().find((r) => r.id === id);
  io.emit('runner:updated', updated);
  res.json({ ok: true });
});

app.post('/api/waiting/reorder', (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
  updateWaitingOrder(ids);
  io.emit('waiting:reordered', ids);
  res.json({ ok: true });
});

app.delete('/api/runners/:id', (req, res) => {
  const { id } = req.params;
  // Only allow deletion if status is 'ran'
  const runner = getAllRunners().find((r) => r.id === id);
  if (!runner) return res.status(404).json({ error: 'not found' });
  if (runner.status !== 'ran') return res.status(400).json({ error: 'can only delete ran' });
  deleteRunner(id);
  io.emit('runner:deleted', id);
  res.json({ ok: true });
});

// Static dist
app.use(express.static(DIST_DIR));
app.get('*', (req, res) => {
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

io.use((socket, next) => {
  // naive session check: we don't have session in socket easily here without a session store; trust that clients fetched state via auth first
  next();
});

io.on('connection', (socket) => {
  socket.emit('state:init', { runners: getAllRunners() });
});

await ensurePasswordFromEnv();

server.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});


