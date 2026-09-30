import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWindowState, restorableBounds } from '../electron/window-state.ts';

const laptopScreen = { x: 0, y: 0, width: 1920, height: 1040 };
const projector = { x: 1920, y: 0, width: 1280, height: 720 };

test('the window reopens where it was, maximized or not', () => {
  const saved = parseWindowState(
    JSON.stringify({ bounds: { x: 100, y: 60, width: 1200, height: 800 }, maximized: true })
  );
  assert.deepEqual(saved, { bounds: { x: 100, y: 60, width: 1200, height: 800 }, maximized: true });
  assert.deepEqual(restorableBounds(saved, [laptopScreen]), { x: 100, y: 60, width: 1200, height: 800 });
});

test('a window last on a screen that is no longer connected opens at its default place', () => {
  const saved = parseWindowState(JSON.stringify({ bounds: { x: 2000, y: 40, width: 1000, height: 600 } }));
  assert.ok(restorableBounds(saved, [laptopScreen, projector]));
  assert.equal(restorableBounds(saved, [laptopScreen]), null);
});

test('a title bar above the top of the screen, a tiny window, or a damaged file are not restored as such', () => {
  const aboveScreen = parseWindowState(JSON.stringify({ bounds: { x: 100, y: -300, width: 1200, height: 800 } }));
  assert.equal(restorableBounds(aboveScreen, [laptopScreen]), null);
  const tiny = parseWindowState(JSON.stringify({ bounds: { x: 100, y: 100, width: 10, height: 10 } }));
  assert.deepEqual(restorableBounds(tiny, [laptopScreen]), { x: 100, y: 100, width: 720, height: 480 });
  assert.equal(parseWindowState('{"bounds":'), null);
  assert.equal(parseWindowState(JSON.stringify({ bounds: { x: 'left' } })), null);
  assert.equal(restorableBounds(null, [laptopScreen]), null);
});
