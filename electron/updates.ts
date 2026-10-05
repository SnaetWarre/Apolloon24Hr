import { app, ipcMain, shell } from 'electron';
import electronUpdater, { type AppUpdater } from 'electron-updater';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  canInstallInApp,
  checkForUpdate,
  compareVersions,
  installOutcome,
  isReleaseUrl,
  releasePage,
  RELEASES_PAGE,
  updaterCacheDirName,
  type AvailableUpdate,
  type InstallOutcome,
  type UpdateStatus,
} from './update-check.js';

/**
 * Newer versions, from finding one to running it.
 *
 * Windows and an AppImage download it in the background, and one click in Beheer makes a
 * backup, installs it silently, and reopens the app (electron-updater, reading the
 * latest*.yml files of the public releases repository). Nothing installs by itself: all
 * laptops must run the same version, so someone chooses the moment, and never while the
 * race runs. Other installs (macOS, development) get a link to the installer instead.
 */

/** Every six hours, so a laptop that sits on a desk for days still finds out. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Not right at startup: the first seconds belong to opening the database and the window. */
const FIRST_CHECK_DELAY_MS = 10_000;

const RACE_RUNNING = 'De wedstrijd loopt. Installeer de update pas na de wedstrijd.';

export function setUpUpdates({
  log,
  send,
  isRaceActive,
  makeBackup,
}: {
  log: (message: string) => void;
  /** Passes the status to the window, when there is one. */
  send: (status: UpdateStatus) => void;
  isRaceActive: () => boolean;
  /** A verified backup of the database; throws when it fails. */
  makeBackup: () => Promise<void>;
}) {
  const inApp = canInstallInApp({
    isPackaged: app.isPackaged,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
  });
  const notePath = path.join(app.getPath('userData'), 'update-install.json');
  const lastInstall = readLastInstall();

  let status: UpdateStatus = { state: 'checking', checkedAt: null };
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<UpdateStatus> | null = null;
  let updaterInstance: AppUpdater | null = null;

  function setStatus(next: UpdateStatus) {
    status = next;
    send(status);
  }

  /** Created on first use: the getter builds the platform's updater. */
  function updater(): AppUpdater {
    if (updaterInstance) return updaterInstance;
    const instance = electronUpdater.autoUpdater;
    instance.logger = {
      info: (message: unknown) => log(`Updater: ${String(message)}`),
      warn: (message: unknown) => log(`Updater: ${String(message)}`),
      error: (message: unknown) => log(`Updater error: ${String(message)}`),
      debug: () => {},
    };
    instance.autoDownload = false;
    // Only the button installs: quitting the app with a downloaded update must not.
    instance.autoInstallOnAppQuit = false;
    // The whole installer, not a patch built from the previous one: one way that can fail.
    instance.disableDifferentialDownload = true;
    // For trying an update against a local folder of release files (README, Releases And Updates).
    if (process.env.APOLLOON_UPDATE_FEED) {
      instance.setFeedURL({ provider: 'generic', url: process.env.APOLLOON_UPDATE_FEED });
    }
    let lastPercent = -1;
    instance.on('download-progress', (progress) => {
      const percent = Math.floor(progress.percent);
      if (status.state !== 'downloading' || percent === lastPercent) return;
      lastPercent = percent;
      setStatus({ ...status, percent });
    });
    updaterInstance = instance;
    return instance;
  }

  function check(): Promise<UpdateStatus> {
    // A download in progress or waiting to be installed is not replaced by a new check.
    if (status.state === 'downloading' || status.state === 'ready' || status.state === 'installing') {
      return Promise.resolve(status);
    }
    running ??= (async () => {
      const previous = status;
      setStatus({ state: 'checking', checkedAt: previous.checkedAt });
      if (inApp) {
        try {
          const result = await updater().checkForUpdates();
          const info = result?.updateInfo;
          if (info && compareVersions(info.version, app.getVersion()) > 0) {
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
      const result = await checkForUpdate({
        currentVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
      });
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
      await updater().downloadUpdate();
      log(`Update ${update.version} downloaded and ready to install`);
      setStatus({ state: 'ready', checkedAt: Date.now(), update });
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

  /** Resolves to null when the app is about to restart, or to the reason it did not. */
  async function install(): Promise<string | null> {
    if (status.state !== 'ready') return 'Er is geen update klaar om te installeren.';
    if (isRaceActive()) return RACE_RUNNING;
    const ready = status;
    setStatus({ state: 'installing', checkedAt: ready.checkedAt, update: ready.update });
    try {
      await makeBackup();
    } catch (error) {
      setStatus(ready);
      return `De backup vooraf mislukte, dus de update is niet geïnstalleerd: ${errorText(error)}`;
    }
    // The race may have started during the backup.
    if (isRaceActive()) {
      setStatus(ready);
      return RACE_RUNNING;
    }
    fs.writeFileSync(notePath, JSON.stringify({ version: ready.update.version, from: app.getVersion() }));
    log(`Installing update ${ready.update.version} and restarting`);
    // Silent, then start the new version. Closing goes through the normal quit, which stops the server.
    setImmediate(() => updater().quitAndInstall(true, true));
    return null;
  }

  /** After an update from the app: whether it took, and the installer it no longer needs. */
  function readLastInstall(): InstallOutcome | null {
    let noteText: string | null = null;
    try {
      noteText = fs.readFileSync(notePath, 'utf8');
      fs.rmSync(notePath, { force: true });
    } catch {
      return null;
    }
    const outcome = installOutcome(noteText, app.getVersion());
    if (!outcome) return null;
    if (outcome.ok) {
      log(`Updated to ${app.getVersion()}`);
      removeDownloadedInstaller();
    } else {
      log(`Update to ${outcome.version} did not install; still ${app.getVersion()}`);
    }
    return outcome;
  }

  /** electron-updater keeps the installer in its cache after installing; it is 100+ MB. */
  function removeDownloadedInstaller() {
    let appUpdateYml: string | null = null;
    try {
      appUpdateYml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    } catch {
      // Not packaged with a publish configuration; use the updater's own fallback name.
    }
    const pending = path.join(cacheBase(), updaterCacheDirName(appUpdateYml, app.getName()), 'pending');
    try {
      fs.rmSync(pending, { recursive: true, force: true });
    } catch (error) {
      log(`Downloaded installer not removed: ${errorText(error)}`);
    }
  }

  ipcMain.handle('apolloon:update-status', () => status);
  ipcMain.handle('apolloon:check-update', () => check());
  ipcMain.handle('apolloon:install-update', () => install());
  ipcMain.handle('apolloon:last-install', () => lastInstall);
  ipcMain.handle('apolloon:open-release', (_event, url: unknown) => {
    void shell.openExternal(typeof url === 'string' && isReleaseUrl(url) ? url : RELEASES_PAGE);
  });

  return {
    /** APOLLOON_UPDATE_CHECK=0 turns it off, for rehearsals and machines without internet on purpose. */
    start() {
      if (timer || process.env.APOLLOON_UPDATE_CHECK === '0') return;
      timer = setTimeout(function next() {
        void check();
        timer = setTimeout(next, CHECK_INTERVAL_MS);
      }, FIRST_CHECK_DELAY_MS);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Where electron-updater keeps its downloads (its getAppCacheDir). */
function cacheBase(): string {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches');
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
