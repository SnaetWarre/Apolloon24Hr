import { app, ipcMain, shell } from 'electron';
import type { AppUpdater } from 'electron-updater';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  canInstallInApp,
  checkForUpdate,
  installOutcome,
  isReleaseUrl,
  RELEASES_PAGE,
  updaterCacheDirName,
  type InstallOutcome,
  type UpdateStatus,
} from './update-check.js';
import { createUpdateFlow, errorText } from './update-flow.js';

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

  let updaterInstance: AppUpdater | null = null;

  /**
   * Created on first use: the getter builds the platform's updater. Loaded then too, because
   * importing electron-updater at launch held up the start by about a tenth of a second.
   */
  async function updater(): Promise<AppUpdater> {
    if (updaterInstance) return updaterInstance;
    const { default: electronUpdater } = await import('electron-updater');
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
    instance.on('download-progress', (progress) => flow.progress(progress.percent));
    instance.on('error', (error) => flow.updaterError(error));
    updaterInstance = instance;
    return instance;
  }

  const flow = createUpdateFlow({
    currentVersion: app.getVersion(),
    inApp,
    updater,
    checkRelease: () =>
      checkForUpdate({ currentVersion: app.getVersion(), platform: process.platform, arch: process.arch }),
    log,
    send,
    isRaceActive,
    makeBackup,
    beforeInstall: (version) => {
      fs.writeFileSync(notePath, JSON.stringify({ version, from: app.getVersion() }));
    },
  });
  let timer: NodeJS.Timeout | null = null;

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

  ipcMain.handle('apolloon:update-status', () => flow.status());
  ipcMain.handle('apolloon:check-update', () => flow.check());
  ipcMain.handle('apolloon:install-update', () => flow.install());
  ipcMain.handle('apolloon:last-install', () => lastInstall);
  ipcMain.handle('apolloon:open-release', (_event, url: unknown) => {
    void shell.openExternal(typeof url === 'string' && isReleaseUrl(url) ? url : RELEASES_PAGE);
  });

  return {
    /** APOLLOON_UPDATE_CHECK=0 turns it off, for rehearsals and machines without internet on purpose. */
    start() {
      if (timer || process.env.APOLLOON_UPDATE_CHECK === '0') return;
      timer = setTimeout(function next() {
        void flow.check();
        timer = setTimeout(next, CHECK_INTERVAL_MS);
      }, FIRST_CHECK_DELAY_MS);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    /** The race question on closing was answered "Blijven". */
    quitCancelled: () => flow.quitCancelled(),
  };
}

/** Where electron-updater keeps its downloads (its getAppCacheDir). */
function cacheBase(): string {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches');
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
}
