import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blockCoversMoment,
  brusselsMoment,
  findAvailableUncalledRunners,
  formatMomentBlock,
  isAvailableAtMoment,
  parseHourBlock,
} from '../src/lib/availability.ts';
import type { Runner, RunnerRegistration } from '../src/types.ts';

function runner(overrides: Partial<Runner> & Pick<Runner, 'id' | 'name' | 'status'>): Runner {
  return {
    runnerNumber: null,
    targetLaps: null,
    historicalAvgMs: null,
    historicalBestMs: null,
    registrationSource: 'import',
    notes: '',
    estimatedPace: null,
    createdAt: 0,
    updatedAt: 0,
    statusSince: null,
    queueIndex: null,
    hiddenFromQueue: false,
    queueHiddenAt: null,
    labels: [],
    lapCount: 0,
    lastLapMs: null,
    bestLapMs: null,
    slowestLapMs: null,
    averageLapMs: null,
    totalTimeMs: 0,
    ...overrides,
  };
}

function registration(availableHours: string[], phone = '0470 00 00 00'): RunnerRegistration {
  return {
    submittedAt: '',
    email: '',
    phone,
    studyPhase: '',
    estimatedLaps: '',
    estimatedPace: '',
    maxLapsPerBlock: '',
    availableHours,
    reuseConsent: '',
    flexibility: 'Een kwartier vroeger of later',
    remarks: '',
    categories: [],
  };
}

test('hour blocks from the form parse with and without a weekday', () => {
  assert.deepEqual(parseHourBlock('20-21u (dinsdag)'), { startHour: 20, endHour: 21, weekday: 'dinsdag' });
  assert.deepEqual(parseHourBlock('23-00u (dinsdag)'), { startHour: 23, endHour: 0, weekday: 'dinsdag' });
  assert.deepEqual(parseHourBlock(' 8-9u '), { startHour: 8, endHour: 9, weekday: null });
  assert.deepEqual(parseHourBlock('22u–24u (Woensdag)'), { startHour: 22, endHour: 0, weekday: 'woensdag' });
  assert.equal(parseHourBlock('zoveel mogelijk'), null);
  assert.equal(parseHourBlock('25-26u'), null);
});

test('a block covers its start hour but not its end hour, also across midnight', () => {
  const evening = parseHourBlock('20-21u (dinsdag)')!;
  assert.equal(blockCoversMoment(evening, { hour: 20, weekday: 'dinsdag' }), true);
  assert.equal(blockCoversMoment(evening, { hour: 21, weekday: 'dinsdag' }), false);
  assert.equal(blockCoversMoment(evening, { hour: 20, weekday: 'woensdag' }), false);

  const midnight = parseHourBlock('23-00u (dinsdag)')!;
  assert.equal(blockCoversMoment(midnight, { hour: 23, weekday: 'dinsdag' }), true);
  assert.equal(blockCoversMoment(midnight, { hour: 0, weekday: 'dinsdag' }), false);

  const anyDay = parseHourBlock('03-04u')!;
  assert.equal(blockCoversMoment(anyDay, { hour: 3, weekday: 'zaterdag' }), true);
  assert.equal(isAvailableAtMoment(['nonsense', '03-04u'], { hour: 3, weekday: 'zaterdag' }), true);
});

test('the Brussels clock gives the hour and Dutch weekday the form uses', () => {
  // 2026-09-29T14:30Z is 16:30 in Brussels (CEST), a Tuesday.
  const moment = brusselsMoment(Date.UTC(2026, 8, 29, 14, 30));
  assert.deepEqual(moment, { hour: 16, weekday: 'dinsdag' });
  assert.equal(formatMomentBlock(moment), '16-17u (dinsdag)');
  assert.equal(formatMomentBlock({ hour: 23, weekday: 'dinsdag' }), '23-00u (dinsdag)');
});

test('only runners who are available now and not on the board are listed, unrun first', () => {
  const now = { hour: 16, weekday: 'dinsdag' };
  const runners = [
    runner({ id: 'ran', name: 'Al Gelopen', runnerNumber: '101', status: 'ran', lapCount: 2 }),
    runner({ id: 'fresh', name: 'Nog Niet', runnerNumber: '120', status: 'registered' }),
    runner({ id: 'warming', name: 'Warm Loper', runnerNumber: '102', status: 'warming_up' }),
    runner({ id: 'waiting', name: 'Wacht Loper', runnerNumber: '103', status: 'waiting' }),
    runner({ id: 'running', name: 'Loopt Nu', runnerNumber: '104', status: 'running' }),
    runner({ id: 'hidden', name: 'Verborgen', runnerNumber: '105', status: 'registered', hiddenFromQueue: true }),
    runner({ id: 'later', name: 'Later Pas', runnerNumber: '106', status: 'registered' }),
    runner({ id: 'noform', name: 'Zonder Formulier', runnerNumber: '107', status: 'registered' }),
    runner({ id: 'nonumber', name: 'Zonder Nummer', status: 'registered' }),
  ];
  const registrations: Record<string, RunnerRegistration> = {
    ran: registration(['16-17u (dinsdag)']),
    fresh: registration(['12-13u (dinsdag)', '16-17u (dinsdag)'], '0471 11 22 33'),
    warming: registration(['16-17u (dinsdag)']),
    waiting: registration(['16-17u (dinsdag)']),
    running: registration(['16-17u (dinsdag)']),
    hidden: registration(['16-17u (dinsdag)']),
    later: registration(['20-21u (dinsdag)']),
    nonumber: registration(['16-17u (dinsdag)']),
  };

  const available = findAvailableUncalledRunners(runners, registrations, now);
  assert.deepEqual(
    available.map(({ runner: { id }, phone }) => [id, phone]),
    [
      ['fresh', '0471 11 22 33'],
      ['nonumber', '0470 00 00 00'],
      ['ran', '0470 00 00 00'],
    ]
  );
  assert.equal(available[0].flexibility, 'Een kwartier vroeger of later');
  assert.deepEqual(
    findAvailableUncalledRunners(runners, registrations, { hour: 20, weekday: 'dinsdag' }).map(
      ({ runner: { id } }) => id
    ),
    ['later']
  );
});
