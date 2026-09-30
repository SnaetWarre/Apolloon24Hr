export type Rectangle = { x: number; y: number; width: number; height: number };

/** Where the window was when it closed, kept in the app data folder. */
export type SavedWindowState = { bounds: Rectangle; maximized: boolean };

export const DEFAULT_WINDOW_SIZE = { width: 1400, height: 900 };
export const MIN_WINDOW_SIZE = { width: 720, height: 480 };

/** Reads the stored state; anything unreadable counts as no stored state. */
export function parseWindowState(text: string): SavedWindowState | null {
  try {
    const value = JSON.parse(text) as Partial<SavedWindowState> | null;
    const bounds = value?.bounds;
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null;
    return {
      bounds: {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      },
      maximized: value.maximized === true,
    };
  } catch {
    return null;
  }
}

/**
 * The stored bounds when enough of the window still lands on one of the screens,
 * so it never reopens out of reach after a projector or second screen is unplugged.
 * Without that, the window opens at its default size on the primary screen.
 */
export function restorableBounds(saved: SavedWindowState | null, workAreas: Rectangle[]): Rectangle | null {
  if (!saved) return null;
  const width = Math.max(saved.bounds.width, MIN_WINDOW_SIZE.width);
  const height = Math.max(saved.bounds.height, MIN_WINDOW_SIZE.height);
  const bounds = { ...saved.bounds, width, height };
  const visible = workAreas.some((area) => {
    const overlapX = Math.min(bounds.x + width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY = Math.min(bounds.y + height, area.y + area.height) - Math.max(bounds.y, area.y);
    // The title bar must be reachable to move the window: a strip at the top has to be on screen.
    return overlapX >= 200 && overlapY >= 80 && bounds.y >= area.y && bounds.y < area.y + area.height - 40;
  });
  return visible ? bounds : null;
}
