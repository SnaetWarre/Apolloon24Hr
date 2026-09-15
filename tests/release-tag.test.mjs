import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyReleaseTag } from '../scripts/verify-release-tag.mjs';

test('release tags must match the checked out package version', () => {
  verifyReleaseTag('v2.1.0', '2.1.0');
  verifyReleaseTag('v2.1.0-rc.1', '2.1.0-rc.1');
  for (const tag of ['v2.0.0', '2.1.0', 'vnext', undefined]) {
    assert.throws(() => verifyReleaseTag(tag, '2.1.0'));
  }
});
