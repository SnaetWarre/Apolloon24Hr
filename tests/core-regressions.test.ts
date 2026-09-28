import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import Papa from 'papaparse';
import type { Active, CollisionDetection, DroppableContainer } from '@dnd-kit/core';
import { buildRollingLapTrend, buildTimeBuckets } from '../src/lib/analysis.ts';
import { kanbanCollisionDetection, resolveKanbanDrop } from '../src/lib/kanban.ts';
import { createUuid } from '../src/lib/uuid.ts';
import { buildEventReadiness, readinessSummary } from '../src/lib/readiness.ts';
import { observeDisplayHistory } from '../src/lib/displayHistory.ts';
import {
  buildRecentLapSummaries,
  buildRunnerRanking,
  calculateLapCoefficient,
  calculateLapPoints,
} from '../src/lib/ranking.ts';
import {
  LIVE_MILLISECOND_INTERVAL_MS,
  normalizeClockInterval,
  SECOND_DISPLAY_INTERVAL_MS,
} from '../src/lib/useAnimationFrameTick.ts';
import type { ClusterStatus, Label, LapRecord, RaceState, Runner } from '../src/types.ts';
import { relativeFileWithinRoot } from '../server/static-files.ts';

const dataPath = path.resolve(`.tmp-test-core-regressions-${process.pid}`);
process.env.DATA_PATH = dataPath;
type ClientRect = Parameters<CollisionDetection>[0]['collisionRect'];

test('browser UUIDs work when randomUUID is unavailable on a LAN HTTP origin', () => {
  const uuid = createUuid({
    getRandomValues(bytes) {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = index;
      }
      return bytes;
    },
  });

  assert.equal(uuid, '00010203-0405-4607-8809-0a0b0c0d0e0f');
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const appActions = fs.readFileSync(path.resolve('src/app/useAppActions.ts'), 'utf8');
  assert.doesNotMatch(appActions, /\bcrypto\.randomUUID\(/);
});

test('live clocks are cadence-limited instead of driving full-frame renders', () => {
  assert.equal(normalizeClockInterval(0), 16);
  assert.equal(normalizeClockInterval(16), 16);
  assert.equal(normalizeClockInterval(LIVE_MILLISECOND_INTERVAL_MS), 33);
  assert.equal(SECOND_DISPLAY_INTERVAL_MS, 500);
  assert.equal(normalizeClockInterval(100), 100);
  assert.equal(normalizeClockInterval(Number.NaN), 1_000);

  const source = fs.readFileSync(path.resolve('src/lib/useAnimationFrameTick.ts'), 'utf8');
  assert.doesNotMatch(source, /requestAnimationFrame/);
});

test('heavy route modules load on demand while operator controls stay eager', () => {
  const appSource = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8');
  const lazyViewsSource = fs.readFileSync(path.resolve('src/lazyViews.tsx'), 'utf8');

  assert.match(appSource, /import \{ TimingView \} from '\.\/components\/TimingView'/);
  assert.match(appSource, /import \{ KanbanBoard \} from '\.\/components\/KanbanBoard'/);
  assert.doesNotMatch(appSource, /from '\.\/components\/(AdminView|AnalysisView|DisplayViews)'/);
  assert.match(lazyViewsSource, /import\('\.\/components\/AnalysisView'\)/);
  assert.match(lazyViewsSource, /import\('\.\/components\/AdminView'\)/);
  assert.match(lazyViewsSource, /import\('\.\/components\/DisplayViews'\)/);
  assert.match(appSource, /<React\.Suspense fallback=\{fallback\}>/);
});

test('initial rendering overlaps state transfer and defers non-critical realtime code', () => {
  const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
  const appData = fs.readFileSync(path.resolve('src/app/useAppData.ts'), 'utf8');
  const realtime = fs.readFileSync(path.resolve('src/app/useRealtimeBridge.ts'), 'utf8');
  const logo = fs.readFileSync(path.resolve('public/brand/apolloon-logo.png'));

  assert.match(html, /rel="preload" as="image"[^>]+fetchpriority="high"/);
  assert.match(html, /__APOLLOON_STATE_PROMISE__ = fetch\('\/api\/state'\)/);
  assert.match(appData, /const prefetched = window\.__APOLLOON_STATE_PROMISE__/);
  assert.match(realtime, /import\('\.\/realtimeClient'\)/);
  assert.equal(logo.readUInt32BE(16), 560);
  assert.equal(logo.readUInt32BE(20), 169);
  assert.ok(logo.length < 15_000);
});

