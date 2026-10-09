import assert from 'node:assert/strict';
import test from 'node:test';
import { temporaryDataPath } from './temporary-data.ts';

process.env.DATA_PATH = temporaryDataPath('activity');
process.env.NODE_ENV = 'test';

test('the activity log names the screen, and the laptop itself or the browser that made a change', async () => {
  const { describeOrigin } = await import('../server/activity.ts');
  assert.equal(describeOrigin('/timing', '127.0.0.1', '192.168.1.10'), 'Timing · laptop 192.168.1.10');
  assert.equal(describeOrigin('/admin', '::1', '192.168.1.10'), 'Beheer · laptop 192.168.1.10');
  assert.equal(
    describeOrigin('/timing', '127.0.0.1', '192.168.1.10', 'LAPTOP-TIJD'),
    'Timing · laptop LAPTOP-TIJD (192.168.1.10)'
  );
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

test('activity pages filter queue moves and the search before they are cut', async () => {
  const db = await import('../server/db.ts');
  const { getDb } = await import('../server/db/connection.ts');
  try {
    await db.initDb();
    getDb().exec('DELETE FROM activity_log');
    let at = 1_000;
    const log = (action: string, summary: string) =>
      db.logActivity({ occurredAt: at++, action, summary, origin: 'Beheer · laptop LAPTOP-0' });
    log('runners.delete', '#3 Zoë Peeters verwijderd');
    log('runners.update', '#4 Bram aangepast (notities)');
    log('runners.delete', '#5 Céline Maes verwijderd');
    // A long stretch of racing logs nothing but queue moves.
    for (let index = 0; index < 300; index++) {
      log(index % 3 ? 'runners.setStatus' : 'runners.reorder', `#${index} naar de wachtrij`);
    }

    // Without queue moves, the first page reaches back past all of them.
    const first = db.getActivity(2, null, { queueMoves: false });
    assert.deepEqual(
      first.map((entry) => entry.summary),
      ['#5 Céline Maes verwijderd', '#4 Bram aangepast (notities)']
    );
    const last = first[first.length - 1];
    const second = db.getActivity(2, { occurredAt: last.occurredAt, id: last.id }, { queueMoves: false });
    assert.deepEqual(
      second.map((entry) => entry.summary),
      ['#3 Zoë Peeters verwijderd']
    );

    // The search ignores case and accents, and also looks at the origin.
    assert.deepEqual(
      db.getActivity(200, null, { search: ' ZOE ' }).map((entry) => entry.summary),
      ['#3 Zoë Peeters verwijderd']
    );
    const verwijderd = db.getActivity(1, null, { search: 'verwijderd' });
    assert.deepEqual(
      verwijderd.map((entry) => entry.summary),
      ['#5 Céline Maes verwijderd']
    );
    const cursor = { occurredAt: verwijderd[0].occurredAt, id: verwijderd[0].id };
    assert.deepEqual(
      db.getActivity(1, cursor, { search: 'verwijderd' }).map((entry) => entry.summary),
      ['#3 Zoë Peeters verwijderd']
    );
    assert.equal(db.getActivity(500, null, { search: 'laptop-0' }).length, 303);
    assert.equal(db.getActivity(200, null, { search: 'niemand' }).length, 0);

    // Queue moves stay in the list when asked for.
    assert.equal(db.getActivity(500, null, { queueMoves: true }).length, 303);
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

test('undoing a handoff names the lap it removes, on the runner the lap was moved to', async () => {
  const db = await import('../server/db.ts');
  const { describeWrite } = await import('../server/activity.ts');
  try {
    await db.initDb();
    const [anna, bert] = ['Anna', 'Bert'].map((name, index) => {
      const runner = db.insertRunner({ name, runnerNumber: String(21 + index) });
      db.updateRunnerStatus({ id: runner.id, status: 'waiting', statusSince: index, queueIndex: index });
      return runner;
    });
    db.performHandoff(1_000);
    db.performHandoff(81_000);
    const [lap] = db.getAllLaps();
    assert.equal(lap.runnerId, anna.id);
    db.moveLap(lap.id, bert.id);

    const describe = describeWrite('race.undoLastHandoff', {});
    assert.ok(db.undoLastHandoff().ok);
    assert.match(
      describe?.(null) ?? '',
      /^Laatste wissel ongedaan gemaakt \(Ronde 1 van #22 Bert \(1:20\.000, .+\) verwijderd\)$/
    );

    // A lap already deleted in Beheer › Rondes is not named again.
    db.performHandoff(81_000);
    db.deleteLap(db.getAllLaps()[0].id);
    const afterDelete = describeWrite('race.undoLastHandoff', {});
    assert.ok(db.undoLastHandoff().ok);
    assert.equal(afterDelete?.(null), 'Laatste wissel ongedaan gemaakt');
  } finally {
    db.closeDb();
  }
});
