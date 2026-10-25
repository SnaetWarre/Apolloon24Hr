import React from 'react';
import { getDesktop } from './desktop';

/** The levels Ctrl + and Ctrl − step through, as in a browser, from 50% to 200%. */
export const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
export const MIN_ZOOM = ZOOM_LEVELS[0];
export const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

export type ZoomStep = 'in' | 'out' | 'reset';

/**
 * Ctrl (Cmd on a Mac) with +, − or 0, also on the number pad. On AZERTY 0 is Shift+à,
 * so the physical key counts too. AltGr reports Ctrl+Alt and never zooms.
 */
export function zoomStep(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>
): ZoomStep | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') return 'in';
  if (event.key === '-' || event.code === 'NumpadSubtract') return 'out';
  if (event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0') return 'reset';
  return null;
}

/** The next level in that direction; it stops at 50% and 200%. */
export function nextZoom(current: number, step: ZoomStep): number {
  if (step === 'reset') return 1;
  if (step === 'in') return ZOOM_LEVELS.find((level) => level > current + 0.001) ?? MAX_ZOOM;
  return [...ZOOM_LEVELS].reverse().find((level) => level < current - 0.001) ?? MIN_ZOOM;
}

/** Calls back on Ctrl +, Ctrl − and Ctrl 0, instead of the browser zooming by itself. */
export function useZoomKeys(onStep: ((step: ZoomStep) => void) | null) {
  const handle = React.useEffectEvent((event: KeyboardEvent) => {
    const step = onStep && zoomStep(event);
    if (!step) return;
    event.preventDefault();
    onStep(step);
  });
  React.useEffect(() => {
    const listener = (event: KeyboardEvent) => handle(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}

const DESKTOP_ZOOM_KEY = 'apolloon.zoom';

function storedDesktopZoom() {
  try {
    const value = Number(window.localStorage.getItem(DESKTOP_ZOOM_KEY));
    return value >= MIN_ZOOM && value <= MAX_ZOOM ? value : 1;
  } catch {
    return 1;
  }
}

/**
 * Ctrl +, Ctrl − and Ctrl 0 zoom the desktop app's operator screens; its window has no
 * menu that would. A browser zooms by itself, and the displays zoom on their own
 * (useDisplayZoom), so a display always opens at the size its own zoom asks for.
 */
export function useDesktopZoom(displayRoute: boolean) {
  const desktop = getDesktop();
  const [zoom, setZoom] = React.useState(storedDesktopZoom);
  React.useEffect(() => {
    desktop?.setZoom(displayRoute ? 1 : zoom);
  }, [desktop, displayRoute, zoom]);
  useZoomKeys(
    desktop && !displayRoute
      ? (step) => {
          const next = nextZoom(zoom, step);
          try {
            window.localStorage.setItem(DESKTOP_ZOOM_KEY, String(next));
          } catch {
            // Keep the zoom for this session only.
          }
          setZoom(next);
        }
      : null
  );
}
