import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import Papa from 'papaparse';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('runner-import');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

test('Google Form import keeps every answer and preserves an existing runner on repeat import', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');
  try {
    await db.initDb();
    const caller = appRouter.createCaller({});
    const row = {
      Tijdstempel: '23/09/2026 18:00:00',
      'E-mailadres': 'runner@example.org',
      'Voornaam + naam': 'Test Loper',
      'GSM-nummer': '0499 12 34 56',
      Studiefase: '1ste bach',
      'Ik schat in totaal ... rondjes te lopen': '12',
      'Ik schat een gemiddelde van ... te lopen op 515m (gemiddelde van alle toertjes)': `1'17"-1'19"`,
      'Maximum aantal rondjes dat je in een blok van 2 uur kan lopen. We verspreiden je max. aantal rondjes zo goed mogelijk over de opgegeven uren!':
        '3',
      'Ik ben volgende uren beschikbaar om te lopen (zoveel mogelijk aanduiden!)\nPS: ben je 1ste bach student?':
        '20-21u (dinsdag), 03-04u (woensdag)',
      'Ik geef hierbij toestemming dat mijn gegevens opnieuw mogen gebruikt worden in latere jaren in verband met de 24 urenloop.':
        'Nee',
      'Hoe flexibel ben jij binnen deze intervallen?': 'Een kwartier vroeger of later',
      'Nog iets dat wij best kunnen weten van hoe jij jouw 24-urenloop ziet?': 'Rustig beginnen',
      'Behoor je tot één van volgende categorieën?': 'Eerstejaars, Vrouw',
    };
    const first = await caller.runners.importCsv({ csvText: Papa.unparse([row]) });
    assert.equal(first.created, 1);
    const imported = db.getAllRunners()[0];
    const registration = (await caller.runners.registrations())[imported.id];
    assert.equal(imported.runnerNumber, '2');
    assert.equal(imported.estimatedPace, `1'17"-1'19"`);
    assert.deepEqual(registration?.availableHours, ['20-21u (dinsdag)', '03-04u (woensdag)']);
    assert.deepEqual(registration?.categories, ['Eerstejaars', 'Vrouw']);
    assert.deepEqual(imported.labels.map((label) => label.name).sort(), ['1ste jaar', 'Dames']);
    assert.equal(registration?.reuseConsent, 'Nee');
    assert.equal(registration?.remarks, 'Rustig beginnen');
    // Contact details never travel with the live snapshot every screen loads.
    const { liveAppSnapshot } = await import('../server/app-state.ts');
    const live = JSON.stringify(liveAppSnapshot());
    assert.equal(live.includes('runner@example.org'), false);
    assert.equal(live.includes('0499 12 34 56'), false);
    db.updateRunner(imported.id, { runnerNumber: '42', notes: 'Operatornote' });
    db.updateRunnerStatus({ id: imported.id, status: 'warming_up' });
    const repeat = await caller.runners.importCsv({
      csvText: Papa.unparse([{ ...row, 'Ik schat in totaal ... rondjes te lopen': '14' }]),
    });
    assert.equal(repeat.updated, 1);
    assert.equal(db.getAllRunners().length, 1);
    const updated = db.getRunnerById(imported.id);
    assert.equal(updated?.runnerNumber, '42');
    assert.equal(updated?.notes, 'Operatornote');
    assert.equal(updated?.status, 'warming_up');
    assert.equal((await caller.runners.registrations())[imported.id]?.estimatedLaps, '14');
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('hand-entered contact details and hours merge into the registration', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');
  try {
    await db.initDb();
    const caller = appRouter.createCaller({});
    const manual = await caller.runners.create({
      name: 'Manuele Loper',
      registrationSource: 'manual',
      registrationDetails: { phone: ' 0470 11 22 33 ', email: '', availableHours: ['20-21u (dinsdag)'] },
    });
    const registration = (await caller.runners.registrations())[manual.id];
    assert.equal(registration?.phone, '0470 11 22 33');
    assert.deepEqual(registration?.availableHours, ['20-21u (dinsdag)']);
    assert.equal(registration?.studyPhase, '');

    const withoutDetails = await caller.runners.create({ name: 'Zonder Gegevens', registrationDetails: {} });
    assert.equal((await caller.runners.registrations())[withoutDetails.id], undefined);

    await caller.runners.update({
      id: manual.id,
      fields: { registrationDetails: { availableHours: ['21-22u (dinsdag)', '21-22u (dinsdag)'] } },
    });
    const updated = (await caller.runners.registrations())[manual.id];
    assert.equal(updated?.phone, '0470 11 22 33');
    assert.deepEqual(updated?.availableHours, ['21-22u (dinsdag)']);

    await caller.runners.update({
      id: manual.id,
      fields: { registrationDetails: { phone: '', email: '', availableHours: [] } },
    });
    assert.equal((await caller.runners.registrations())[manual.id], undefined);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
