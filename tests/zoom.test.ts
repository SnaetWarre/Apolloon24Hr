import assert from 'node:assert/strict';
import test from 'node:test';
import { nextZoom, zoomStep } from '../src/lib/zoom';

const key = (
  key: string,
  code: string,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}
) => ({
  key,
  code,
  ctrlKey: modifiers.ctrlKey ?? !modifiers.metaKey,
  metaKey: modifiers.metaKey ?? false,
  altKey: modifiers.altKey ?? false,
});

test('Ctrl or Cmd with +, - or 0 zooms, on QWERTY, AZERTY and the number pad', () => {
  assert.equal(zoomStep(key('=', 'Equal')), 'in');
  assert.equal(zoomStep(key('+', 'Equal')), 'in');
  assert.equal(zoomStep(key('+', 'NumpadAdd')), 'in');
  assert.equal(zoomStep(key('-', 'Minus')), 'out');
  assert.equal(zoomStep(key('-', 'NumpadSubtract')), 'out');
  assert.equal(zoomStep(key('0', 'Digit0')), 'reset');
  // AZERTY: the 0 key types à without Shift.
  assert.equal(zoomStep(key('à', 'Digit0')), 'reset');
  assert.equal(zoomStep(key('=', 'Equal', { metaKey: true })), 'in');
});

test('plain keys and AltGr never zoom', () => {
  assert.equal(zoomStep(key('+', 'NumpadAdd', { ctrlKey: false })), null);
  // AltGr reports Ctrl+Alt on Windows.
  assert.equal(zoomStep(key('=', 'Equal', { altKey: true })), null);
  assert.equal(zoomStep(key('a', 'KeyA')), null);
});

test('zoom steps like a browser and stops at 50% and 200%', () => {
  assert.equal(nextZoom(1, 'in'), 1.1);
  assert.equal(nextZoom(1.1, 'in'), 1.25);
  assert.equal(nextZoom(1, 'out'), 0.9);
  assert.equal(nextZoom(2, 'in'), 2);
  assert.equal(nextZoom(0.5, 'out'), 0.5);
  assert.equal(nextZoom(1.3, 'in'), 1.5);
  assert.equal(nextZoom(1.3, 'out'), 1.25);
  assert.equal(nextZoom(1.75, 'reset'), 1);
});
