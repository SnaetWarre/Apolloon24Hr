import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import Papa from 'papaparse';

import {
  initDb,
  getAllRunners,
  getRunnerById,
  insertRunner,
  updateRunner,
  updateRunnerStatus,
  updateWaitingOrder,
  deleteRunner,
  hideRunnerInQueue,
  unhideRunnerInQueue,
  getLabels,
  createLabel,
  updateLabel,
  deleteLabel,
  getRaceState,
  getAllLaps,
  performHandoff,
  undoLastHandoff,
  finishRace,
  upsertRunnerFromImport,
} from './db.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: true, credentials: false },
});

const PORT = Number(process.env.PORT || 5173);
const HOST_IP_HINT = process.env.HOST_IP_HINT || '192.168.24.10';
const DIST_DIR = path.resolve(__dirname, '..', 'dist');

app.use(express.json({ limit: '10mb' }));

function appState() {
  return {
    runners: getAllRunners(),
    labels: getLabels(),
    race: getRaceState(),
    laps: getAllLaps(),
    serverNowMs: Date.now(),
    host: {
      hostIpHint: HOST_IP_HINT,
      port: PORT,
      url: `http://${HOST_IP_HINT}:${PORT}`,
    },
  };
}

function emitState(eventName, payload = null) {
  const state = appState();
  io.emit('state:changed', state);
  if (eventName) {
    io.emit(eventName, payload ?? state);
  }
  return state;
}

function cleanText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function parsePositiveInt(value) {
  const text = cleanText(value);
  if (!text) return null;
  const n = Number(text.replace(',', '.'));
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

function parseDurationMs(value) {
  const text = cleanText(value);
  if (!text) return null;
  if (text.includes(':')) {
    const parts = text.split(':').map((part) => Number(part.replace(',', '.')));
    if (parts.some((part) => !Number.isFinite(part))) return null;
    if (parts.length === 2) {
      return Math.round((parts[0] * 60 + parts[1]) * 1000);
    }
    if (parts.length === 3) {
      return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
    }
    return null;
  }
  const seconds = Number(text.replace(',', '.'));
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

function splitLabels(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => cleanText(item).split(/[,;|]/))
    .map((label) => label.trim())
    .filter((label) => {
      if (!label) return false;
      const normalized = label.toLowerCase();
      return !['nee', 'neen', 'geen', 'n/a', 'na', 'none', '-', 'ja'].includes(normalized);
    });
}

function getRowValue(row, names) {
  const entries = Object.entries(row || {}).map(([key, value]) => [
    String(key).trim().toLowerCase().replace(/\s+/g, '_'),
    value,
  ]);
  const map = new Map(entries);
  for (const name of names) {
    const value = map.get(name);
    if (value !== undefined && cleanText(value)) return value;
  }
  return '';
}

function formatDurationMs(ms) {
  if (ms === undefined || ms === null || Number.isNaN(Number(ms))) return '';
  const totalCentiseconds = Math.max(0, Math.floor(Number(ms) / 10));
  const centiseconds = totalCentiseconds % 100;
  const totalWholeSeconds = Math.floor(totalCentiseconds / 100);
  const hours = Math.floor(totalWholeSeconds / 3600);
  const minutes = Math.floor((totalWholeSeconds % 3600) / 60);
  const seconds = totalWholeSeconds % 60;
  const fraction = String(centiseconds).padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${fraction}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}.${fraction}`;
}

function lapExportRows() {
  const runnersById = new Map(getAllRunners().map((runner) => [runner.id, runner]));
  return getAllLaps()
    .slice()
    .reverse()
    .map((lap) => {
      const runner = runnersById.get(lap.runnerId);
      return {
        timestamp: new Date(lap.finishedAt).toISOString(),
        runner_number: lap.runnerNumber || '',
        name: lap.runnerName,
        lap_number: lap.lapNumber,
        lap_time_ms: lap.durationMs,
        lap_time_readable: formatDurationMs(lap.durationMs),
        labels: (lap.labels || []).map((label) => label.name).join(', '),
        target_laps: runner?.targetLaps ?? '',
        historical_avg_ms: runner?.historicalAvgMs ?? '',
        historical_best_ms: runner?.historicalBestMs ?? '',
        source: lap.source,
      };
    });
}

const LAP_EXPORT_COLUMNS = [
  'timestamp',
  'runner_number',
  'name',
  'lap_number',
  'lap_time_ms',
  'lap_time_readable',
  'labels',
  'target_laps',
  'historical_avg_ms',
  'historical_best_ms',
  'source',
];

app.get('/api/state', (req, res) => {
  res.json(appState());
});

app.get('/api/time', (req, res) => {
  res.json({ serverNowMs: Date.now() });
});

app.get('/api/host-info', (req, res) => {
  res.json({
    hostIpHint: HOST_IP_HINT,
    port: PORT,
    url: `http://${HOST_IP_HINT}:${PORT}`,
  });
});

