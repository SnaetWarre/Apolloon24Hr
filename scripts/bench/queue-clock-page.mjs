// Serialized into the page after installHistoryProbe.
export function installClockProbe({ now }) {
  const anchor = performance.now();
  Date.now = () => Math.floor(now + performance.now() - anchor);
  let active,
    depth = 0;
  window.__benchInvoke = (fn) => {
    if (!active) return fn();
    const outer = depth++ === 0;
    const start = outer ? performance.now() : 0;
    try {
      return fn();
    } finally {
      depth--;
      if (outer) {
        active.workMs += performance.now() - start;
        active.callbacks++;
      }
    }
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) =>
    raf((at) => {
      if (active && callback.__benchRune) active.frames++;
      callback(at);
    });
  window.__clockStart = () => {
    if (active) throw new Error('already measuring');
    active = { start: performance.now(), now: Date.now(), workMs: 0, callbacks: 0, frames: 0 };
  };
  window.__clockStop = () => {
    if (!active) throw new Error('not measuring');
    const result = {
      ...active,
      elapsedMs: performance.now() - active.start,
      clockElapsedMs: Date.now() - active.now,
      renderer: window.__benchRenderer(),
    };
    active = null;
    return result;
  };
}
