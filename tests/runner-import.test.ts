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
    // Windows cannot delete a database file that is still open.
    db.closeDb();
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
    // Windows cannot delete a database file that is still open.
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('hand-typed form answers import as they are and re-import onto the same runners', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');
  try {
    await db.initDb();
    const caller = appRouter.createCaller({});
    // Someone added on the spot took the number of a sheet row that came in later.
    await caller.runners.create({ name: 'Ter Plaatse', runnerNumber: '7', registrationSource: 'manual' });
    const answer = (submittedAt: string, email: string, name: string, phone: string) => ({
      Tijdstempel: submittedAt,
      'E-mailadres': email,
      'Voornaam + naam': name,
      'GSM-nummer': phone,
      'Hoe flexibel ben jij binnen deze intervallen?': 'niet inplannen, loopt in PTS trein',
      "Wat was de tijd van jouw snelste (test)ronde vorig jaar/ dit jaar?\nbv.: 1'20": `1'18`,
    });
    const blank = answer('', '', '', '');
    const rows = [
      answer('04/10/2026 18:06:39', 'echt@example.org', 'Echte Loper', '0471 11 22 33'),
      answer('04/10/2026 18:14:44', '////', 'Eerste Streep', 'contacteer Thomas'),
      answer('04/10/2026 19:30:23', '////', 'Tweede Streep', 'Pts'),
      answer('04/10/2026 19:43:57', '', 'Zonder Mail', ''),
      {
        ...blank,
        'Hoe flexibel ben jij binnen deze intervallen?': '',
        "Wat was de tijd van jouw snelste (test)ronde vorig jaar/ dit jaar?\nbv.: 1'20": '',
      },
      answer('05/10/2026 10:18:05', 'laat@example.org', 'Late Inschrijving', '0470 00 00 00'),
    ];
    const csvText = Papa.unparse(rows);

    const first = await caller.runners.importCsv({ csvText });
    assert.deepEqual(first, {
      created: 5,
      updated: 0,
      skipped: 0,
      errors: ['Rij 7: nummer 7 is al in gebruik, Late Inschrijving kreeg geen nummer'],
    });
    const byName = () => new Map(db.getAllRunners().map((runner) => [runner.name, runner]));
    const runners = byName();
    assert.deepEqual(
      ['Echte Loper', 'Eerste Streep', 'Tweede Streep', 'Zonder Mail', 'Late Inschrijving', 'Ter Plaatse'].map(
        (name) => runners.get(name)?.runnerNumber
      ),
      ['2', '3', '4', '5', null, '7']
    );
    const registrations = await caller.runners.registrations();
    const streep = registrations[runners.get('Eerste Streep')!.id];
    assert.equal(streep?.email, '////');
    assert.equal(streep?.phone, 'contacteer Thomas');
    assert.equal(streep?.flexibility, 'niet inplannen, loopt in PTS trein');
    assert.equal(streep?.fastestLap, `1'18`);

    const repeat = await caller.runners.importCsv({ csvText });
    assert.equal(repeat.created, 0);
    assert.equal(repeat.updated, 5);
    assert.equal(db.getAllRunners().length, 6);
    assert.equal(byName().get('Tweede Streep')?.runnerNumber, '4');
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('the form’s Excel file imports like its CSV export, without doubling runners when switching', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');
  const { default: writeXlsxFile } = await import('write-excel-file/node');
  try {
    await db.initDb();
    const caller = appRouter.createCaller({});
    const header = [
      'Tijdstempel',
      'E-mailadres',
      'Voornaam + naam',
      'GSM-nummer',
      'Ik schat in totaal ... rondjes te lopen',
    ];
    // Google Sheets stores the clock time; the library writes a Date as that time in UTC.
    const submitted = new Date(Date.UTC(2026, 9, 4, 18, 14, 44, 926));
    const workbook = await writeXlsxFile([
      header.map((value) => ({ value })),
      [
        { value: submitted, format: 'm/d/yyyy h:mm:ss' },
        { value: '////' },
        { value: 'Streep Loper' },
        { value: 'contacteer Thomas' },
        { value: 3 },
      ],
    ]).toBuffer();

    const fromExcel = await caller.runners.importXlsx({ dataBase64: workbook.toString('base64') });
    assert.equal(fromExcel.created, 1);
    const [runner] = db.getAllRunners();
    const registration = (await caller.runners.registrations())[runner.id];
    assert.equal(runner.runnerNumber, '2');
    assert.equal(registration?.submittedAt, '04/10/2026 18:14:44');
    assert.equal(registration?.email, '////');
    assert.equal(registration?.estimatedLaps, '3');

    // The CSV export of the same sheet writes the time in the sheet's own format.
    const fromCsv = await caller.runners.importCsv({
      csvText: Papa.unparse([header, ['10/4/2026 18:14:44', '////', 'Streep Loper', 'contacteer Thomas', '4']]),
    });
    assert.equal(fromCsv.updated, 1);
    assert.equal(db.getAllRunners().length, 1);

    await assert.rejects(
      caller.runners.importXlsx({ dataBase64: Buffer.from('geen excel').toString('base64') }),
      /Het Excel-bestand kon niet gelezen worden/
    );
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