test('outside display fits the viewport and announces only new history', () => {
  assert.equal(observeDisplayHistory(false, null, [], null), null);

  const initialHistory = observeDisplayHistory(true, null, ['existing-event'], 'existing-event');
  assert.ok(initialHistory);
  assert.equal(initialHistory.shouldAnnounceLatest, false);
  assert.deepEqual([...initialHistory.knownIds], ['existing-event']);

  const unchangedHistory = observeDisplayHistory(
    true,
    initialHistory.knownIds,
    ['existing-event'],
    'existing-event'
  );
  assert.ok(unchangedHistory);
  assert.equal(unchangedHistory.shouldAnnounceLatest, false);

  const realtimeHistory = observeDisplayHistory(
    true,
    unchangedHistory.knownIds,
    ['new-event', 'existing-event'],
    'new-event'
  );
  assert.ok(realtimeHistory);
  assert.equal(realtimeHistory.shouldAnnounceLatest, true);

  const styles = fs.readFileSync(path.resolve('src/styles/displays.css'), 'utf8');
  assert.match(
    styles,
    /\.display-root--outside\s*\{[^}]*height:\s*100vh;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s
  );
});

test('lap coefficients use the 85-second reference and 0.075 points per second', () => {
  const examples = [
    [65_000, 2.5],
    [68_200, 2.26],
    [78_400, 1.495],
    [84_300, 1.0525],
    [85_000, 1],
    [85_600, 1],
    [87_400, 1],
    [89_000, 1],
    [90_000, 1],
    [100_000, 1],
  ] as const;

  for (const [durationMs, expectedCoefficient] of examples) {
    assert.ok(Math.abs(calculateLapCoefficient(durationMs) - expectedCoefficient) < 1e-10);
  }
});

test('lap points use the finishing time in Brussels across all six four-hour blocks', () => {
  const examples = [
    ['2026-09-23T22:00:00Z', 1.25], // 00:00 in Brussels
    ['2026-09-24T02:00:00Z', 1.5],  // 04:00
    ['2026-09-24T06:00:00Z', 1.5],  // 08:00
    ['2026-09-24T10:00:00Z', 1.25], // 12:00
    ['2026-09-24T14:00:00Z', 1],    // 16:00
    ['2026-09-24T18:00:00Z', 1],    // 20:00
    ['2026-09-24T21:59:59Z', 1],    // 23:59
  ] as const;

  for (const [finishedAt, expectedPoints] of examples) {
    assert.equal(calculateLapPoints({ durationMs: 85_000, finishedAt: Date.parse(finishedAt) }), expectedPoints);
  }
  assert.equal(calculateLapPoints({ durationMs: 80_000, finishedAt: Date.parse(examples[0][0]) }), 1.71875);
  assert.equal(calculateLapPoints({ durationMs: 85_000, finishedAt: Number.NaN }), 0);
  assert.equal(calculateLapPoints({ durationMs: 100_000, finishedAt: Date.parse(examples[0][0]) }), 1.25);
});

test('lap points follow Brussels daylight saving time', () => {
  assert.equal(calculateLapPoints({ durationMs: 85_000, finishedAt: Date.parse('2026-10-25T02:00:00Z') }), 1.25);
  assert.equal(calculateLapPoints({ durationMs: 85_000, finishedAt: Date.parse('2026-10-25T03:00:00Z') }), 1.5);
});

test('lap points match the example totals in coeff_berekeningen.xlsx', () => {
  const points = (finishedAt: string) => calculateLapPoints({
    durationMs: 80_000,
    finishedAt: Date.parse(finishedAt),
  });

  assert.equal(points('2026-09-23T18:00:00Z') + points('2026-09-23T22:00:00Z'), 3.09375);
  assert.equal(
    points('2026-09-24T02:00:00Z') + points('2026-09-24T06:00:00Z') + points('2026-09-24T10:00:00Z'),
    5.84375
  );
  assert.equal(points('2026-09-24T14:00:00Z'), 1.375);
});

test('inside rankings switch metric and filter laps by their historical label', () => {
  const firstYearsLabel = {
    id: 'first-years',
    name: 'Eerstejaars',
    color: '#2877F6',
    icon: 'E',
    kind: 'custom',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 1,
  } satisfies Label;
  const runners = [
    { id: 'steady', name: 'Steady', runnerNumber: '1' },
    { id: 'fast', name: 'Fast', runnerNumber: '2' },
  ] as Runner[];
  const lap = (id: string, runnerId: string, durationMs: number, labels: Label[]): LapRecord => ({
    id,
    runnerId,
    runnerName: runnerId === 'steady' ? 'Steady' : 'Fast',
    runnerNumber: runnerId === 'steady' ? '1' : '2',
    lapNumber: 1,
    startedAt: 1_000,
    finishedAt: 1_000 + durationMs,
    durationMs,
    source: 'handoff',
    createdAt: 1_000 + durationMs,
    labels,
  });
  const laps = [
    lap('steady-1', 'steady', 89_000, [firstYearsLabel]),
    lap('steady-2', 'steady', 89_000, [firstYearsLabel]),
    lap('fast-1', 'fast', 65_000, [firstYearsLabel]),
    lap('fast-other-label', 'fast', 65_000, []),
  ];

  assert.deepEqual(
    buildRunnerRanking(runners, laps, 'laps', firstYearsLabel.id).map((entry) => entry.runnerId),
    ['steady', 'fast']
  );
  assert.deepEqual(
    buildRunnerRanking(runners, laps, 'coefficient', firstYearsLabel.id).map((entry) => entry.runnerId),
    ['fast', 'steady']
  );
  assert.equal(buildRunnerRanking(runners, laps, 'coefficient', null)[0]?.coefficientTotal, 6.25);

  const displaySource = fs.readFileSync(path.resolve('src/components/DisplayViews.tsx'), 'utf8');
  assert.match(displaySource, /INSIDE_RANKING_ROTATION_MS = 15_000/);
  assert.match(displaySource, /window\.setTimeout/);
  assert.match(displaySource, /window\.clearTimeout/);
  assert.match(displaySource, /currentMode === 'laps' \? 'coefficient' : 'laps'/);
  assert.match(displaySource, /prefers-reduced-motion: reduce/);
  assert.match(displaySource, /if \(prefersReducedMotion \|\| rotationPaused\) return/);
  assert.match(displaySource, /removeEventListener\('change', updateReducedMotionPreference\)/);
});

