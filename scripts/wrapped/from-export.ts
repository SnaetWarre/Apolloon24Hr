// Apolloon Wrapped opnieuw maken uit het Excel-bestand van Analyse › Exporteren › Excel, voor
// als de race-database van die dag niet meer bestaat (docs/wrapped.md):
//   npm run wrapped:from-export -- --xlsx=<apolloon-race.xlsx> --runner=<naam of nummer> [--out=<map>]
// Het bestand gaat naar een tijdelijke database, zodat de bestaande kaarten-flow en het
// bestaande ontwerp gebruikt worden; de cijfers komen uit dezelfde buildWrapped als na de race.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWrapped, formatLapTime, formatTimeOfDay } from '../../src/lib/wrapped.ts';
import { findExportRunner, readRaceExport, type ExportRace, type ExportRunner } from './export-data.ts';
import { makeCards, type Options } from './run.ts';

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, '').split('=');
    return [key, value.length ? value.join('=') : 'true'];
  })
) as Options;

try {
  await remake();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function remake() {
  const file = options.xlsx;
  if (!file) throw new Error('Geef het Excel-bestand mee: --xlsx=<apolloon-race.xlsx>');
  if (!options.runner) throw new Error('Geef de loper mee: --runner=<naam of nummer>, zoals op zijn kaart staat.');
  const xlsx = path.resolve(file);
  if (!fs.existsSync(xlsx)) throw new Error(`Bestand niet gevonden: ${xlsx}`);

  const race = await readRaceExport(xlsx);
  const runner = findExportRunner(race.runners, options.runner);
  printRace(race, runner);

  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apolloon-wrapped-export-'));
  // The server modules read DATA_PATH when they are first imported, so it is set first.
  process.env.DATA_PATH = dataRoot;
  try {
    const { writeExportDatabase } = await import('./export-database.ts');
    const database = await writeExportDatabase(race);
    console.log('');
    await makeCards({ db: database, only: runner.id, ...(options.out ? { out: options.out } : {}) });
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

function printRace(race: ExportRace, runner: ExportRunner) {
  const time = (at: number) =>
    new Date(at).toLocaleString('nl-BE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Brussels' });
  console.log(
    `${path.basename(options.xlsx!)}: ${race.runners.length} lopers, ${race.laps.length} rondes, ` +
      `${time(race.raceStartedAt)} tot ${time(race.raceFinishedAt)}`
  );

  const entry = buildWrapped({
    runners: race.runners,
    laps: race.laps,
    registrations: race.registrations,
    raceStartedAt: race.raceStartedAt,
  }).find((each) => each.runnerId === runner.id);
  if (!entry) throw new Error(`${runner.name} heeft geen enkele ronde in het bestand.`);

  const fastest = entry.fastestLap;
  const line = (label: string, value: string) => console.log(`  ${label.padEnd(16)}${value}`);
  console.log(`\nGekozen: ${entry.runnerNumber ? `${entry.runnerNumber} ` : ''}${entry.name}`);
  line('Rondes', String(entry.laps));
  line('Snelste ronde', entry.fastestLapMs == null ? '— (geen meetbare ronde)' : formatLapTime(entry.fastestLapMs));
  line('Gemiddelde', entry.averageLapMs == null ? '— (geen meetbare ronde)' : formatLapTime(entry.averageLapMs));
  line('Afstand', `${entry.meters.toLocaleString('nl-BE')} m`);
  line('Meer dan', `${entry.lapsBeatenPercent}% van alle lopers`);
  line('Looptype', entry.runnerType.title);
  if (fastest) {
    line('Snelste was', `ronde ${fastest.number}, om ${formatTimeOfDay(fastest.finishedAt)}, #${fastest.place}`);
  }
  console.log(
    '\nLet op: het Excel-bestand zegt niet welke rondes gemeten zijn. Rondes onder 20 seconden en boven\n' +
      '10 minuten tellen niet mee voor de snelste en de gemiddelde ronde, maar een gesplitste ronde kan\n' +
      'op deze kaart wel als snelle ronde opduiken. Vergelijk de cijfers hierboven met de oude kaart.'
  );
}
