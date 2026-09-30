import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseNotes } from '../scripts/release-notes.mjs';
import { verifyReleaseTag } from '../scripts/verify-release-tag.mjs';

test('release tags must match the checked out package version', () => {
  verifyReleaseTag('v2.1.0', '2.1.0');
  verifyReleaseTag('v2.1.0-rc.1', '2.1.0-rc.1');
  for (const tag of ['v2.0.0', '2.1.0', 'vnext', undefined]) {
    assert.throws(() => verifyReleaseTag(tag, '2.1.0'));
  }
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
