import assert from 'node:assert/strict';
import test from 'node:test';
import { temporaryDataPath } from './temporary-data.ts';

process.env.DATA_PATH = temporaryDataPath('activity');
process.env.NODE_ENV = 'test';

test('the activity log names the screen, and the laptop itself or the browser that made a change', async () => {
  const { describeOrigin } = await import('../server/activity.ts');
  assert.equal(describeOrigin('/timing', '127.0.0.1', '192.168.1.10'), 'Timing · laptop 192.168.1.10');
  assert.equal(describeOrigin('/admin', '::1', '192.168.1.10'), 'Beheer · laptop 192.168.1.10');
  assert.equal(describeOrigin('/queue', '::ffff:192.168.1.40', '192.168.1.10'), 'Wachtrij · browser 192.168.1.40');
  assert.equal(describeOrigin(undefined, '192.168.1.41', '192.168.1.10'), 'Ander scherm · browser 192.168.1.41');
});

test('activity pages include every entry when their boundary shares a timestamp', async () => {
  const db = await import('../server/db.ts');
  try {
    await db.initDb();
    for (let index = 0; index < 201; index++) {
      db.logActivity({ occurredAt: 1_000, action: 'runners.update', summary: String(index), origin: 'test' });
    }
    db.logActivity({ occurredAt: 999, action: 'runners.update', summary: 'older', origin: 'test' });
    const first = db.getActivity(200);
    const last = first[first.length - 1];
    const second = db.getActivity(200, { occurredAt: last.occurredAt, id: last.id });
    assert.equal(first.length, 200);
    assert.equal(second.length, 2);
    assert.equal(second[0].occurredAt, 1_000);
    assert.equal(second[1].occurredAt, 999);
    assert.equal(new Set([...first, ...second].map((entry) => entry.id)).size, 202);
  } finally {
    db.closeDb();
  }
});
