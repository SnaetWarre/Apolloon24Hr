import { spawn, type ChildProcess } from 'node:child_process';
import { powerSaveBlocker } from 'electron';

const CHECK_INTERVAL_MS = 5_000;

let raceActive = false;
let blockerId: number | null = null;
let linuxInhibitor: ChildProcess | null = null;
let timer: NodeJS.Timeout | null = null;

/** True while the race runs, as the local server last reported it. */
export function isRaceActive(): boolean {
  return raceActive;
}

/**
 * Follows the race through the local server's health check. While the race runs, the
 * screen stays on and the laptop does not go to sleep: a sleeping laptop drops out of the
 * group, and the operator would find a dark timing screen. When the server does not answer
 * (it restarts by itself after a crash), the last known state holds.
 */
export function watchRace(baseUrl: () => string, onChange: (active: boolean) => void): void {
  if (timer) return;
  const check = async () => {
    try {
      const response = await fetch(`${baseUrl()}/api/health`, { signal: AbortSignal.timeout(2_000) });
      const health = (await response.json()) as { race?: { active?: unknown } };
      if (typeof health.race?.active !== 'boolean' || health.race.active === raceActive) return;
      raceActive = health.race.active;
      keepAwake(raceActive);
      onChange(raceActive);
    } catch {
      // Keep the last known state until the server answers again.
    }
  };
  void check();
  timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
}

export function stopWatchingRace(): void {
  if (timer) clearInterval(timer);
  timer = null;
  keepAwake(false);
}

function keepAwake(awake: boolean): void {
  if (awake && blockerId === null) {
    blockerId = powerSaveBlocker.start('prevent-display-sleep');
    if (process.platform === 'linux') inhibitLinuxSleep();
  } else if (!awake && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
    linuxInhibitor?.kill();
    linuxInhibitor = null;
  }
}

/**
 * On Linux, Chromium only asks the desktop's screensaver service, which many desktops do
 * not offer, so suspending is also blocked through systemd. The inhibitor holds while
 * `tail` waits for this app's process, so it can never outlive the app, also after a crash.
 */
function inhibitLinuxSleep(): void {
  const inhibitor = spawn(
    'systemd-inhibit',
    [
      '--what=sleep:idle',
      '--who=Apolloon Telsysteem',
      '--why=De wedstrijd loopt',
      '--mode=block',
      'tail',
      `--pid=${process.pid}`,
      '-f',
      '/dev/null',
    ],
    { stdio: 'ignore' }
  );
  // Without systemd there is nothing more to do than what Chromium already did.
  inhibitor.on('error', () => undefined);
  inhibitor.on('exit', () => {
    if (linuxInhibitor === inhibitor) linuxInhibitor = null;
  });
  linuxInhibitor = inhibitor;
}
