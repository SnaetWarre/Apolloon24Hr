import assert from 'node:assert/strict';
import test from 'node:test';
import { checkForUpdate, compareVersions, isReleaseUrl, pickInstaller, readRelease } from '../electron/update-check.ts';

const download = (name: string) => ({
  name,
  browser_download_url: `https://github.com/SnaetWarre/apolloon-releases/releases/download/v4.3.0/${name}`,
});

const release = {
  tag_name: 'v4.3.0',
  html_url: 'https://github.com/SnaetWarre/apolloon-releases/releases/tag/v4.3.0',
  published_at: '2026-10-10T12:00:00Z',
  assets: [
    download('Apolloon.Telsysteem-4.3.0-windows-x64-setup.exe'),
    download('Apolloon.Telsysteem-4.3.0.AppImage'),
    download('Apolloon.Telsysteem-4.3.0-macos-arm64.dmg'),
    download('Apolloon.Telsysteem-4.3.0-macos-arm64.zip'),
    download('SHA256SUMS.txt'),
  ],
};

const answer = (body: unknown, status = 200) =>
  (async () => Response.json(body, { status })) as unknown as typeof fetch;

test('versions compare by number, and a pre-release comes before its release', () => {
  assert.equal(compareVersions('4.10.0', '4.9.9'), 1);
  assert.equal(compareVersions('v4.2.0', '4.2.0'), 0);
  assert.equal(compareVersions('4.2.0', '4.2.1'), -1);
  assert.equal(compareVersions('4.3.0-beta.1', '4.3.0'), -1);
  assert.equal(compareVersions('4.3.0', '4.3.0-beta.1'), 1);
});

test('each operating system gets its own installer', () => {
  assert.match(pickInstaller(release.assets, 'win32', 'x64') ?? '', /windows-x64-setup\.exe$/);
  assert.match(pickInstaller(release.assets, 'linux', 'x64') ?? '', /\.AppImage$/);
  assert.match(pickInstaller(release.assets, 'darwin', 'arm64') ?? '', /macos-arm64\.dmg$/);
  assert.equal(pickInstaller([download('notes.txt')], 'win32', 'x64'), null);
  assert.equal(
    pickInstaller(
      [{ name: 'evil-setup.exe', browser_download_url: 'https://example.com/evil-setup.exe' }],
      'win32',
      'x64'
    ),
    null
  );
});

test('a newer published version is offered with its installer and page', async () => {
  const status = await checkForUpdate({
    currentVersion: '4.2.0',
    platform: 'win32',
    arch: 'x64',
    fetchImpl: answer(release),
    now: () => 1,
  });
  assert.equal(status.state, 'available');
  assert.ok(status.state === 'available');
  assert.equal(status.update.version, '4.3.0');
  assert.equal(status.update.pageUrl, release.html_url);
  assert.match(status.update.downloadUrl ?? '', /\.exe$/);
  assert.equal(status.update.publishedAt, Date.parse('2026-10-10T12:00:00Z'));
});

test('the same or an older version is current, and no internet is not an error', async () => {
  const check = (currentVersion: string, fetchImpl: typeof fetch) =>
    checkForUpdate({ currentVersion, platform: 'linux', arch: 'x64', fetchImpl, now: () => 1 });
  assert.deepEqual(await check('4.3.0', answer(release)), { state: 'current', checkedAt: 1 });
  assert.deepEqual(await check('5.0.0', answer(release)), { state: 'current', checkedAt: 1 });
  assert.deepEqual(await check('4.2.0', answer({ message: 'Not Found' }, 404)), { state: 'unreachable', checkedAt: 1 });
  assert.deepEqual(await check('4.2.0', answer({ tag_name: 'nightly' })), { state: 'unreachable', checkedAt: 1 });
  const offline = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  assert.deepEqual(await check('4.2.0', offline), { state: 'unreachable', checkedAt: 1 });
});

test('only pages of the releases repository open from the update notice', () => {
  assert.equal(isReleaseUrl(release.html_url), true);
  assert.equal(isReleaseUrl(release.assets[0].browser_download_url), true);
  assert.equal(isReleaseUrl('https://github.com/SnaetWarre/Apolloon24Hr/releases'), false);
  assert.equal(isReleaseUrl('http://github.com/SnaetWarre/apolloon-releases/releases'), false);
  assert.equal(isReleaseUrl('file:///etc/passwd'), false);
  assert.equal(
    readRelease({ ...release, html_url: 'https://example.com/' }, 'linux', 'x64')?.pageUrl,
    'https://github.com/SnaetWarre/apolloon-releases/releases'
  );
});
