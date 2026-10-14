import React from 'react';

// Windows counts two clicks up to 500 ms apart and 4 px from each other as a double click.
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP_PX = 8;

/**
 * Tells whether a click is the second click of a double click: within 500 ms of the previous
 * click and on the same spot. Use it where the first click swaps the button under the mouse.
 */
export function useSecondClick() {
  const lastClick = React.useRef({ at: Number.NEGATIVE_INFINITY, x: 0, y: 0 });
  return React.useCallback((event: React.MouseEvent) => {
    // Enter and Space click with detail 0.
    if (event.detail === 0) return false;
    const last = lastClick.current;
    lastClick.current = { at: event.timeStamp, x: event.clientX, y: event.clientY };
    return (
      event.timeStamp - last.at < DOUBLE_CLICK_MS &&
      Math.abs(event.clientX - last.x) <= DOUBLE_CLICK_SLOP_PX &&
      Math.abs(event.clientY - last.y) <= DOUBLE_CLICK_SLOP_PX
    );
  }, []);
}
