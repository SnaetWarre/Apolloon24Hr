import { createHash } from 'node:crypto';
import { all, markAppDataChanged, run, transaction } from './db/connection.js';
import { getRaceState } from './db/race-state.js';
import { insertRunner } from './db/runners.js';
import { getNextWaitingRunner, getMaxQueueIndex } from './db/queue.js';
import { performHandoff } from './db/timing.js';

/**
 * A race that runs itself, for the public test server (`DEMO_RACE=true`).
 * Every evening at 20:00 Brussels time it starts over; in between it hands
 * off whenever the running lap has lasted its planned 1:08 to 1:25, so the
 * screens and charts always show a believable race without anyone pressing.
 */
export function isDemoRaceEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.DEMO_RACE === 'true';
}

const RACE_START_HOUR = 20;
const MIN_LAP_MS = 68_000;
const MAX_LAP_MS = 85_000;
const WAITING_RUNNERS = 8;

const RUNNER_NAMES = [
  'Noor Verbruggen',
  'Kobe Janssens',
  'Marcin Delhaye',
  'Lotte Peeters',
  'Sander Wouters',
  'Emma Smets',
  'Ruben Claes',
  'Julie Maes',
  'Bram Lenaerts',
  'Sara De Smet',
  'Milan Jacobs',
  'Ilias Benali',
  'Fien Goossens',
  'Tuur Hermans',
  'Nina Willems',
  'Lars Michiels',
  'Hanne Dierckx',
  'Seppe Mertens',
  'Elise Aerts',
  'Daan Vandenberghe',
  'Mona Cools',
  'Jules Maertens',
  'Amira El Idrissi',
  'Wout Smolders',
  'Lore Van den Bossche',
  'Jonas Geerts',
  'Mila Vercammen',
  'Niels Van Acker',
  'Helena Peeters',
  'Samir Haddad',
  'Anouk De Ridder',
  'Victor Jans',
  'Ella Van Damme',
  'Arne Lauwers',
  'Sofie Baert',
  'Younes Bakkali',
  'Kato Schreurs',
  'Robbe Thys',
  'Lina Verhoeven',
  'Mathis Vermeulen',
];
const LABEL_PATTERNS = [
  ['Speedteam Blue', 'Dames'],
  ['Speedteam White', 'Anciens'],
  ['HILOK', '1ste jaar'],
  ['Mesacosa', 'Dames'],
  ['Kinesia', 'Anciens'],
  ['Speedteam Blue', '1ste jaar'],
  ['Speedteam White'],
  ['Mesacosa', '1ste jaar'],
  ['Kinesia'],
  ['Dames'],
  ['Speedteam Blue'],
  ['HILOK', 'Dames'],
];

/** A number in [0, 1) that is the same every time for the same key, so a restart replays the same race. */
function unit(key: string): number {
  return createHash('sha256').update(key).digest().readUInt32BE(0) / 2 ** 32;
}

/** Each runner has a pace of their own; each lap varies a few seconds around it. */
function plannedLapMs(runnerId: string, startedAt: number): number {
  const pace = MIN_LAP_MS + 2_000 + unit(`pace:${runnerId}`) * (MAX_LAP_MS - MIN_LAP_MS - 4_000);
  const noise = (unit(`lap:${runnerId}:${startedAt}`) - 0.5) * 8_000;
  return Math.round(Math.min(MAX_LAP_MS, Math.max(MIN_LAP_MS, pace + noise)));
}

const BRUSSELS_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Brussels',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function brusselsOffsetMs(atMs: number): number {
  const parts = Object.fromEntries(BRUSSELS_PARTS.formatToParts(atMs).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(atMs / 1000) * 1000;
}

/** The most recent 20:00 in Brussels at or before `nowMs`. */
export function latestDemoRaceStart(nowMs: number): number {
  const local = new Date(nowMs + brusselsOffsetMs(nowMs));
  let day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), RACE_START_HOUR);
  for (;;) {
    const start = day - brusselsOffsetMs(day);
    if (start <= nowMs) return start;
    day -= 86_400_000;
  }
}

function resetRace(startedAt: number): void {
  for (const table of [
    'laps',
    'handoff_history',
    'race_events',
    'temporary_team_members',
    'runner_labels',
    'runners',
  ]) {
    run(`DELETE FROM ${table}`);
  }
  run(
    `UPDATE race_state
     SET active_runner_id = NULL, active_started_at = NULL, race_started_at = NULL,
         race_finished_at = NULL, active_labels_json = NULL
     WHERE id = 1`
  );
  RUNNER_NAMES.forEach((name, index) =>
    insertRunner({
      name,
      runnerNumber: String(101 + index),
      labels: LABEL_PATTERNS[index % LABEL_PATTERNS.length],
      targetLaps: 10 + (index % 12),
      registrationSource: 'manual',
      status: 'registered',
      statusSince: startedAt,
    })
  );
  fillQueue(startedAt);
  performHandoff(startedAt);
  fillQueue(startedAt);
}

/** Keeps a few runners waiting, longest-rested first, the way the operators would. */
function fillQueue(nowMs: number): void {
  const waiting = all<{ count: number }>("SELECT COUNT(*) AS count FROM runners WHERE status = 'waiting'")[0].count;
  const missing = WAITING_RUNNERS - waiting;
  if (missing <= 0) return;
  const rested = all<{ id: string }>(
    `SELECT id FROM runners
     WHERE status IN ('registered', 'ran', 'warming_up')
     ORDER BY status_since ASC, runner_number ASC
     LIMIT ?`,
    [missing]
  );
  let queueIndex = getMaxQueueIndex() + 1;
  for (const { id } of rested) {
    run("UPDATE runners SET status = 'waiting', queue_index = ?, status_since = ?, hidden_at = NULL WHERE id = ?", [
      queueIndex,
      nowMs,
      id,
    ]);
    queueIndex += 1;
  }
}

/** Brings the race up to `nowMs`; returns whether anything changed. */
export function advanceDemoRace(nowMs: number): boolean {
  return transaction(() => {
    let changed = false;
    const raceStart = latestDemoRaceStart(nowMs);
    if (getRaceState().raceStartedAt !== raceStart) {
      resetRace(raceStart);
      changed = true;
    }
    for (;;) {
      const race = getRaceState();
      if (!race.activeRunnerId || race.activeStartedAt === null) break;
      const finishedAt = race.activeStartedAt + plannedLapMs(race.activeRunnerId, race.activeStartedAt);
      if (finishedAt > nowMs) break;
      fillQueue(finishedAt);
      if (!getNextWaitingRunner()) break;
      performHandoff(finishedAt);
      fillQueue(finishedAt);
      changed = true;
    }
    return changed;
  });
}

export function startDemoRace(): () => void {
  const tick = () => {
    try {
      if (advanceDemoRace(Date.now())) markAppDataChanged();
    } catch (error) {
      console.error('Demo race step failed', error);
    }
  };
  tick();
  const timer = setInterval(tick, 1_000);
  return () => clearInterval(timer);
}
