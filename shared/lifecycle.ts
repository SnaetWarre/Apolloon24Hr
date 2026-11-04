import type { RaceState, RunnerStatus } from './schemas.js';

/*
 * The three state machines of a race day, in one place for the server and the screens:
 * the race itself, a runner's lane on Wachtrij, and the undo stack of Timing. The server
 * checks every write against these rules; the screens use them to offer only moves the
 * server takes.
 */

// ---------------------------------------------------------------------------------------
// The race

/**
 * Where the race is. `race_state` stores it as nullable columns; read them through this.
 *
 * - `not_started`: nothing clocked yet, or Race wissen ran.
 * - `running`: a runner is on the track.
 * - `idle`: started, but the queue ran empty, so nobody is on the track.
 * - `finished`: Race beëindigen was pressed.
 */
export type RacePhase = 'not_started' | 'running' | 'idle' | 'finished';

type RaceColumns = Pick<RaceState, 'activeRunnerId' | 'activeStartedAt' | 'raceStartedAt' | 'raceFinishedAt'>;

export function racePhase(race: RaceColumns): RacePhase {
  if (race.raceStartedAt === null) return 'not_started';
  if (race.raceFinishedAt !== null) return 'finished';
  return race.activeRunnerId === null ? 'idle' : 'running';
}

/** What is wrong with columns that are no phase at all, or null when they are one. */
export function raceStateProblem(race: RaceColumns): string | null {
  if ((race.activeRunnerId === null) !== (race.activeStartedAt === null)) {
    return 'een loper op de piste zonder starttijd';
  }
  if (race.raceStartedAt === null && (race.activeRunnerId !== null || race.raceFinishedAt !== null)) {
    return 'een loper of einde zonder start';
  }
  if (race.raceFinishedAt !== null && race.activeRunnerId !== null) return 'een loper op de piste na het einde';
  return null;
}

/**
 * The presses on Timing. `start` puts the first waiting runner on the track when nobody is,
 * `handoff` clocks the runner on the track and starts the next one (or nobody when the queue
 * is empty), `finish` ends the race, and `resume` starts the next runner after the end. Undo
 * and Race wissen are not presses: undo goes back to the state its entry saved, and Race
 * wissen goes back to `not_started`, from any phase.
 */
export type RaceMove = 'start' | 'handoff' | 'finish' | 'resume';

export const RACE_MOVES: Record<RacePhase, readonly RaceMove[]> = {
  not_started: ['start'],
  running: ['handoff', 'finish'],
  idle: ['start', 'finish'],
  finished: ['resume'],
};

export function canMoveRace(race: RaceColumns, move: RaceMove): boolean {
  return RACE_MOVES[racePhase(race)].includes(move);
}

/** Why the race cannot make `move` now, in words for the operator. */
export function raceMoveRefusal(race: RaceColumns, move: RaceMove): string {
  const phase = racePhase(race);
  if (phase === 'finished') {
    return move === 'finish' ? 'De race is al afgesloten.' : 'De race is afgesloten. Hervat de race eerst.';
  }
  if (phase === 'not_started' && move === 'finish') return 'De race is nog niet gestart.';
  if (move === 'resume') return 'De race is niet afgesloten.';
  if (move === 'start') return 'Er loopt al een loper';
  return 'Er loopt geen loper.';
}

/**
 * Started and not finished, whatever was clocked: the laptop stays awake, closing asks first,
 * and updates wait. A race that only ran a test lap or two counts too.
 */
export function raceIsOpen(race: Pick<RaceState, 'raceStartedAt' | 'raceFinishedAt'>): boolean {
  return race.raceStartedAt !== null && race.raceFinishedAt === null;
}

/**
 * A race with fewer laps than this is a test: a start or a few laps to try the timing
 * screen. At 70 to 85 s a lap, the real race passes it in about 13 minutes.
 */
export const RACE_COUNTS_FROM_LAPS = 10;

