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

test('re-importing the same form answer keeps corrected contact details and hours', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');
  try {
    await db.initDb();
    const caller = appRouter.createCaller({});
    const answer = (submittedAt: string, hours: string) =>
      Papa.unparse([
        {
          Tijdstempel: submittedAt,
          'E-mailadres': 'zoe@example.be',
          'Voornaam + naam': 'Zoë Peeters',
          'GSM-nummer': '0471 11 22 33',
          'Ik ben volgende uren beschikbaar': hours,
        },
      ]);
    const original = answer('01/10/2026 10:00:00', '20-21u (dinsdag), 22-23u (dinsdag)');
    await caller.runners.importCsv({ csvText: original });
    const [zoe] = db.getAllRunners();
    db.updateRunner(zoe.id, { registrationDetails: { phone: '0499 99 99 99', availableHours: ['20-21u (dinsdag)'] } });
    const details = async () => {
      const registration = (await caller.runners.registrations())[zoe.id];
      return { phone: registration?.phone, availableHours: registration?.availableHours };
    };
    const corrected = { phone: '0499 99 99 99', availableHours: ['20-21u (dinsdag)'] };

    assert.equal((await caller.runners.importCsv({ csvText: original })).updated, 1);
    assert.deepEqual(await details(), corrected);
    // The sheet's own CSV export writes the month first.
    await caller.runners.importCsv({ csvText: answer('10/1/2026 10:00:00', '20-21u (dinsdag), 22-23u (dinsdag)') });
    assert.deepEqual(await details(), corrected);

    // Zoë filled in the form again.
    await caller.runners.importCsv({ csvText: answer('03/10/2026 09:30:00', '23-24u (dinsdag)') });
    assert.deepEqual(await details(), { phone: '0471 11 22 33', availableHours: ['23-24u (dinsdag)'] });
    assert.equal(db.getAllRunners().length, 1);
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('re-importing the same form answer keeps the name an operator corrected', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');
  try {
    await db.initDb();
    const caller = appRouter.createCaller({});
    const answer = (submittedAt: string, name: string) =>
      Papa.unparse([{ Tijdstempel: submittedAt, 'E-mailadres': 'jan@example.be', 'Voornaam + naam': name }]);
    const original = answer('04/10/2026 18:14:44', 'jan peetrs');
    await caller.runners.importCsv({ csvText: original });
    const [jan] = db.getAllRunners();
    const name = () => db.getRunnerById(jan.id)?.name;

    // Only case and spacing fixed: still found by e-mail and name.
    db.updateRunner(jan.id, { name: 'Jan  Peetrs' });
    assert.equal((await caller.runners.importCsv({ csvText: original })).updated, 1);
    assert.equal(name(), 'Jan  Peetrs');
    // Spelling fixed: found by the submission time.
    db.updateRunner(jan.id, { name: 'Jan Peeters' });
    assert.equal((await caller.runners.importCsv({ csvText: original })).updated, 1);
    assert.equal(name(), 'Jan Peeters');

    // Jan filled in the form again.
    await caller.runners.importCsv({ csvText: answer('05/10/2026 09:00:00', 'jan peeters') });
    assert.equal(name(), 'jan peeters');
    assert.equal(db.getAllRunners().length, 1);
  } finally {
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

test('lap times typed in Excel as 1:20 import as 1 minute 20, like the CSV of that sheet', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');
  const { default: writeXlsxFile } = await import('write-excel-file/node');
  // Excel keeps a cell typed as 1:20 as the time of day 01:20 (h:mm); one typed as 0:01:20 as h:mm:ss.
  const excelTime = (hours: number, minutes: number, seconds: number, format: string) => ({
    value: new Date(Date.UTC(1899, 11, 30, hours, minutes, seconds)),
    format,
  });
  try {
    await db.initDb();
    const caller = appRouter.createCaller({});
    const plainList = await writeXlsxFile([
      ['runner_number', 'name', 'historical_avg', 'historical_best'].map((value) => ({ value })),
      [{ value: 1 }, { value: 'Anna Peeters' }, excelTime(1, 20, 0, 'h:mm'), excelTime(1, 15, 0, 'h:mm')],
      [{ value: 2 }, { value: 'Bert Claes' }, excelTime(0, 1, 20, 'h:mm:ss'), excelTime(0, 1, 15, 'h:mm:ss')],
    ]).toBuffer();

    await caller.runners.importXlsx({ dataBase64: plainList.toString('base64') });
    const runners = new Map(db.getAllRunners().map((runner) => [runner.name, runner]));
    assert.equal(runners.get('Anna Peeters')?.historicalAvgMs, 80_000);
    assert.equal(runners.get('Anna Peeters')?.historicalBestMs, 75_000);
    assert.equal(runners.get('Bert Claes')?.historicalAvgMs, 80_000);
    assert.equal(runners.get('Bert Claes')?.historicalBestMs, 75_000);

    // A form answer that the sheet turned into a time still reads as it was typed.
    const formSheet = await writeXlsxFile([
      ['E-mailadres', 'Voornaam + naam', 'Wat was de tijd van jouw snelste ronde?'].map((value) => ({ value })),
      [{ value: 'cas@example.org' }, { value: 'Cas Jacobs' }, excelTime(1, 20, 0, 'h:mm')],
    ]).toBuffer();
    await caller.runners.importXlsx({ dataBase64: formSheet.toString('base64') });
    const cas = db.getAllRunners().find((runner) => runner.name === 'Cas Jacobs');
    assert.equal((await caller.runners.registrations())[cas!.id]?.fastestLap, '1:20');
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('a hand-made list imports rows that leave off empty trailing columns', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');
  try {
    await db.initDb();
    const caller = appRouter.createCaller({});
    const csvText = [
      'runner_number,naam,labels,snelste',
      '1,Anna Peeters',
      '2,Bert Claes,HILOK,1:20',
      '   ',
      '3,Cas Jacobs,Dames',
      '4,Peeters, Dirk,Kinesia,1:25',
    ].join('\n');

    const summary = await caller.runners.importCsv({ csvText });
    assert.deepEqual(summary, {
      created: 4,
      updated: 0,
      skipped: 0,
      errors: ['Rij 6: meer waarden dan kolommen, genegeerd: 1:25'],
    });
    const runners = new Map(db.getAllRunners().map((runner) => [runner.runnerNumber, runner]));
    assert.equal(runners.get('1')?.name, 'Anna Peeters');
    assert.deepEqual(runners.get('1')?.labels, []);
    assert.equal(runners.get('2')?.historicalBestMs, 80_000);
    assert.deepEqual(
      runners.get('3')?.labels.map((label) => label.name),
      ['Dames']
    );
    assert.equal(runners.get('4')?.name, 'Peeters');

    await assert.rejects(
      caller.runners.importCsv({ csvText: 'runner_number,naam\n5,"Eva Maes\n6,Fien Wouters' }),
      /Het CSV-bestand kon niet gelezen worden/
    );
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('re-importing a plain list without labels keeps the labels and times set in the app', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');
  try {
    await db.initDb();
    const caller = appRouter.createCaller({});
    const list = 'runner_number,name\n901,Lien Claes\n';
    assert.equal((await caller.runners.importCsv({ csvText: list })).created, 1);
    const lien = db.getAllRunners()[0];
    db.updateRunner(lien.id, { labels: ['Speedteam Blue'], historicalAvgMs: 85_000, historicalBestMs: 80_000 });

    const repeat = await caller.runners.importCsv({ csvText: `${list}902,Late Loper\n` });
    assert.equal(repeat.created, 1);
    assert.equal(repeat.updated, 1);
    const updated = db.getRunnerById(lien.id);
    assert.deepEqual(
      updated?.labels.map((label) => label.name),
      ['Speedteam Blue']
    );
    assert.equal(updated?.historicalAvgMs, 85_000);
    assert.equal(updated?.historicalBestMs, 80_000);
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('runners who share one e-mail address stay separate runners', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');
  try {
    await db.initDb();
    const caller = appRouter.createCaller({});
    const header = ['Tijdstempel', 'E-mailadres', 'Voornaam + naam', 'Behoor je tot'];
    const rows = [
      ['01/10/2026 10:00:00', 'secretariaat@hilok.be', 'Anna Claes', 'HILOK Gent'],
      ['01/10/2026 10:05:00', 'secretariaat@hilok.be', 'Bert Maes', 'HILOK Gent'],
      ['01/10/2026 10:09:00', 'secretariaat@hilok.be', 'Chris Smet', 'HILOK Gent'],
    ];
    const csvText = Papa.unparse([header, ...rows]);
    const names = () =>
      db
        .getAllRunners()
        .map((runner) => runner.name)
        .sort();

    const first = await caller.runners.importCsv({ csvText });
    assert.deepEqual(first, { created: 3, updated: 0, skipped: 0, errors: [] });
    assert.deepEqual(names(), ['Anna Claes', 'Bert Maes', 'Chris Smet']);

    const repeat = await caller.runners.importCsv({ csvText });
    assert.deepEqual(repeat, { created: 0, updated: 3, skipped: 0, errors: [] });
    assert.deepEqual(names(), ['Anna Claes', 'Bert Maes', 'Chris Smet']);

    // Anna sends the form again later; her new answer replaces the old one.
    const anna = db.getAllRunners().find((runner) => runner.name === 'Anna Claes');
    const again = await caller.runners.importCsv({
      csvText: Papa.unparse([header, ['02/10/2026 09:00:00', 'Secretariaat@hilok.be', ' anna claes ', 'HILOK Gent']]),
    });
    assert.deepEqual(again, { created: 0, updated: 1, skipped: 0, errors: [] });
    assert.equal(db.getAllRunners().length, 3);
    assert.equal((await caller.runners.registrations())[anna!.id]?.submittedAt, '02/10/2026 09:00:00');
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('a separate plain list never renames form runners that hold its numbers', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');
  try {
    await db.initDb();
    const caller = appRouter.createCaller({});
    await caller.runners.importCsv({
      csvText: [
        'Tijdstempel,E-mailadres,Voornaam + naam',
        '01/10/2026 10:00:00,anna@x.be,Anna Claes',
        '01/10/2026 10:05:00,bert@x.be,Bert Maes',
      ].join('\n'),
    });
    const anciens = 'nummer;naam;groep\n2;Dirk Peeters;Anciens\n3;Els Wouters;Anciens\n';

    const first = await caller.runners.importCsv({ csvText: anciens });
    assert.equal(first.created, 2);
    assert.equal(first.updated, 0);
    assert.deepEqual(first.errors, [
      'Rij 2: nummer 2 is al in gebruik, Dirk Peeters kreeg geen nummer',
      'Rij 3: nummer 3 is al in gebruik, Els Wouters kreeg geen nummer',
    ]);
    const registrations = await caller.runners.registrations();
    const byName = () => new Map(db.getAllRunners().map((runner) => [runner.name, runner]));
    const runners = byName();
    assert.equal(runners.get('Anna Claes')?.runnerNumber, '2');
    assert.equal(registrations[runners.get('Anna Claes')!.id]?.email, 'anna@x.be');
    assert.equal(runners.get('Bert Maes')?.runnerNumber, '3');
    assert.equal(registrations[runners.get('Bert Maes')!.id]?.email, 'bert@x.be');
    assert.equal(runners.get('Dirk Peeters')?.runnerNumber, null);
    assert.equal(runners.get('Els Wouters')?.runnerNumber, null);

    const repeat = await caller.runners.importCsv({ csvText: anciens });
    assert.equal(repeat.created, 0);
    assert.equal(repeat.updated, 2);
    assert.equal(db.getAllRunners().length, 4);
    assert.equal(byName().get('Anna Claes')?.runnerNumber, '2');
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('two rows of one plain list with the same number both import', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');
  try {
    await db.initDb();
    const caller = appRouter.createCaller({});
    const csvText = [
      'runner_number,name,labels',
      '204,Anna Peeters,HILOK',
      '205,Bram Claes,Kinesia',
      '205,Chloé Martens,Mesacosa',
      '206,Dries Wouters,HILOK',
      '206,Dries Wouters,HILOK',
    ].join('\n');
    const byName = () => new Map(db.getAllRunners().map((runner) => [runner.name, runner]));

    const first = await caller.runners.importCsv({ csvText });
    assert.deepEqual(first, {
      created: 4,
      updated: 1,
      skipped: 0,
      errors: ['Rij 4: nummer 205 staat ook op rij 3, Chloé Martens kreeg geen nummer'],
    });
    const runners = byName();
    assert.equal(runners.size, 4);
    assert.equal(runners.get('Bram Claes')?.runnerNumber, '205');
    assert.deepEqual(
      runners.get('Bram Claes')?.labels.map((label) => label.name),
      ['Kinesia']
    );
    assert.equal(runners.get('Chloé Martens')?.runnerNumber, null);
    assert.deepEqual(
      runners.get('Chloé Martens')?.labels.map((label) => label.name),
      ['Mesacosa']
    );
    assert.equal(runners.get('Dries Wouters')?.runnerNumber, '206');

    const repeat = await caller.runners.importCsv({ csvText });
    assert.deepEqual(repeat, {
      created: 0,
      updated: 5,
      skipped: 0,
      errors: ['Rij 4: nummer 205 staat ook op rij 3, Chloé Martens kreeg geen nummer'],
    });
    assert.equal(db.getAllRunners().length, 4);
    assert.equal(byName().get('Bram Claes')?.runnerNumber, '205');
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