test('the three recent laps show each runners all-time best and average', () => {
  const lap = (id: string, runnerId: string, durationMs: number, finishedAt: number): LapRecord => ({
    id,
    runnerId,
    runnerName: runnerId,
    runnerNumber: null,
    lapNumber: 1,
    startedAt: finishedAt - durationMs,
    finishedAt,
    durationMs,
    source: 'handoff',
    createdAt: finishedAt,
    labels: [],
  });
  const summaries = buildRecentLapSummaries([
    lap('older-a', 'runner-a', 90_000, 1_000),
    lap('recent-a', 'runner-a', 70_000, 4_000),
    lap('recent-b', 'runner-b', 80_000, 3_000),
    lap('recent-c', 'runner-c', 85_000, 2_000),
  ]);

  assert.deepEqual(summaries.map((summary) => summary.lap.id), ['recent-a', 'recent-b', 'recent-c']);
  assert.equal(summaries[0]?.bestLapMs, 70_000);
  assert.equal(summaries[0]?.averageLapMs, 80_000);

  const displaySource = fs.readFileSync(path.resolve('src/components/DisplayViews.tsx'), 'utf8');
  assert.match(displaySource, /ronde \{lap\.lapNumber\}/);
  assert.match(displaySource, /<strong>\{formatDurationMs\(lap\.durationMs\)\}<\/strong>/);
  assert.match(displaySource, />Deze ronde</);
  assert.match(displaySource, />Snelste ronde</);
  assert.match(displaySource, />Gem\. ronde</);
});

test('event readiness blocks real safety failures and distinguishes standalone warnings', () => {
  const now = Date.UTC(2026, 7, 3, 20, 0, 0);
  const race: RaceState = {
    id: 1,
    activeRunnerId: null,
    activeStartedAt: null,
    raceStartedAt: null,
    raceFinishedAt: null,
    activeLabels: [],
  };
  const cluster: ClusterStatus = {
    enabled: true,
    hostId: 'host-a',
    clusterId: 'cluster',
    pairingCode: 'PAIR',
    role: 'local-first',
    compatibility: {
      protocolVersion: 3,
      schemaVersion: 9,
      minimumSchemaVersion: 9,
      replicationFormatVersion: 1,
      minimumReplicationFormatVersion: 1,
      appVersion: '1.0.0',
      minimumAppVersion: '1.0.0',
      releaseId: 'test',
    },
    incompatiblePeerCount: 0,
    writable: true,
    connectedHosts: 2,
    knownHosts: 2,
    pendingOperations: 0,
    conflictCount: 0,
    timingControllerHostId: 'host-a',
    timingControl: {
      state: 'local',
      controllerHostId: 'host-a',
      generation: 1,
      controllerUrl: 'http://host-a:5173',
      controllerLastSeenAt: now,
      localReplicaCaughtUp: true,
      takeoverAllowed: false,
      takeoverAvailableAt: null,
      forcedTakeoverAllowed: false,
      forcedTakeoverAvailableAt: null,
    },
    clockSkewMs: 50,
    lastAppliedSeq: 3,
    peers: [
      {
        id: 'host-b',
        url: 'http://host-b:5173',
        reachable: true,
        lastSeenAt: now,
        lastSeq: 3,
        synchronized: true,
        compatibility: null,
        compatibilityError: null,
      },
    ],
    backup: {
      enabled: true,
      inProgress: false,
      queued: false,
      maintenanceInProgress: false,
      intervalMs: 300_000,
      nextScheduledAt: now + 300_000,
      retainedCount: 2,
      retainedBytes: 2_048,
      maximumRetainedBytes: 8 * 1_024 ** 3,
      latest: {
        fileName: 'backup.sqlite',
        createdAt: now - 60_000,
        reason: 'scheduled',
        sizeBytes: 1_024,
        sha256: 'a'.repeat(64),
        verified: true,
      },
      lastFailureAt: null,
      lastError: null,
      diskFreeBytes: 10 * 1_024 ** 3,
      diskTotalBytes: 20 * 1_024 ** 3,
      minimumFreeBytes: 2 * 1_024 ** 3,
      diskLow: false,
      database: {
        fileBytes: 2_048,
        usedBytes: 2_048,
        reclaimableBytes: 0,
        reclaimablePercent: 0,
        compactionRecommended: false,
        raceActive: false,
        lastCompactedAt: null,
      },
    },
  };

  assert.equal(readinessSummary(buildEventReadiness(cluster, race, now)), 'ready');
  const compactableDatabaseReadiness = buildEventReadiness(
    {
      ...cluster,
      backup: {
        ...cluster.backup,
        database: {
          ...cluster.backup.database,
          reclaimableBytes: 1_024,
          reclaimablePercent: 50,
          compactionRecommended: true,
          raceActive: true,
        },
      },
    },
    race,
    now
  );
  assert.equal(
    compactableDatabaseReadiness.find((check) => check.id === 'database-size')?.level,
    'ready'
  );
  assert.equal(readinessSummary(compactableDatabaseReadiness), 'ready');
  assert.equal(
    readinessSummary(
      buildEventReadiness(
        {
          ...cluster,
          conflictCount: 1,
          backup: { ...cluster.backup, diskLow: true },
        },
        race,
        now
      )
    ),
    'blocked'
  );
  assert.equal(
    readinessSummary(
      buildEventReadiness(
        { ...cluster, enabled: false, role: 'standalone', peers: [], connectedHosts: 1 },
        race,
        now
      )
    ),
    'warning'
  );
});