/**
 * Whether the race counts as the real one for linking laptops: started means at least
 * RACE_COUNTS_FROM_LAPS laps, running means that and not finished. A test never decides
 * which laptop keeps its data on Koppelen, and never stops two laptops from merging.
 */
export function countedRaceProgress(
  lapCount: number,
  race: Pick<RaceState, 'raceFinishedAt'>
): { raceStarted: boolean; raceRunning: boolean } {
  const raceStarted = lapCount >= RACE_COUNTS_FROM_LAPS;
  return { raceStarted, raceRunning: raceStarted && race.raceFinishedAt === null };
}

// ---------------------------------------------------------------------------------------
// A runner's lane

/** The lanes an operator moves runners between, on Wachtrij and in a runner's profile. */
export const QUEUE_STATUSES = ['registered', 'warming_up', 'waiting'] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export function isQueueStatus(status: RunnerStatus): status is QueueStatus {
  return (QUEUE_STATUSES as readonly RunnerStatus[]).includes(status);
}

/**
 * The moves an operator makes. Only Timing moves a runner onto the track (waiting →
 * running) and off it (running → ran). Undo puts back the runners its entry saved, and
 * Race wissen makes everyone `registered` again. A runner who ran can be hidden from
 * Wachtrij until they move again.
 */
export const RUNNER_MOVES: Record<RunnerStatus, readonly QueueStatus[]> = {
  registered: ['warming_up', 'waiting'],
  warming_up: ['registered', 'waiting'],
  waiting: ['registered', 'warming_up'],
  running: [],
  ran: ['warming_up', 'waiting'],
};

/** Timing's own moves, from the lane each one starts in: onto the track from the queue, off it after the lap. */
export const TIMING_RUNNER_MOVES = { running: 'waiting', ran: 'running' } as const;
export type TimingStatus = keyof typeof TIMING_RUNNER_MOVES;

/** Whether an operator may move a runner from `from` to `to`. The same lane is no move. */
export function canMoveRunner(from: RunnerStatus, to: RunnerStatus): to is QueueStatus {
  return (RUNNER_MOVES[from] as readonly RunnerStatus[]).includes(to);
}

/** The lane the one-click button on Wachtrij sends a runner to: warming up goes to the queue, anyone else warms up. */
export function nextLane(status: RunnerStatus): QueueStatus | null {
  const to = status === 'warming_up' ? 'waiting' : 'warming_up';
  return canMoveRunner(status, to) ? to : null;
}

/** Only a runner who ran can be hidden from Wachtrij. */
export function canHideRunner(status: RunnerStatus): boolean {
  return status === 'ran';
}

/** A runner moved to the queue joins at the back; the other lanes have no place. */
export function queueIndexAfterMove(to: QueueStatus, lastQueueIndex: number): number | null {
  return to === 'waiting' ? lastQueueIndex + 1 : null;
}

// ---------------------------------------------------------------------------------------
// The undo stack of Timing

/**
 * What an entry on the undo stack takes back: a press that clocked or started a runner,
 * or Race beëindigen. Undoing a finish reopens the race with the same runner on the track.
 */
export type UndoKind = 'handoff' | 'finish';

/**
 * Whether Timing can undo now, given the kind of the newest entry (null when the stack is
 * empty). A finished race only undoes its own finish: a race finished by a version that
 * stored no step for it must be resumed first, or undo would take back the handoff before.
 */
export function canUndo(race: RaceColumns, nextUndo: UndoKind | null): boolean {
  if (nextUndo === null) return false;
  return racePhase(race) !== 'finished' || nextUndo === 'finish';
}

/** Why Timing cannot undo now, in words for the operator. */
export function undoRefusal(race: RaceColumns): string {
  return racePhase(race) === 'finished'
    ? 'De race is afgesloten. Hervat de race eerst om een wissel ongedaan te maken.'
    : 'Er is geen wissel om ongedaan te maken';
}
