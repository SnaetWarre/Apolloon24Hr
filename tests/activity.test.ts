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

test('a profile save that only changes the notes names only the notes', async () => {
  const db = await import('../server/db.ts');
  const { describeWrite } = await import('../server/activity.ts');
  try {
    await db.initDb();
    const runner = db.insertRunner({
      name: 'Noor',
      runnerNumber: '7',
      labels: ['Hilok'],
      registrationDetails: { phone: '0470 12 34 56', availableHours: ['22:00'] },
    });
    // The profile sends every field, with labels as ids.
    const input = {
      id: runner.id,
      fields: {
        runnerNumber: '7',
        name: 'Noor',
        notes: 'Komt pas om 22u',
        registrationDetails: { phone: '0470 12 34 56', email: '', availableHours: ['22:00'] },
        labels: runner.labels.map((label) => label.id),
      },
    };
    const describe = describeWrite('runners.update', input);
    const result = db.updateRunner(runner.id, input.fields);
    assert.equal(describe?.(result), '#7 Noor aangepast (notities)');
  } finally {
    db.closeDb();
  }
});
