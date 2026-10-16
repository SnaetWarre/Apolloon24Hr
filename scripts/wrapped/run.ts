// Apolloon Wrapped, run after the race from one laptop at home (docs/wrapped.md):
//   npm run wrapped:cards -- --db=<backup.sqlite> [--out=<folder>] [--only=146,203] [--force]
//   npm run wrapped:mail -- [--out=<folder>] [--from=<gmail address>] [--test | --send]
// `cards` starts the built app on a copy of the backup and saves every runner's card
// (/wrapped/card) as a 1080×1920 PNG with Playwright. `mail` sends each runner their card
// through Gmail; without --test or --send it only lists who would get one.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildWrapped, wrappedFileNames } from '../../src/lib/wrapped.ts';
import type { LapRecord, LiveAppSnapshot, RaceEvent, RunnerRegistration } from '../../shared/schemas.ts';
import { sendWrappedMails, GMAIL, type SmtpServer } from './mail.ts';
import {
  mailableCards,
  mergeManifest,
  readManifest,
  writeManifest,
  type WrappedCard,
  type WrappedManifestEntry,
} from './manifest.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const serverEntry = path.join(repoRoot, 'dist-server/server/index.js');
const MAIL_TEXT_FILE = 'mail.txt';
const DEFAULT_MAIL_TEXT = (year: number) => `Onderwerp: Jouw 24 Urenloop ${year}

Hoi!

Bedankt om mee te lopen op de 24 Urenloop. Hieronder zit jouw kaart met je rondjes, je snelste en gemiddelde ronde, je lopersprofiel en je plaats in het klassement.
`;

const [command, ...rest] = process.argv.slice(2);
const options = Object.fromEntries(
  rest.map((arg) => {
    const [key, ...value] = arg.replace(/^--/, '').split('=');
    return [key, value.length ? value.join('=') : 'true'];
  })
);