app.post('/api/runners', (req, res) => {
  try {
    const runner = insertRunner(req.body || {});
    const state = emitState('runner:upserted', runner);
    res.json({ runner, state });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'failed to create runner' });
  }
});

app.patch('/api/runners/:id', (req, res) => {
  try {
    const runner = updateRunner(req.params.id, req.body || {});
    if (!runner) return res.status(404).json({ error: 'runner not found' });
    const state = emitState('runner:upserted', runner);
    res.json({ runner, state });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'failed to update runner' });
  }
});

app.post('/api/runners/:id/status', (req, res) => {
  try {
    const runner = updateRunnerStatus({
      id: req.params.id,
      status: req.body?.status,
      statusSince: Date.now(),
    });
    if (!runner) return res.status(404).json({ error: 'runner not found' });
    const state = emitState('queue:updated', { runnerId: req.params.id, status: req.body?.status });
    res.json({ runner, state });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'failed to update status' });
  }
});

app.delete('/api/runners/:id', (req, res) => {
  const runner = getRunnerById(req.params.id);
  if (!runner) return res.status(404).json({ error: 'runner not found' });
  if (runner.status === 'running') {
    return res.status(409).json({ error: 'Actieve loper kan niet verwijderd worden' });
  }
  if (runner.lapCount > 0) {
    return res.status(409).json({ error: 'Lopers met rondes blijven bewaard voor analyse' });
  }
  deleteRunner(req.params.id);
  const state = emitState('runner:deleted', req.params.id);
  res.json({ ok: true, state });
});

app.get('/api/labels', (req, res) => {
  res.json({ labels: getLabels() });
});

app.post('/api/labels', (req, res) => {
  try {
    const label = createLabel(req.body || {});
    const state = emitState('labels:updated', label);
    res.json({ label, state });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'failed to create label' });
  }
});

app.patch('/api/labels/:id', (req, res) => {
  try {
    const label = updateLabel(req.params.id, req.body || {});
    if (!label) return res.status(404).json({ error: 'label not found' });
    const state = emitState('labels:updated', label);
    res.json({ label, state });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'failed to update label' });
  }
});

app.delete('/api/labels/:id', (req, res) => {
  deleteLabel(req.params.id);
  const state = emitState('labels:updated', req.params.id);
  res.json({ ok: true, state });
});

app.post('/api/import/runners-csv', (req, res) => {
  const csvText = cleanText(req.body?.csvText);
  if (!csvText) {
    return res.status(400).json({ error: 'csvText required' });
  }

  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  if (parsed.errors?.length) {
    return res.status(400).json({ error: parsed.errors[0].message });
  }

  const summary = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  for (const [index, row] of parsed.data.entries()) {
    const runnerNumber = cleanText(
      getRowValue(row, ['runner_number', 'lopersnummer', 'nummer', 'number', 'bib'])
    );
    const name = cleanText(getRowValue(row, ['name', 'naam', 'runner_name', 'loper']));

    if (!runnerNumber || !name) {
      summary.skipped += 1;
      summary.errors.push(`Rij ${index + 2}: runner_number en name zijn verplicht`);
      continue;
    }

    try {
      const labelValues = [
        getRowValue(row, ['labels', 'label', 'categorie', 'categories', 'type']),
        getRowValue(row, ['zustervereniging', 'vereniging', 'club']),
        getRowValue(row, ['team', 'speedteam']),
        getRowValue(row, ['jaar', 'groep']),
      ];
      const result = upsertRunnerFromImport({
        runnerNumber,
        name,
        labels: splitLabels(labelValues),
        targetLaps: parsePositiveInt(getRowValue(row, ['target_laps', 'doelstelling', 'target'])),
        historicalAvgMs: parseDurationMs(
          getRowValue(row, ['historical_avg', 'gemiddelde', 'avg', 'average'])
        ),
        historicalBestMs: parseDurationMs(
          getRowValue(row, ['historical_best', 'snelste', 'best', 'fastest'])
        ),
        status: 'registered',
        registrationSource: 'import',
      });
      if (result.action === 'updated') summary.updated += 1;
      else summary.created += 1;
    } catch (err) {
      summary.skipped += 1;
      summary.errors.push(
        `Rij ${index + 2}: ${err instanceof Error ? err.message : 'import mislukt'}`
      );
    }
  }

  const state = emitState('runner:upserted');
  res.json({ ok: true, summary, state });
});