test('packaged static files stay relative to the AppImage mount root', () => {
  const hiddenMountRoot = path.join('/tmp', '.mount_LeuvenExample', 'resources', 'app.asar.unpacked');
  const distRoot = path.join(hiddenMountRoot, 'dist');

  assert.equal(
    relativeFileWithinRoot(distRoot, path.join(distRoot, 'assets', 'app.js.br')),
    path.join('assets', 'app.js.br')
  );
  assert.equal(relativeFileWithinRoot(distRoot, path.join(distRoot, 'index.html')), 'index.html');
  assert.equal(relativeFileWithinRoot(distRoot, path.join(hiddenMountRoot, 'secret.txt')), null);

  const serverSource = fs.readFileSync(path.resolve('server/index.ts'), 'utf8');
  assert.doesNotMatch(serverSource, /sendFile\(compressed\.path\)/);
  assert.match(serverSource, /sendFile\(relativePath, \{ root: DIST_DIR \}\)/);
  assert.match(serverSource, /sendFile\('index\.html', \{ root: DIST_DIR \}\)/);
});

test('production builds enforce the client startup budget', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const budgetSource = fs.readFileSync(path.resolve('scripts/check-client-budget.mjs'), 'utf8');

  assert.match(packageJson.scripts['client:build'], /check-client-budget\.mjs/);
  assert.match(budgetSource, /maximumInitialJavaScriptBytes/);
  assert.match(budgetSource, /maximumInitialBrotliBytes/);
  assert.match(budgetSource, /modulepreload/);
});

