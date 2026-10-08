import assert from 'node:assert/strict';
import test from 'node:test';
import { splashHtml } from '../electron/splash.ts';
import { buildDiagnosticsText } from '../src/lib/diagnostics.ts';
import { shouldShowWelcome } from '../src/lib/welcome.ts';
import type { ClusterStatus } from '../src/types.ts';

const now = Date.UTC(2026, 9, 5, 18, 0, 0);

const cluster: ClusterStatus = {
  enabled: true,
  hostId: 'host-a',
  hostName: 'LAPTOP-TIJD',
  clusterId: 'cluster',
  appVersion: '4.2.0',
  schemaVersion: 13,
  role: 'leader',
  term: 3,
  state: 'healthy',
  leader: { hostId: 'host-a', url: 'http://10.0.0.1:5173' },
  members: [
    {
      hostId: 'host-a',
      url: 'http://10.0.0.1:5173',
      name: 'LAPTOP-TIJD',
      self: true,
      leader: true,
      reachable: true,
      caughtUp: true,
    },
    {
      hostId: 'host-b',
      url: 'http://10.0.0.2:5173',
      name: null,
      self: false,
      leader: false,
      reachable: false,
      caughtUp: false,
    },
  ],
  majority: 2,
  writable: true,
  busy: null,
  selfUrl: 'http://10.0.0.1:5173',
  logHead: 42,
  runners: 40,
  changed: true,
  memberUrls: ['http://10.0.0.2:5173'],
  nearby: [
    {
      url: 'http://10.0.0.9:5173',
      name: 'LAPTOP-NIEUW',
      laptops: 1,
      runners: 0,
      changed: false,
      appVersion: '4.1.0',
      compatible: false,
      link: 'invite',
    },
  ],
  autoLink: { enabled: true, waiting: null, linked: [] },
  lastError: 'Laptop 10.0.0.2 antwoordt niet',
  backup: {
    enabled: true,
    inProgress: false,
    intervalMs: 300_000,
    nextScheduledAt: now + 300_000,
    retainedCount: 2,
    latest: { fileName: 'backup.sqlite', createdAt: now - 60_000, sizeBytes: 1_024, scheduled: true },
    lastError: null,
    lastFailureAt: null,
    diskFreeBytes: 512 * 1_024 ** 2,
    minimumFreeBytes: 2 * 1_024 ** 3,
    diskLow: true,
    databaseBytes: 2_048,
  },
};

test('the welcome screen shows only on a laptop without runners before the race', () => {
  assert.equal(shouldShowWelcome({ runnerCount: 0, raceStarted: false, skipped: false }), true);
  assert.equal(shouldShowWelcome({ runnerCount: 1, raceStarted: false, skipped: false }), false);
  assert.equal(shouldShowWelcome({ runnerCount: 0, raceStarted: true, skipped: false }), false);
  assert.equal(shouldShowWelcome({ runnerCount: 0, raceStarted: false, skipped: true }), false);
});

test('the copied diagnosis names the version, every laptop, the backup and the log', () => {
  const text = buildDiagnosticsText({
    cluster,
    host: { hostIpHint: '10.0.0.1', port: 5173, url: 'http://10.0.0.1:5173' },
    desktop: {
      appVersion: '4.2.0',
      electron: '44.5.1',
      chrome: '146.0.0.0',
      os: 'Windows_NT 10.0.22631 x64',
      dataPath: 'C:\\Users\\leerkracht\\AppData\\Roaming\\Apolloon Telsysteem',
      logTail: 'Server listening on http://0.0.0.0:5173',
    },
    userAgent: 'test',
    now,
  });
  assert.match(text, /Versie: 4\.2\.0 · schema 13/);
  assert.match(text, /desktop-app \(Electron 44\.5\.1/);
  assert.match(text, /Gegevensmap: C:\\Users/);
  assert.match(text, /LAPTOP-TIJD http:\/\/10\.0\.0\.1:5173 \(deze laptop/);
  assert.match(text, / {2}http:\/\/10\.0\.0\.2:5173 \(niet bereikbaar\)/);
  assert.match(text, /gevonden: LAPTOP-NIEUW http:\/\/10\.0\.0\.9:5173 \(versie 4\.1\.0, niet compatibel\)/);
  assert.match(text, /Laatste fout: Laptop 10\.0\.0\.2 antwoordt niet/);
  assert.match(text, /vrij 512 MB/);
  assert.match(text, /--- laatste regels van server\.log ---\nServer listening/);
});

test('a browser diagnosis says it is a browser and has no log', () => {
  const text = buildDiagnosticsText({ cluster: null, host: null, desktop: null, userAgent: 'Mozilla/5.0 TV', now });
  assert.match(text, /Versie: onbekend/);
  assert.match(text, /Scherm: browser \(Mozilla\/5\.0 TV\)/);
  assert.doesNotMatch(text, /server\.log/);
});

test('the splash page works without the logo and escapes the version', () => {
  const html = splashHtml({ dark: true, version: '4.2.0<script>', logoDataUrl: null, fontDataUrl: null });
  assert.match(html, /class="wordmark">Apolloon</);
  assert.match(html, /Apolloon Telsysteem 4\.2\.0&#60;script&#62;/);
  assert.match(html, /background:#1A1A1A/);
  assert.match(html, /Apolloon starten…/);
});
