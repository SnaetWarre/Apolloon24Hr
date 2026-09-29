/**
 * The time every laptop in the cluster agrees on. The first main laptop's
 * clock is the reference; the others keep an offset to it, and a laptop that
 * takes over keeps its offset, so times stay continuous across a failover.
 * Laptops at the event have no internet time, so their own clocks may differ
 * by seconds.
 */
/** Corrections smaller than this are measurement noise on a LAN. */
const CLOCK_STEP_MS = 2;
const SAMPLE_COUNT = 16;

let offsetMs = 0;
const samples: Array<{ offsetMs: number; roundTripMs: number }> = [];

export function clusterNow(): number {
  return Date.now() + offsetMs;
}

export function clusterClockOffset(): number {
  return offsetMs;
}

export function setClusterClockOffset(nextOffsetMs: number): void {
  offsetMs = nextOffsetMs;
}

/**
 * Learns the offset to another laptop's cluster time from one request: sent
 * and received on this laptop's clock, answered with the other's cluster
 * time. The fastest recent round trip is the most precise; only real drift
 * moves the offset. Returns true when the offset changed.
 */
export function observeReferenceClock(referenceNowMs: number, sentAtMs: number, receivedAtMs: number): boolean {
  const roundTripMs = receivedAtMs - sentAtMs;
  if (roundTripMs < 0) return false;
  samples.push({ offsetMs: referenceNowMs - (sentAtMs + roundTripMs / 2), roundTripMs });
  if (samples.length > SAMPLE_COUNT) samples.shift();
  const best = samples.reduce((fastest, sample) => (sample.roundTripMs < fastest.roundTripMs ? sample : fastest));
  if (Math.abs(best.offsetMs - offsetMs) < CLOCK_STEP_MS) return false;
  offsetMs = Math.round(best.offsetMs);
  return true;
}

/** Forget earlier measurements, e.g. after following another laptop. */
export function resetClockSamples(): void {
  samples.length = 0;
}
