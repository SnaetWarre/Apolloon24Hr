import { compareVersions, releasePage, type AvailableUpdate, type UpdateStatus } from './update-check.js';

/**
 * The steps from finding a newer version to running it, without Electron, so tests can
 * drive them with a fake updater. electron/updates.ts connects them to the app.
 */

type State = UpdateStatus['state'];

/** Which state may follow which. Every change of the status goes through this table. */
export const NEXT_STATES: Record<State, readonly State[]> = {
  idle: ['checking'],
  // A check that threw halfway may start again.
  checking: ['checking', 'current', 'unreachable', 'available', 'downloading'],
  current: ['checking'],
  unreachable: ['checking'],
  // A download that failed lands here; a new check may then start it again.
  available: ['checking'],
  // The same state again for each percent.
  downloading: ['downloading', 'ready', 'available'],
  ready: ['installing'],
  // Back when the backup fails, the race started, or the app did not close to install.
  installing: ['ready'],
};

export function canMove(from: State, to: State): boolean {
  return NEXT_STATES[from].includes(to);
}

/** The part of electron-updater's AppUpdater these steps use. */
export type Updater = {
  checkForUpdates(): Promise<{ updateInfo: { version: string; releaseDate: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
};

/** The app closes within a second or two after quitAndInstall; still open after this, it did not. */
export const QUIT_TIMEOUT_MS = 30_000;

export const RACE_RUNNING = 'De wedstrijd loopt. Installeer de update pas na de wedstrijd.';
// The installer may have started already (Windows) or swapped the app file (AppImage), and
// electron-updater ignores a second quitAndInstall: only a restart finishes or retries it.
const NOT_CLOSED = 'Apolloon sloot niet af, dus de installatie is niet afgerond. Start Apolloon opnieuw.';

export function createUpdateFlow({
  currentVersion,
  inApp,
  updater,
  checkRelease,
  log,
  send,
  isRaceActive,
  makeBackup,
  beforeInstall,
}: {
  currentVersion: string;
  /** Whether electron-updater can download and install here (see canInstallInApp). */
  inApp: boolean;
  updater: () => Promise<Updater>;
  /** The release page check, for installs that cannot update themselves and a failed updater. */
  checkRelease: () => Promise<UpdateStatus>;
  log: (message: string) => void;
  send: (status: UpdateStatus) => void;
  isRaceActive: () => boolean;
  makeBackup: () => Promise<void>;
  /** Called right before the app closes to install; writes the note read after the restart. */
  beforeInstall: (version: string) => void;
}) {
  let status: UpdateStatus = { state: 'idle', checkedAt: null };
  let running: Promise<UpdateStatus> | null = null;
  let quitTimer: NodeJS.Timeout | null = null;
  /** The installer may have started already; installing again could break the install. */
  let needsRestart = false;

  function setStatus(next: UpdateStatus) {
    if (!canMove(status.state, next.state)) {
      log(`Update status ${status.state} cannot become ${next.state}; kept ${status.state}`);
      return;
    }
    status = next;
    send(status);
  }

  function check(): Promise<UpdateStatus> {
    if (running) return running;
    // A download in progress, waiting to be installed or installing is not replaced by a new check.
    if (!canMove(status.state, 'checking')) return Promise.resolve(status);
    running = (async () => {
      const previous = status;
      setStatus({ state: 'checking', checkedAt: previous.checkedAt });
      if (inApp) {
        try {
          const result = await (await updater()).checkForUpdates();
          const info = result?.updateInfo;
          if (info && compareVersions(info.version, currentVersion) > 0) {
            const releasedAt = Date.parse(info.releaseDate);
            const update: AvailableUpdate = {
              version: info.version,
              pageUrl: releasePage(info.version),
              downloadUrl: null,
              publishedAt: Number.isFinite(releasedAt) ? releasedAt : null,
            };
            log(`Update available: ${update.version}; downloading`);
            void download(update);
            return status;
          }
          if (info) {
            setStatus({ state: 'current', checkedAt: Date.now() });
            return status;
          }
        } catch (error) {
          log(`Updater check failed (${errorText(error)}); asking the release page instead`);
        }
      }
      const result = await checkRelease();
      // Offline at the event: keep showing an update found earlier instead of forgetting it.
      setStatus(result.state === 'unreachable' && previous.state === 'available' ? previous : result);
      if (status.state === 'available') log(`Update available: ${status.update.version}`);
      return status;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  async function download(update: AvailableUpdate) {
    setStatus({ state: 'downloading', checkedAt: Date.now(), update, percent: 0 });
    try {
      await (await updater()).downloadUpdate();
      log(`Update ${update.version} downloaded and ready to install`);
      setStatus({ state: 'ready', checkedAt: Date.now(), update, problem: null });
    } catch (error) {
      log(`Update download failed: ${errorText(error)}`);
      setStatus({
        state: 'available',
        checkedAt: Date.now(),
        update,
        problem: 'Automatisch downloaden lukte niet. Download het installatiebestand zelf, of probeer later opnieuw.',
      });
    }
  }

  /** The updater's download-progress event. */
  function progress(percent: number) {
    const whole = Math.floor(percent);
    if (status.state !== 'downloading' || whole === status.percent) return;
    setStatus({ ...status, percent: whole });
  }

  /** Back to ready when installing stops before the app closes. */
  function installStopped(problem: string | null) {
    if (quitTimer) clearTimeout(quitTimer);
    quitTimer = null;
    if (status.state !== 'installing') return;
    setStatus({ state: 'ready', checkedAt: status.checkedAt, update: status.update, problem });
  }

  /** Resolves to null when the app is about to restart, or to the reason it did not. */
  async function install(): Promise<string | null> {
    if (status.state !== 'ready') return 'Er is geen update klaar om te installeren.';
    if (needsRestart) return NOT_CLOSED;
    if (isRaceActive()) return RACE_RUNNING;
    const { update, checkedAt } = status;
    setStatus({ state: 'installing', checkedAt, update });
    try {
      await makeBackup();
    } catch (error) {
      installStopped(null);
      return `De backup vooraf mislukte, dus de update is niet geïnstalleerd: ${errorText(error)}`;
    }
    // The race may have started during the backup.
    if (isRaceActive()) {
      installStopped(null);
      return RACE_RUNNING;
    }
    let instance: Updater;
    try {
      instance = await updater();
      beforeInstall(update.version);
    } catch (error) {
      installStopped(null);
      return `De update is niet geïnstalleerd: ${errorText(error)}`;
    }
    log(`Installing update ${update.version} and restarting`);
    // The updater reports a failure as an error event (updaterError), main.ts reports a
    // "Blijven" to the race question on closing (quitCancelled), and anything else that keeps
    // the app open ends here: the status must not stay at installing.
    quitTimer = setTimeout(() => {
      log('Still running after quitAndInstall; the update did not install');
      notClosed();
    }, QUIT_TIMEOUT_MS);
    quitTimer.unref?.();
    // Silent, then start the new version. Closing goes through the normal quit, which stops the server.
    setImmediate(() => {
      try {
        instance.quitAndInstall(true, true);
      } catch (error) {
        updaterError(error);
      }
    });
    return null;
  }

  /** Someone kept the app open when it closed to install. */
  function quitCancelled() {
    if (!quitTimer) return;
    log('Closing to install was cancelled; the update did not install');
    notClosed();
  }

  function notClosed() {
    needsRestart = true;
    installStopped(NOT_CLOSED);
  }

  /** The updater's error event: only one while closing to install changes the status. */
  function updaterError(error: unknown) {
    if (!quitTimer) return;
    log(`Update install failed: ${errorText(error)}`);
    installStopped(`De update is niet geïnstalleerd: ${errorText(error)}`);
  }

  return {
    status: () => status,
    check,
    install,
    progress,
    updaterError,
    quitCancelled,
  };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
