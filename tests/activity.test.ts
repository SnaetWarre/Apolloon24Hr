import assert from 'node:assert/strict';
import test from 'node:test';
import { describeOrigin } from '../server/activity.ts';

test('the activity log names the screen, and the laptop itself or the browser that made a change', () => {
  assert.equal(describeOrigin('/timing', '127.0.0.1', '192.168.1.10'), 'Timing · laptop 192.168.1.10');
  assert.equal(describeOrigin('/admin', '::1', '192.168.1.10'), 'Beheer · laptop 192.168.1.10');
  assert.equal(describeOrigin('/queue', '::ffff:192.168.1.40', '192.168.1.10'), 'Wachtrij · browser 192.168.1.40');
  assert.equal(describeOrigin(undefined, '192.168.1.41', '192.168.1.10'), 'Ander scherm · browser 192.168.1.41');
});
