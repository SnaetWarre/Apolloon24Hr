import React from 'react';

export function useAnimationFrameTick(enabled = true) {
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    if (!enabled) return undefined;

    let frameId = 0;
    const tick = () => {
      setTick((value) => (value + 1) % 1_000_000);
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [enabled]);
}
