import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { releaseNotes } from '../scripts/release-notes.mjs';
import { verifyReleaseTag } from '../scripts/verify-release-tag.mjs';
import { temporaryDataPath } from './temporary-data.ts';

test('release tags must match the checked out package version', () => {
  verifyReleaseTag('v2.1.0', '2.1.0');
  verifyReleaseTag('v2.1.0-rc.1', '2.1.0-rc.1');
  for (const tag of ['v2.0.0', '2.1.0', 'vnext', undefined]) {
    assert.throws(() => verifyReleaseTag(tag, '2.1.0'));
  }
});

test('release notes can be generated outside an older checkout that has no generator', () => {
  const root = temporaryDataPath('release-notes');
  const checkout = path.join(root, 'older-tag');
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ version: '4.1.0' }));
  fs.writeFileSync(path.join(checkout, 'CHANGELOG.md'), '## [4.1.0] - 2026-09-30\n\n- Excel export\n');
  const generator = path.join(root, 'release-notes.mjs');
  fs.copyFileSync(new URL('../scripts/release-notes.mjs', import.meta.url), generator);
  const notes = execFileSync(process.execPath, [generator], { cwd: checkout, encoding: 'utf8' });
  assert.match(notes, /^- Excel export\n\n## Installeren/);
});

test('release notes are the version’s changelog section and install notes', () => {
  const changelog = `# Changelog

## [Unreleased]

## [4.2.0] - 2026-10-01

### Added

- Terugzetten

## [4.1.0] - 2026-09-30

- Excel
`;
  const notes = releaseNotes(changelog, '4.2.0');
  assert.match(notes, /^### Added\n\n- Terugzetten\n\n## Installeren/);
  assert.doesNotMatch(notes, /Excel/);
  assert.match(releaseNotes(changelog, '4.1.0'), /^- Excel\n\n## Installeren/);
  assert.throws(() => releaseNotes(changelog, '4.3.0'), /no section/);
  assert.throws(() => releaseNotes(changelog, '4.1'), /no section/);
  assert.throws(() => releaseNotes('## [5.0.0]\n\n## [4.0.0]\n- x', '5.0.0'), /empty/);
});