try {
  if (command === 'cards') await makeCards();
  else if (command === 'mail') await mail();
  else throw new Error('Gebruik: run.ts cards --db=<backup.sqlite> | run.ts mail [--test | --send]');
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function makeCards() {
  if (!options.db) throw new Error('Geef de backup mee: --db=<pad naar apolloon-….sqlite of app.db>');
  if (!fs.existsSync(serverEntry)) throw new Error('Geen build gevonden. Draai eerst `npm run build`.');
  const app = await startApp(path.resolve(options.db));
  try {
    const [state, history, registrations] = await Promise.all([
      app.get<LiveAppSnapshot>('/api/state'),
      app.get<{ laps: LapRecord[]; events: RaceEvent[] }>('/api/history?scope=full'),
      app.get<Record<string, RunnerRegistration>>('/api/registrations'),
    ]);
    if (!state.race.raceFinishedAt && options.force !== 'true') {
      throw new Error(
        'De race is in deze backup nog niet afgesloten, dus de cijfers zijn misschien niet definitief.\n' +
          'Neem een backup van na het afsluiten, of voeg --force toe om toch kaarten te maken.'
      );
    }
    const year = new Date(state.race.raceFinishedAt ?? state.race.raceStartedAt ?? Date.now()).getFullYear();
    const out = outputFolder(year);
    const wrapped = buildWrapped({ runners: state.runners, laps: history.laps, registrations, events: history.events });
    const fileNames = wrappedFileNames(wrapped);
    const only = options.only ? new Set(options.only.split(',').map((each) => each.trim())) : null;
    const chosen = only
      ? wrapped.filter((runner) => only.has(runner.runnerId) || (runner.runnerNumber && only.has(runner.runnerNumber)))
      : wrapped;
    if (!chosen.length)
      throw new Error(only ? 'Geen loper met rondes gevonden voor --only.' : 'Niemand liep een ronde.');

    fs.mkdirSync(out, { recursive: true });
    console.log(`${chosen.length} kaarten maken in ${out}`);
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
    const made: WrappedCard[] = [];
    const failed: string[] = [];
    try {
      const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
      for (const [index, runner] of chosen.entries()) {
        const fileName = fileNames.get(runner.runnerId)!;
        process.stdout.write(`\r${index + 1}/${chosen.length} ${runner.name}`.padEnd(60));
        try {
          await page.goto(`${app.url}/wrapped/card?runner=${encodeURIComponent(runner.runnerId)}`);
          // The card page says when its fonts and logos are in.
          await page.waitForSelector('html[data-wrapped-ready="card"]', { timeout: 20_000 });
          await page.screenshot({ path: path.join(out, fileName) });
          made.push({
            runnerId: runner.runnerId,
            runnerNumber: runner.runnerNumber,
            name: runner.name,
            email: runner.email,
            emailValid: runner.emailValid,
            refusedContact: runner.refusedContact,
            fileName,
          });
        } catch (error) {
          failed.push(`${runner.name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
        }
      }
    } finally {
      await browser.close();
    }
    await writeManifest(out, mergeManifest(await readManifest(out), made, Date.now()));
    const textFile = path.join(out, MAIL_TEXT_FILE);
    if (!fs.existsSync(textFile)) fs.writeFileSync(textFile, DEFAULT_MAIL_TEXT(year));

    console.log(`\n\n${made.length} kaarten gemaakt in ${out}`);
    if (failed.length) console.log(`Mislukt (${failed.length}):\n  ${failed.join('\n  ')}`);
    console.log(`Pas de mail aan in ${textFile} en kijk wie hem krijgt met: npm run wrapped:mail -- --out="${out}"`);
  } finally {
    await app.stop();
  }
}

async function mail() {
  const out = outputFolder(new Date().getFullYear());
  const manifest = await readManifest(out);
  if (!manifest) throw new Error(`Geen kaarten in ${out}. Maak ze eerst met npm run wrapped:cards, of geef --out mee.`);
  const { subject, text } = readMailText(path.join(out, MAIL_TEXT_FILE));

  const toMail = mailableCards(manifest);
  const label = (card: WrappedCard) => `${card.runnerNumber ? `${card.runnerNumber} ` : ''}${card.name}`;
  const list = (title: string, cards: WrappedManifestEntry[], detail: (card: WrappedManifestEntry) => string) => {
    if (cards.length) console.log(`\n${title} (${cards.length}):\n  ${cards.map(detail).join('\n  ')}`);
  };
  const counts = new Map<string, number>();
  const mailed = manifest.cards.filter((card) => card.emailValid && !card.refusedContact);
  for (const card of mailed) {
    counts.set(card.email.toLowerCase(), (counts.get(card.email.toLowerCase()) ?? 0) + 1);
  }
  console.log(`Map: ${out}\nOnderwerp: ${subject}`);
  console.log(
    `\n${toMail.length} lopers krijgen een mail; ${manifest.cards.filter((card) => card.sentAt).length} kregen hem al.`
  );
  list(
    'Geen geldig e-mailadres, stuur hun kaart zelf door',
    manifest.cards.filter((card) => !card.emailValid),
    (card) => `${label(card)}: ${card.email || '(leeg)'} → ${card.fileName}`
  );
  list(
    'Willen niet meer gecontacteerd worden, krijgen geen mail',
    manifest.cards.filter((card) => card.emailValid && card.refusedContact),
    label
  );
  list(
    'Delen een e-mailadres met een andere loper (elk krijgt zijn eigen kaart)',
    mailed.filter((card) => counts.get(card.email.toLowerCase())! > 1),
    (card) => `${label(card)}: ${card.email}`
  );
  list(
    'Vorige poging mislukt',
    manifest.cards.filter((card) => card.error && !card.sentAt),
    (card) => `${label(card)}: ${card.error}`
  );

  const testOnly = options.test === 'true';
  if (!testOnly && options.send !== 'true') {
    console.log(
      '\nNog niets verstuurd. Eerst een testmail naar jezelf: --test --from=<gmail-adres>. Daarna iedereen: --send --from=<gmail-adres>.'
    );
    return;
  }
  const from = options.from;
  if (!from?.includes('@')) throw new Error('Geef het Gmail-adres mee: --from=<adres>');
  if (!testOnly) {
    if (!toMail.length) return console.log('\nIedereen met een geldig adres kreeg zijn kaart al.');
    const answer = await ask(
      `\n${toMail.length} mails versturen vanaf ${from}, ongeveer ${Math.ceil((toMail.length * 2) / 60)} minuten? Typ ja: `
    );
    if (answer.toLowerCase() !== 'ja') return console.log('Niets verstuurd.');
  }
  // An app password from the Google account (Beveiliging › App-wachtwoorden); never written anywhere.
  const password = process.env.WRAPPED_GMAIL_PASSWORD ?? (await ask('App-wachtwoord van Google: ', true));
  const result = await sendWrappedMails(
    { folder: out, from, password, subject, text, testOnly },
    {
      server: testServer() ?? GMAIL,
      onProgress: ({ done, total, current }) => {
        if (current) process.stdout.write(`\r${done + 1}/${total} ${current}`.padEnd(60));
      },
    }
  );
  console.log(
    testOnly
      ? `\nTestmail verstuurd naar ${from}. Kijk of de kaart goed aankomt.`
      : `\n${result.sent} verstuurd, ${result.left} over.`
  );
  for (const failure of result.failed) console.log(`  Mislukt: ${failure.name}: ${failure.error}`);
  if (result.stopped) throw new Error(`${result.stopped}\nOpnieuw starten verstuurt alleen naar wie nog niets kreeg.`);
}

/** The first line "Onderwerp: …" is the subject, the rest is the mail. */
function readMailText(file: string) {
  if (!fs.existsSync(file)) throw new Error(`${file} ontbreekt. Maak de kaarten opnieuw, dan komt hij terug.`);
  const [first, ...lines] = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const subject = /^onderwerp:\s*(.+)$/i.exec(first.trim())?.[1];
  if (!subject) throw new Error(`De eerste regel van ${file} moet "Onderwerp: …" zijn.`);
  return { subject, text: lines.join('\n').trim() };
}

function outputFolder(year: number): string {
  if (options.out) return path.resolve(options.out);
  const documents = path.join(os.homedir(), 'Documents');
  return path.join(fs.existsSync(documents) ? documents : os.homedir(), `Apolloon Wrapped ${year}`);
}

/** Only for checking the script against a local SMTP server: WRAPPED_SMTP=127.0.0.1:2525. */
function testServer(): SmtpServer | null {
  const [host, port] = process.env.WRAPPED_SMTP?.split(':') ?? [];
  return host && port ? { host, port: Number(port), secure: false } : null;
}

/** Starts the built app alone on a copy of the database, so the backup itself stays untouched. */
async function startApp(database: string) {
  if (!fs.existsSync(database)) throw new Error(`Bestand niet gevonden: ${database}`);
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'apolloon-wrapped-'));
  fs.mkdirSync(path.join(dataPath, 'data'));
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(database + suffix))
      fs.copyFileSync(database + suffix, path.join(dataPath, 'data', `app.db${suffix}`));
  }
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(dataPath, 'server.log'), 'a');
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATA_PATH: dataPath,
      PORT: String(port),
      CLUSTER_ENABLED: 'false',
      BACKUP_ENABLED: 'false',
      APOLLOON_UPDATE_CHECK: '0',
    },
  });
  const stop = async () => {
    child.kill();
    await new Promise((resolve) => (child.exitCode === null ? child.once('exit', resolve) : resolve(null)));
    fs.rmSync(dataPath, { recursive: true, force: true });
  };
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    if (
      await fetch(`${url}/api/host-info`).then(
        (response) => response.ok,
        () => false
      )
    ) {
      return {
        url,
        stop,
        get: async <T>(route: string): Promise<T> => {
          const response = await fetch(`${url}${route}`);
          if (!response.ok) throw new Error(`${route} gaf ${response.status}`);
          return (await response.json()) as T;
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const tail = fs.readFileSync(path.join(dataPath, 'server.log'), 'utf8').slice(-2_000);
  await stop();
  throw new Error(`De app startte niet op deze backup.\n${tail}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function ask(question: string, hidden = false): Promise<string> {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Echo the question, never the typed password.
    (prompt as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text) => {
      if (text.includes(question)) process.stdout.write(text);
    };
  }
  return new Promise((resolve) =>
    prompt.question(question, (answer) => {
      prompt.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    })
  );
}
