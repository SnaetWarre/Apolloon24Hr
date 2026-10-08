import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { temporaryDataPath } from './temporary-data.ts';

process.env.DATA_PATH = temporaryDataPath('export-downloads');
process.env.NODE_ENV = 'test';

test('every JSON export arrives as a file, so the desktop window stays on Analyse', async () => {
  const db = await import('../server/db.ts');
  const { registerExportRoutes } = await import('../server/exports.ts');
  await db.initDb();
  const app = express();
  registerExportRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    for (const [route, fileName] of [
      ['laps.json', 'apolloon-laps.json'],
      ['events.json', 'apolloon-events.json'],
      ['current-state.json', 'apolloon-current-state.json'],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/export/${route}`);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get('content-disposition'), `attachment; filename="${fileName}"`);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
      await response.json();
    }
  } finally {
    server.close();
    db.closeDb();
  }
});