app.post('/api/queue/reorder', (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
  updateWaitingOrder(ids);
  const state = emitState('queue:updated', ids);
  res.json({ ok: true, state });
});

app.post('/api/waiting/reorder', (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
  updateWaitingOrder(ids);
  const state = emitState('queue:updated', ids);
  res.json({ ok: true, state });
});

app.post('/api/queue/status', (req, res) => {
  try {
    const id = cleanText(req.body?.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    const runner = updateRunnerStatus({ id, status: req.body?.status, statusSince: Date.now() });
    if (!runner) return res.status(404).json({ error: 'runner not found' });
    const state = emitState('queue:updated', { runnerId: id, status: req.body?.status });
    res.json({ runner, state });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'failed to update status' });
  }
});

app.post('/api/queue/hide', (req, res) => {
  try {
    const id = cleanText(req.body?.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    const current = getRunnerById(id);
    if (!current) return res.status(404).json({ error: 'runner not found' });
    if (current.status !== 'ran') {
      return res.status(409).json({ error: 'Alleen gelopen lopers kunnen verborgen worden' });
    }
    const runner = hideRunnerInQueue(id, Date.now());
    const state = emitState('queue:updated', { runnerId: id, hidden: true });
    res.json({ runner, state });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'failed to hide runner' });
  }
});

app.post('/api/queue/unhide', (req, res) => {
  try {
    const id = cleanText(req.body?.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    const current = getRunnerById(id);
    if (!current) return res.status(404).json({ error: 'runner not found' });
    const runner = unhideRunnerInQueue(id);
    const state = emitState('queue:updated', { runnerId: id, hidden: false });
    res.json({ runner, state });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'failed to unhide runner' });
  }
});

app.get('/api/race/state', (req, res) => {
  res.json({ race: getRaceState() });
});

app.post('/api/race/start-next', (req, res) => {
  if (getRaceState().activeRunnerId) {
    return res.status(409).json({ error: 'Er loopt al een loper' });
  }
  const result = performHandoff(Date.now());
  if (!result.ok) return res.status(409).json(result);
  const state = emitState('race:state-updated', result);
  res.json({ ...result, state });
});

app.post('/api/race/handoff', (req, res) => {
  const result = performHandoff(Date.now());
  if (!result.ok) return res.status(409).json(result);
  const state = emitState('race:state-updated', result);
  if (result.lapId) io.emit('lap:created', result);
  res.json({ ...result, state });
});

app.post('/api/race/undo-last-handoff', (req, res) => {
  const result = undoLastHandoff();
  if (!result.ok) return res.status(409).json(result);
  const state = emitState('lap:undone', result);
  res.json({ ...result, state });
});

app.post('/api/race/finish', (req, res) => {
  finishRace(Date.now());
  const state = emitState('race:state-updated');
  res.json({ ok: true, state });
});

app.get('/api/export/laps.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="apolloon-laps.csv"');
  const rows = lapExportRows();
  res.send(
    rows.length
      ? Papa.unparse(rows, { header: true, columns: LAP_EXPORT_COLUMNS })
      : `${LAP_EXPORT_COLUMNS.join(',')}\n`
  );
});

app.get('/api/export/laps.json', (req, res) => {
  res.json({ laps: getAllLaps() });
});

app.get('/api/export/current-state.json', (req, res) => {
  res.json(appState());
});

app.use(express.static(DIST_DIR));
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

io.on('connection', (socket) => {
  socket.emit('state:init', appState());
});

await initDb();

server.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  console.log(`Static event URL: http://${HOST_IP_HINT}:${PORT}`);
});
