// Serialized into the page after installHistoryProbe.
export function installClockProbe({ now, stepMs = 0 }) {
  const anchor = performance.now();
  Date.now = () => {
    const elapsed = performance.now() - anchor;
    return Math.floor(now + (stepMs ? Math.floor(elapsed / stepMs) * stepMs : elapsed));
  };
  let active,
    depth = 0;
  const contexts = new WeakMap();
  const state = (gl) => {
    if (!contexts.has(gl)) contexts.set(gl, { scissor: null, enabled: false });
    return contexts.get(gl);
  };
  const proto = window.WebGL2RenderingContext?.prototype;
  const hook = (name, observe) => {
    if (!proto?.[name]) return;
    const original = proto[name];
    proto[name] = function (...args) {
      const result = original.apply(this, args);
      observe(this, args);
      return result;
    };
  };
  hook('scissor', (gl, rect) => {
    state(gl).scissor = rect;
  });
  hook('enable', (gl, [cap]) => {
    if (cap === gl.SCISSOR_TEST) state(gl).enabled = true;
  });
  hook('disable', (gl, [cap]) => {
    if (cap === gl.SCISSOR_TEST) state(gl).enabled = false;
  });
  const draw = (gl, rect) => {
    if (!active) return;
    active.drawCalls++;
    if (!active.drew) {
      active.drawFrames++;
      active.drew = true;
    }
    const box = rect ??
      (state(gl).enabled ? state(gl).scissor : null) ?? [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight];
    const [x, y, w, h] = box;
    const b = [
      Math.max(0, x),
      Math.max(0, y),
      Math.min(gl.drawingBufferWidth, x + w),
      Math.min(gl.drawingBufferHeight, y + h),
    ];
    if (b[2] <= b[0] || b[3] <= b[1]) return;
    active.scissorBounds = active.scissorBounds
      ? [
          Math.min(active.scissorBounds[0], b[0]),
          Math.min(active.scissorBounds[1], b[1]),
          Math.max(active.scissorBounds[2], b[2]),
          Math.max(active.scissorBounds[3], b[3]),
        ]
      : b;
  };
  for (const name of [
    'drawArrays',
    'drawElements',
    'drawArraysInstanced',
    'drawElementsInstanced',
    'clear',
    'clearBufferfv',
    'clearBufferiv',
    'clearBufferuiv',
    'clearBufferfi',
  ])
    hook(name, (gl) => draw(gl));
  hook('blitFramebuffer', (gl, args) => draw(gl, [args[4], args[5], args[6] - args[4], args[7] - args[5]]));
  window.__benchInvoke = (fn) => {
    if (!active) return fn();
    const outer = depth++ === 0;
    if (outer) {
      active.drew = false;
      active.scissorBounds = null;
    }
    const start = outer ? performance.now() : 0;
    try {
      return fn();
    } finally {
      depth--;
      if (outer) {
        if (active.scissorBounds) {
          const [x, y, right, bottom] = active.scissorBounds;
          const area = (right - x) * (bottom - y);
          active.scissorPixels += area;
          active.draws.push({ at: performance.now(), clock: Date.now(), area });
        }
        active.workMs += performance.now() - start;
        active.callbacks++;
      }
    }
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => {
    if (active && callback.__benchRune) active.requestedFrames++;
    return raf((at) => {
      if (active && callback.__benchRune) active.frames++;
      callback(at);
    });
  };
  window.__clockStart = () => {
    if (active) throw new Error('already measuring');
    active = {
      start: performance.now(),
      now: Date.now(),
      workMs: 0,
      callbacks: 0,
      frames: 0,
      requestedFrames: 0,
      drawCalls: 0,
      drawFrames: 0,
      scissorPixels: 0,
      draws: [],
    };
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