test('admin panels use explicit responsive regions instead of the analysis auto-fit grid', () => {
  const adminSource = fs.readFileSync(path.resolve('src/components/AdminView.tsx'), 'utf8');
  const stylesSource = fs.readFileSync(path.resolve('src/styles/admin.css'), 'utf8');

  assert.match(adminSource, /className="admin-dashboard"/);
  assert.doesNotMatch(adminSource, /className="analysis-grid"/);
  assert.match(adminSource, /admin-dashboard__full-width/);
  assert.match(adminSource, /admin-dashboard__labels/);
  // One section at a time in a single explicit column; never an auto-fit card grid.
  assert.match(stylesSource, /\.admin-dashboard\s*\{\s*display: grid;\s*gap:/);
  assert.doesNotMatch(stylesSource, /\.admin-dashboard\s*\{[^}]*auto-fit/);
  assert.match(stylesSource, /@media \(max-width: 900px\)[\s\S]*?\.management-workspace\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/);
});

test('operator views share the Apolloon design tokens and accessible navigation states', () => {
  const appSource = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8');
  const displaySource = fs.readFileSync(path.resolve('src/components/DisplayViews.tsx'), 'utf8');
  const kanbanSource = fs.readFileSync(path.resolve('src/components/KanbanBoard.tsx'), 'utf8');
  const readStyles = (name: string) => fs.readFileSync(path.resolve('src/styles', name), 'utf8');
  const tokensSource = readStyles('tokens.css');
  const stylesSource = readStyles('primitives.css');

  assert.match(tokensSource, /--apolloon-blue:\s*#0D78D3;/);
  assert.match(tokensSource, /--radius-md:\s*8px;/);
  assert.match(tokensSource, /--focus:/);
  assert.match(readStyles('base.css'), /:focus-visible\s*\{\s*outline: 3px solid var\(--focus\);/);
  assert.match(readStyles('shell.css'), /\.nav-link\[aria-current="page"\]/);
  assert.match(appSource, /aria-current=\{isCurrentPage \? 'page' : undefined\}/);
  assert.match(appSource, /aria-label="Hoofdnavigatie"/);
  assert.doesNotMatch(displaySource, /display-home/);
  assert.match(kanbanSource, /queue-runner--dragging/);
  assert.match(readStyles('queue.css'), /\.queue-runner--dragging\s*\{[^}]*transition:\s*none;/s);
  assert.match(stylesSource, /\.form-row--plain\s*\{[^}]*border:\s*0;[^}]*box-shadow:\s*none;/s);
});

test('analysis hour buckets use Brussels clock hours from the race start', () => {
  const raceStartedAt = Date.parse('2026-10-20T20:00:00+02:00');
  const race = {
    id: 1,
    activeRunnerId: null,
    activeStartedAt: null,
    raceStartedAt,
    raceFinishedAt: null,
    activeLabels: [],
  } satisfies RaceState;
  const lap = (id: string, finishedAt: number): LapRecord => ({
    id,
    runnerId: 'runner-1',
    runnerName: 'Runner',
    runnerNumber: '1',
    startedAt: finishedAt - 60_000,
    finishedAt,
    durationMs: 60_000,
    labels: [],
  });

  const buckets = buildTimeBuckets(
    [
      lap('lap-1', raceStartedAt + 30 * 60_000),
      lap('lap-2', raceStartedAt + 3.5 * 3_600_000),
      lap('lap-3', raceStartedAt + 4.5 * 3_600_000),
    ],
    race
  );

  assert.deepEqual(
    buckets.map((bucket) => bucket.label),
    ['20u-21u', '23u-00u', '00u-01u']
  );
});

test('rolling analysis keeps exact window semantics with a linear sliding window', () => {
  const raceStartedAt = 1_000_000;
  const race = {
    id: 1,
    activeRunnerId: null,
    activeStartedAt: null,
    raceStartedAt,
    raceFinishedAt: null,
    activeLabels: [],
  } satisfies RaceState;
  const lap = (id: string, finishedAt: number, durationMs: number): LapRecord => ({
    id,
    runnerId: 'runner-1',
    runnerName: 'Runner',
    runnerNumber: '1',
    startedAt: finishedAt - durationMs,
    finishedAt,
    durationMs,
    source: 'handoff',
    createdAt: finishedAt,
    labels: [],
    lapNumber: 1,
  });
  const laps = [
    lap('lap-4', raceStartedAt + 121_000, 80_000),
    lap('lap-2', raceStartedAt + 60_000, 70_000),
    lap('lap-1', raceStartedAt, 60_000),
    lap('lap-3', raceStartedAt + 60_000, 90_000),
  ];

  const points = buildRollingLapTrend(laps, race, 1);
  assert.deepEqual(
    points.map((point) => ({ averageMs: point.averageMs, count: point.count })),
    [
      { averageMs: 60_000, count: 1 },
      { averageMs: 73_333, count: 3 },
      { averageMs: 73_333, count: 3 },
      { averageMs: 80_000, count: 1 },
    ]
  );
});

test('dragging a warming-up runner into an empty or populated waiting column sets waiting status', () => {
  const warmingRunner = { id: 'warming-runner', status: 'warming_up' as const };
  const waitingRunner = { id: 'waiting-runner', status: 'waiting' as const };

  assert.deepEqual(resolveKanbanDrop(warmingRunner.id, 'column-waiting', [warmingRunner]), {
    type: 'set-status',
    runnerId: warmingRunner.id,
    status: 'waiting',
  });
  assert.deepEqual(resolveKanbanDrop(warmingRunner.id, waitingRunner.id, [warmingRunner, waitingRunner]), {
    type: 'set-status',
    runnerId: warmingRunner.id,
    status: 'waiting',
  });
});

test('kanban collision detection targets the exact empty column or runner under the pointer', () => {
  const active = {
    id: 'warming-runner',
    data: { current: undefined },
    rect: { current: { initial: null, translated: null } },
  } satisfies Active;
  const rect = (left: number, top: number, width: number, height: number): ClientRect => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });
  const container = (id: string, bounds: ClientRect): DroppableContainer => ({
    id,
    key: id,
    disabled: false,
    data: { current: undefined },
    node: { current: null },
    rect: { current: bounds },
  });
  const warmingColumnRect = rect(0, 0, 300, 800);
  const waitingColumnRect = rect(320, 0, 300, 800);
  const waitingRunnerRect = rect(330, 100, 280, 100);
  const warmingColumn = container('column-warming_up', warmingColumnRect);
  const waitingColumn = container('column-waiting', waitingColumnRect);

  const emptyColumnCollision = kanbanCollisionDetection({
    active,
    collisionRect: rect(350, 500, 280, 100),
    droppableContainers: [warmingColumn, waitingColumn],
    droppableRects: new Map([
      [warmingColumn.id, warmingColumnRect],
      [waitingColumn.id, waitingColumnRect],
    ]),
    pointerCoordinates: { x: 450, y: 550 },
  });
  assert.equal(emptyColumnCollision[0]?.id, 'column-waiting');

  const waitingRunner = container('waiting-runner', waitingRunnerRect);
  const populatedColumnCollision = kanbanCollisionDetection({
    active,
    collisionRect: rect(330, 100, 280, 100),
    droppableContainers: [warmingColumn, waitingColumn, waitingRunner],
    droppableRects: new Map([
      [warmingColumn.id, warmingColumnRect],
      [waitingColumn.id, waitingColumnRect],
      [waitingRunner.id, waitingRunnerRect],
    ]),
    pointerCoordinates: { x: 450, y: 150 },
  });
  assert.equal(populatedColumnCollision[0]?.id, 'waiting-runner');

  const outsideBoardCollisions = kanbanCollisionDetection({
    active,
    collisionRect: rect(700, 100, 280, 100),
    droppableContainers: [warmingColumn, waitingColumn, waitingRunner],
    droppableRects: new Map([
      [warmingColumn.id, warmingColumnRect],
      [waitingColumn.id, waitingColumnRect],
      [waitingRunner.id, waitingRunnerRect],
    ]),
    pointerCoordinates: { x: 800, y: 150 },
  });
  assert.deepEqual(outsideBoardCollisions, []);

});

