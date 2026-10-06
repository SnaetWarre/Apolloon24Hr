import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('default-labels');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

// The built-in labels are seeded outside replication, so a restart must leave the operator's edits alone.
test('a restart keeps renamed, edited and deleted built-in labels as the operator left them', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const builtIn = (name: string) => db.getLabels().find((label) => label.name === name)!;
    const defaultCount = db.getLabels().length;
    const blue = builtIn('Speedteam Blue');
    const hilok = builtIn('HILOK');
    const dames = builtIn('Dames');

    db.updateLabel(blue.id, { name: 'Speedteam Blauw' });
    db.updateLabel(hilok.id, { color: '#000000', kind: 'andere', imageUrl: null });
    assert.equal(db.deleteLabel(dames.id), true);
    db.closeDb();

    await db.initDb();
    const labels = db.getLabels();
    assert.equal(labels.length, defaultCount - 1);
    assert.equal(labels.find((label) => label.id === blue.id)?.name, 'Speedteam Blauw');
    assert.equal(
      labels.some((label) => label.name === 'Speedteam Blue'),
      false
    );
    const restartedHilok = labels.find((label) => label.id === hilok.id);
    assert.deepEqual(
      { color: restartedHilok?.color, kind: restartedHilok?.kind, imageUrl: restartedHilok?.imageUrl },
      { color: '#000000', kind: 'andere', imageUrl: null }
    );
    assert.equal(
      labels.some((label) => label.id === dames.id || label.name === 'Dames'),
      false
    );
  } finally {
    // Windows cannot delete a database file that is still open.
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