test('finishing a race retires the active runner without recording an extra lap', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const first = db.insertRunner({ name: 'First runner', runnerNumber: '1' });
    const second = db.insertRunner({ name: 'Second runner', runnerNumber: '2' });
    db.updateRunnerStatus({ id: first.id, status: 'waiting', statusSince: 900, queueIndex: 0 });
    db.updateRunnerStatus({ id: second.id, status: 'waiting', statusSince: 900, queueIndex: 1 });

    assert.deepEqual(db.performHandoff(1_000), {
      ok: true,
      lapId: null,
      startedRunnerId: first.id,
    });

    db.finishRace(2_000);

    assert.deepEqual(db.getRaceState(), {
      id: 1,
      activeRunnerId: null,
      activeStartedAt: null,
      raceStartedAt: 1_000,
      raceFinishedAt: 2_000,
      activeLabels: [],
    });
    assert.equal(db.getRunnerById(first.id)?.status, 'ran');
    assert.equal(db.getRunnerById(first.id)?.statusSince, 2_000);
    assert.equal(db.getRunnerById(first.id)?.lapCount, 0);
    assert.equal(db.getRunnerById(second.id)?.status, 'waiting');
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('reordering requires each waiting runner exactly once', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const runners = ['One', 'Two', 'Three'].map((name, index) => {
      const runner = db.insertRunner({ name, runnerNumber: String(index + 1) });
      db.updateRunnerStatus({ id: runner.id, status: 'waiting', statusSince: 1_000 + index, queueIndex: index });
      return runner;
    });

    assert.throws(
      () => db.updateWaitingOrder([runners[2].id, runners[1].id]),
      /volledige wachtrijvolgorde/
    );

    db.updateWaitingOrder([runners[2].id, runners[0].id, runners[1].id]);
    const queueIndexes = new Map(db.getAllRunners().map((runner) => [runner.id, runner.queueIndex]));
    assert.equal(queueIndexes.get(runners[2].id), 0);
    assert.equal(queueIndexes.get(runners[0].id), 1);
    assert.equal(queueIndexes.get(runners[1].id), 2);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('a failed replicated database command leaves neither partial data nor an operation', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const commandId = crypto.randomUUID();
    assert.throws(
      () =>
        db.commitReplicatedWrite({
          id: commandId,
          type: 'test.forcedFailure',
          payload: { runnerNumber: 'ROLLBACK-1' },
          action: () => {
            db.insertRunner({
              name: 'Must roll back',
              runnerNumber: 'ROLLBACK-1',
            });
            throw new Error('simulated database write failure');
          },
        }),
      /simulated database write failure/
    );
    assert.equal(
      db.getAllRunners().some((runner) => runner.runnerNumber === 'ROLLBACK-1'),
      false
    );
    assert.equal(db.getReplicationOperation(commandId), null);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('timing mutations reject a stale race state instead of recording an extra handoff', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');

  try {
    await db.initDb();
    const first = db.insertRunner({ name: 'First runner', runnerNumber: '1' });
    const second = db.insertRunner({ name: 'Second runner', runnerNumber: '2' });
    db.updateRunnerStatus({ id: first.id, status: 'waiting', statusSince: 900, queueIndex: 0 });
    db.updateRunnerStatus({ id: second.id, status: 'waiting', statusSince: 900, queueIndex: 1 });

    const caller = appRouter.createCaller({});
    const staleRace = { activeRunnerId: null, activeStartedAt: null };
    await caller.race.startNext(staleRace);

    await assert.rejects(caller.race.startNext(staleRace), /Timingstatus is gewijzigd/);
    assert.equal(db.getAllLaps().length, 0);
    assert.equal(db.getRaceState().activeRunnerId, first.id);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

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
      'Ik schat een gemiddelde van ... te lopen op 515m (gemiddelde van alle toertjes)': `1'17\"-1'19\"`,
      'Maximum aantal rondjes dat je in een blok van 2 uur kan lopen. We verspreiden je max. aantal rondjes zo goed mogelijk over de opgegeven uren!': '3',
      'Ik ben volgende uren beschikbaar om te lopen (zoveel mogelijk aanduiden!)\nPS: ben je 1ste bach student?': '20-21u (dinsdag), 03-04u (woensdag)',
      'Ik geef hierbij toestemming dat mijn gegevens opnieuw mogen gebruikt worden in latere jaren in verband met de 24 urenloop.': 'Nee',
      'Hoe flexibel ben jij binnen deze intervallen?': 'Een kwartier vroeger of later',
      'Nog iets dat wij best kunnen weten van hoe jij jouw 24-urenloop ziet?': 'Rustig beginnen',
      'Behoor je tot één van volgende categorieën?': 'Eerstejaars, Vrouw',
    };
    const first = await caller.runners.importCsv({ csvText: Papa.unparse([row]) });
    assert.equal(first.created, 1);
    const imported = db.getAllRunners()[0];
    assert.equal(imported.runnerNumber, '2');
    assert.deepEqual(imported.registration?.availableHours, ['20-21u (dinsdag)', '03-04u (woensdag)']);
    assert.deepEqual(imported.registration?.categories, ['Eerstejaars', 'Vrouw']);
    assert.deepEqual(imported.labels.map((label) => label.name).sort(), ['1ste jaar', 'Dames']);
    assert.equal(imported.registration?.reuseConsent, 'Nee');
    assert.equal(imported.registration?.remarks, 'Rustig beginnen');
    db.updateRunner(imported.id, { runnerNumber: '42', notes: 'Operatornote' });
    db.updateRunnerStatus({ id: imported.id, status: 'warming_up' });
    const repeat = await caller.runners.importCsv({ csvText: Papa.unparse([{ ...row, 'Ik schat in totaal ... rondjes te lopen': '14' }]) });
    assert.equal(repeat.updated, 1);
    assert.equal(db.getAllRunners().length, 1);
    const updated = db.getRunnerById(imported.id);
    assert.equal(updated?.runnerNumber, '42');
    assert.equal(updated?.notes, 'Operatornote');
    assert.equal(updated?.status, 'warming_up');
    assert.equal(updated?.registration?.estimatedLaps, '14');
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('only one runner can be marked as running', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const first = db.insertRunner({ name: 'First runner', runnerNumber: '1' });
    const second = db.insertRunner({ name: 'Second runner', runnerNumber: '2' });

    db.updateRunnerStatus({ id: first.id, status: 'running', statusSince: 1_000 });
    assert.throws(
      () => db.updateRunnerStatus({ id: second.id, status: 'running', statusSince: 2_000 }),
      /Er loopt al een loper/
    );
    assert.equal(db.getRaceState().activeRunnerId, first.id);
    assert.equal(db.getRunnerById(second.id)?.status, 'registered');
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('new runners cannot bypass timing state and waiting runners join the back of the queue', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const first = db.insertRunner({
      name: 'First waiting runner',
      runnerNumber: '1',
      status: 'waiting',
    });
    const second = db.insertRunner({
      name: 'Second waiting runner',
      runnerNumber: '2',
      status: 'waiting',
    });

    assert.equal(db.getRunnerById(first.id)?.queueIndex, 0);
    assert.equal(db.getRunnerById(second.id)?.queueIndex, 1);
    assert.throws(
      () => db.insertRunner({ name: 'Invalid active runner', status: 'running' }),
      /timingscherm/
    );
    assert.equal(db.getRaceState().activeRunnerId, null);
    assert.equal(db.getAllRunners().length, 2);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('label names are unique regardless of capitalization', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const label = db.createLabel({ name: 'Audit Team' });
    const other = db.createLabel({ name: 'Other Team' });

    assert.throws(() => db.createLabel({ name: 'audit team' }), /bestaat al/);
    assert.throws(() => db.updateLabel(other.id, { name: 'AUDIT TEAM' }), /bestaat al/);
    assert.equal(db.findLabelByName('aUdIt TeAm')?.id, label.id);
    assert.equal(db.getLabels().filter((item) => item.name.toLowerCase() === 'audit team').length, 1);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('the local-first operation log retains every command and advances its origin vector', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const hostId = db.ensureReplicationIdentity().hostId;
    for (let index = 1; index <= 12; index += 1) {
      db.commitReplicatedWrite({
        id: crypto.randomUUID(),
        type: `test-operation-${index}`,
        payload: { marker: index },
        action: () => ({ marker: index }),
      });
    }

    assert.equal(db.getReplicationVector()[hostId], 12);
    assert.equal(db.getAllReplicationOperations().length, 12);

    const inspectionDb = new Database(path.join(dataPath, 'data', 'app.db'), { readonly: true });
    try {
      const row = inspectionDb.prepare('SELECT COUNT(*) AS count FROM replication_operations').get() as {
        count: number;
      };
      assert.equal(row.count, 12);
    } finally {
      inspectionDb.close();
    }
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('command ids are idempotent only for the exact same write', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const commandId = crypto.randomUUID();
    const first = db.commitReplicatedWrite({
      id: commandId,
      type: 'test.idempotent',
      payload: { marker: 1 },
      action: () => ({ stored: 1 }),
    });
    const retry = db.commitReplicatedWrite({
      id: commandId,
      type: 'test.idempotent',
      payload: { marker: 1 },
      action: () => ({ stored: 999 }),
    });

    assert.deepEqual(first, { stored: 1 });
    assert.deepEqual(retry, first);
    assert.throws(
      () =>
        db.commitReplicatedWrite({
          id: commandId,
          type: 'test.different-write',
          payload: { marker: 2 },
          action: () => ({ stored: 2 }),
        }),
      /already used for a different write/
    );
    assert.equal(db.getAllReplicationOperations().length, 1);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('delta queries page in SQL and pending writes wait for every known peer', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const hostId = db.ensureReplicationIdentity().hostId;
    for (let index = 1; index <= 6; index += 1) {
      db.commitReplicatedWrite({
        id: crypto.randomUUID(),
        type: `test.delta-${index}`,
        payload: { marker: index },
        action: () => ({ marker: index }),
      });
    }

    assert.deepEqual(
      db.getReplicationOperationsMissing({ [hostId]: 2 }, 2).map((operation) => operation.originSeq),
      [3, 4]
    );

    db.acknowledgeReplicationVector('peer-a', { [hostId]: 6 });
    db.acknowledgeReplicationVector('peer-b', {});
    assert.equal(db.getPendingReplicationOperationCount(), 6);
    db.acknowledgeReplicationVector('peer-b', { [hostId]: 2 });
    assert.equal(db.getPendingReplicationOperationCount(), 4);
    db.acknowledgeReplicationVector('peer-b', { [hostId]: 6 });
    assert.equal(db.getPendingReplicationOperationCount(), 0);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('operational SQLite access paths stay indexed and direct lookups preserve records', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const first = db.insertRunner({ name: 'Indexed runner', runnerNumber: '501', status: 'waiting' });
    const second = db.insertRunner({ name: 'Next runner', runnerNumber: '502', status: 'waiting' });
    db.performHandoff(1_000);
    db.performHandoff(61_000);

    const lap = db.getAllLaps()[0];
    assert.ok(lap);
    assert.deepEqual(db.getLapById(lap.id), lap);
    assert.deepEqual(db.getRunnerById(first.id), db.getAllRunners().find((runner) => runner.id === first.id));
    assert.ok(db.getRunnerById(second.id));

    const inspectionDb = new Database(path.join(dataPath, 'data', 'app.db'), { readonly: true });
    try {
      const indexNames = new Set(
        [
          ...inspectionDb.prepare("PRAGMA index_list('laps')").all(),
          ...inspectionDb.prepare("PRAGMA index_list('queue_entries')").all(),
          ...inspectionDb.prepare("PRAGMA index_list('race_events')").all(),
        ].map((row) => String((row as { name: unknown }).name))
      );
      assert.ok(indexNames.has('idx_laps_runner_finished'));
      assert.ok(indexNames.has('idx_laps_finished'));
      assert.ok(indexNames.has('idx_queue_status_order'));
      assert.ok(indexNames.has('idx_race_events_occurred'));
    } finally {
      inspectionDb.close();
    }
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('full app snapshots reuse immutable collections until application data changes', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appSnapshot, liveAppSnapshot } = await import('../server/app-state.ts');

  try {
    await db.initDb();
    const first = appSnapshot();
    const second = appSnapshot();
    const live = liveAppSnapshot();
    assert.equal('laps' in live, false);
    assert.equal('events' in live, false);
    assert.strictEqual(live.runners, first.runners);
    assert.strictEqual(second.runners, first.runners);
    assert.strictEqual(second.laps, first.laps);
    assert.equal(second.revision, first.revision);

    db.insertRunner({ name: 'Snapshot invalidator', runnerNumber: '900' });
    const changed = appSnapshot();
    assert.notStrictEqual(changed.runners, first.runners);
    assert.ok((changed.revision ?? 0) > (first.revision ?? 0));

    db.commitReplicatedWrite({
      type: 'cache-neutral-cluster-log',
      payload: { marker: 'no app mutation' },
      action: () => ({ ok: true }),
    });
    const afterClusterLog = appSnapshot();
    assert.strictEqual(afterClusterLog.runners, changed.runners);
    assert.equal(afterClusterLog.revision, changed.revision);
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
