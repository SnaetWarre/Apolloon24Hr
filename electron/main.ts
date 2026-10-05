import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
  type OpenDialogOptions,
} from 'electron';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { fork, type ChildProcess } from 'child_process';
import { isRaceActive, stopWatchingRace, watchRace } from './race-guard.js';
import { parseEnvText, resolveServerAddress } from './server-config.js';
import { SPLASH_SIZE, splashBackground, splashHtml } from './splash.js';
import { describeUnexpectedStartupError, StartupError } from './startup-error.js';
import { setUpUpdates } from './updates.js';
import {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  parseWindowState,
  restorableBounds,
  type SavedWindowState,
} from './window-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | undefined;
let quitting = false;
/** Set once the operator confirmed closing the app while the race runs. */
let quitConfirmed = false;
let appUrl = 'http://127.0.0.1:5173';
const smokeTest = process.env.APOLLOON_PACKAGE_SMOKE === '1';
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'apng'];
const isMac = process.platform === 'darwin';
if (smokeTest) {
  if (!process.env.APOLLOON_SMOKE_DATA) throw new Error('Missing smoke test data directory');
  app.setPath('userData', process.env.APOLLOON_SMOKE_DATA);
}

/** The main window, hidden until its page has loaded; made while the server still starts. */
function createMainWindow(): BrowserWindow {
  if (mainWindow) return mainWindow; // Prevent multiple windows

  const saved = smokeTest ? null : readWindowState();
  const bounds = restorableBounds(
    saved,
    screen.getAllDisplays().map((display) => display.workArea)
  );
  // The renderer draws its own title bar (src/components/DesktopTitleBar.tsx), so the
  // window opens without the operating system's frame. macOS keeps its traffic lights.
  const window = new BrowserWindow({
    ...(bounds ?? DEFAULT_WINDOW_SIZE),
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    frame: isMac,
    titleBarStyle: isMac ? 'hidden' : 'default',
    trafficLightPosition: { x: 14, y: 11 },
    backgroundColor: '#f5f7fb',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow = window;
  if (bounds && saved?.maximized) window.maximize();
  wireWindowState(window);
  guardNavigation(window);
  recoverRenderer(window);
  guardClose(window);
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

async function loadMainWindow(window: BrowserWindow) {
  if (!app.isPackaged) {
    await window.loadURL(appUrl);
    window.webContents.openDevTools();
  } else {
    await loadPackagedRenderer(window);
  }
  if (!smokeTest && !window.isDestroyed()) window.show();
}

/**
 * How long the app may take before the splash shows. Most starts have the main window up
 * sooner, and a splash that appears only to vanish again looks like a glitch.
 */
const SPLASH_DELAY_MS = 500;
let splashTimer: NodeJS.Timeout | null = null;

function showSplashUnlessQuick() {
  splashTimer = setTimeout(() => {
    splashTimer = null;
    if (!mainWindow?.isVisible()) showSplash();
  }, SPLASH_DELAY_MS);
}

/** Shows while the app opens, until the main window is ready (see electron/splash.ts). */
function showSplash() {
  const dark = nativeTheme.shouldUseDarkColors;
  const window = new BrowserWindow({
    ...SPLASH_SIZE,
    // At once, not on ready-to-show: the first paint can take most of a second, which is
    // the wait this window is for. Its background matches the page, so nothing flashes.
    show: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    title: 'Apolloon Telsysteem',
    backgroundColor: splashBackground(dark),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false },
  });
  splashWindow = window;
  window.on('closed', () => {
    if (splashWindow === window) splashWindow = null;
  });
  const html = splashHtml({
    dark,
    version: app.getVersion(),
    logoDataUrl: inlineAsset(path.join('brand', 'apolloon-logo.png'), 'image/png'),
    fontDataUrl: inlineAsset(path.join('fonts', 'geist-latin-wght-normal.woff2'), 'font/woff2'),
  });
  void window.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html).toString('base64')}`);
}

/** A file from the client's public folder as a data: URL, or null when it is missing. */
function inlineAsset(relativePath: string, type: string): string | null {
  const folder = app.isPackaged ? 'dist' : 'public';
  try {
    const bytes = fs.readFileSync(path.join(app.getAppPath(), folder, relativePath));
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

function setSplashStatus(text: string) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  splashWindow.webContents.executeJavaScript(`window.setStatus?.(${JSON.stringify(text)})`).catch(() => {});
}

function cancelSplash() {
  if (splashTimer) clearTimeout(splashTimer);
  splashTimer = null;
}

function closeSplash() {
  cancelSplash();
  splashWindow?.destroy();
  splashWindow = null;
}

const windowStatePath = () => path.join(app.getPath('userData'), 'window-state.json');

function readWindowState(): SavedWindowState | null {
  try {
    return parseWindowState(fs.readFileSync(windowStatePath(), 'utf8'));
  } catch {
    return null;
  }
}

function saveWindowState(window: BrowserWindow): void {
  if (smokeTest || window.isDestroyed()) return;
  const state: SavedWindowState = { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
  try {
    fs.writeFileSync(windowStatePath(), JSON.stringify(state));
  } catch (error) {
    desktopLog(`Window position not saved: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The window only ever shows this laptop's own app. A link elsewhere opens in the
 * browser instead of replacing the timing screen, and no page can open new windows.
 */
function guardNavigation(window: BrowserWindow) {
  const openOutside = (url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (sameOrigin(url, appUrl)) return;
    event.preventDefault();
    openOutside(url);
  });
}

function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** How long a hung page may stay frozen before it is restarted. */
const UNRESPONSIVE_RESTART_MS = 10_000;

/**
 * A crashed or frozen page is loaded again on the same screen, so the operator gets the
 * timing screen back within seconds instead of a blank window. The race data lives in
 * the server, which a renderer crash does not touch.
 */
function recoverRenderer(window: BrowserWindow) {
  const recentCrashes: number[] = [];
  let unresponsiveTimer: NodeJS.Timeout | null = null;

  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || quitting || window.isDestroyed()) return;
    const now = Date.now();
    recentCrashes.push(now);
    while (recentCrashes.length && recentCrashes[0] < now - 60_000) recentCrashes.shift();
    // Keeps crashing: wait longer, so the laptop stays usable enough to close the app.
    const delayMs = recentCrashes.length > 3 ? 10_000 : 500;
    desktopLog(`Page stopped (${details.reason}, exit code ${details.exitCode}); reloading in ${delayMs} ms`);
    setTimeout(() => {
      if (!window.isDestroyed()) window.webContents.reload();
    }, delayMs);
  });
  window.on('unresponsive', () => {
    if (unresponsiveTimer) return;
    desktopLog('Page not responding');
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      if (!window.isDestroyed()) window.webContents.forcefullyCrashRenderer();
    }, UNRESPONSIVE_RESTART_MS);
  });
  window.on('responsive', () => {
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
  });
}

/** Closing the app while the race runs takes this laptop out of the group, so it asks first. */
function guardClose(window: BrowserWindow) {
  window.on('close', (event) => {
    if (quitConfirmed || smokeTest || !isRaceActive()) {
      saveWindowState(window);
      return;
    }
    event.preventDefault();
    void confirmQuitDuringRace().then((confirmed) => {
      if (!confirmed || window.isDestroyed()) return;
      // Destroyed rather than closed: a crashed or frozen page cannot hold the window open.
      saveWindowState(window);
      window.destroy();
    });
  });
}

let quitQuestion: Promise<boolean> | null = null;

function confirmQuitDuringRace(): Promise<boolean> {
  quitQuestion ??= (async () => {
    const options = {
      type: 'warning' as const,
      title: 'Apolloon afsluiten?',
      message: 'De wedstrijd loopt nog. Toch afsluiten?',
      detail:
        'Deze laptop valt dan weg uit de groep. De andere laptops werken verder, maar dan mag er geen enkele ' +
        'meer uitvallen. Start Apolloon daarna meteen opnieuw.',
      buttons: ['Blijven', 'Toch afsluiten'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
    quitConfirmed = response === 1;
    if (quitConfirmed) desktopLog('Closed during the race after confirmation');
    return quitConfirmed;
  })().finally(() => {
    quitQuestion = null;
  });
  return quitQuestion;
}

async function loadPackagedRenderer(window: BrowserWindow) {
  // A failed/older AppImage can leave cached 404 responses for the same hashed
  // assets. Clear that persistent HTTP cache when a version first opens.
  await clearCacheAfterUpdate(window);

  const versionedUrl = new URL(appUrl);
  versionedUrl.searchParams.set('desktopVersion', app.getVersion());
  await window.loadURL(versionedUrl.toString());

  let rendered = await rendererHasContent(window);
  if (!rendered) {
    console.warn('Renderer was empty after its first load; retrying without cache.');
    await window.webContents.session.clearCache();
    versionedUrl.searchParams.set('recovery', String(Date.now()));
    await window.loadURL(versionedUrl.toString());
    rendered = await rendererHasContent(window);
  }

  if (!rendered) {
    throw new StartupError({ kind: 'screen', detail: 'De pagina bleef leeg, ook na een tweede poging.' });
  }
}

const cacheVersionPath = () => path.join(app.getPath('userData'), 'page-cache-version');

/**
 * Clears the HTTP cache the first time a version opens. Not on every start: the cache also
 * holds the compiled page scripts, which then load without being compiled again.
 */
async function clearCacheAfterUpdate(window: BrowserWindow) {
  let cachedVersion = '';
  try {
    cachedVersion = fs.readFileSync(cacheVersionPath(), 'utf8');
  } catch {
    // Not opened before, or by a version from before this file existed.
  }
  if (cachedVersion === app.getVersion()) return;
  await window.webContents.session.clearCache();
  try {
    fs.writeFileSync(cacheVersionPath(), app.getVersion());
  } catch (error) {
    desktopLog(`Page cache version not saved: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function rendererHasContent(window: BrowserWindow): Promise<boolean> {
  if (window.isDestroyed()) return false;
  return window.webContents.executeJavaScript("Boolean(document.getElementById('root')?.childElementCount)");
}

type WindowState = { maximized: boolean; fullscreen: boolean; focused: boolean };

function windowState(window: BrowserWindow): WindowState {
  return { maximized: window.isMaximized(), fullscreen: window.isFullScreen(), focused: window.isFocused() };
}

/** Tells the renderer's title bar when the window is maximized, fullscreen or in the background. */
function wireWindowState(window: BrowserWindow) {
  const send = () => {
    if (!window.isDestroyed()) window.webContents.send('apolloon:window-state', windowState(window));
  };
  window.on('maximize', send);
  window.on('unmaximize', send);
  window.on('enter-full-screen', send);
  window.on('leave-full-screen', send);
  window.on('focus', send);
  window.on('blur', send);
  // Without the native frame there is no menu, so the few shortcuts that matter live here.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      event.preventDefault();
      window.setFullScreen(!window.isFullScreen());
    } else if (!app.isPackaged && (input.key === 'F12' || (input.control && input.shift && input.key === 'I'))) {
      event.preventDefault();
      window.webContents.toggleDevTools();
    }
  });
}

ipcMain.handle('apolloon:window-state', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window ? windowState(window) : null;
});

ipcMain.on('apolloon:window', (event, action: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  switch (action) {
    case 'minimize':
      window.minimize();
      break;
    case 'toggle-maximize':
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
      break;
    case 'close':
      window.close();
      break;
  }
});

ipcMain.handle('apolloon:pick-image', async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options: OpenDialogOptions = {
    title: 'Kies een logo',
    defaultPath: app.getPath('downloads'),
    properties: ['openFile'],
    filters: [
      { name: 'Afbeeldingen', extensions: IMAGE_EXTENSIONS },
      { name: 'Alle bestanden', extensions: ['*'] },
    ],
  };
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  const filePath = result.canceled ? null : result.filePaths[0];
  if (!filePath) return null;
  return { name: path.basename(filePath), bytes: await fs.promises.readFile(filePath) };
});

/** Opens the app data folder, which holds server.log, the database and the backups. */
ipcMain.handle('apolloon:open-data-folder', async () => {
  const error = await shell.openPath(app.getPath('userData'));
  return error || null;
});

/** What the person who supports this laptop needs to know, for "Diagnose kopiëren". */
ipcMain.handle('apolloon:diagnostics', async () => ({
  appVersion: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  os: `${os.type()} ${os.release()} ${process.arch}`,
  dataPath: app.getPath('userData'),
  logTail: await readLogTail(serverLogPath(), 60),
}));

/** The last lines of a log file; empty when there is none yet. */
async function readLogTail(filePath: string, lines: number): Promise<string> {
  try {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, 16 * 1024);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString('utf8').split(/\r?\n/).slice(-lines).join('\n').trim();
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

let updates: ReturnType<typeof setUpUpdates> | null = null;

/** The verified backup taken before installing an update, through the local server. */
async function backupBeforeUpdate(): Promise<void> {
  const response = await fetch(`${appUrl}/trpc/backups.create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`server antwoordde ${response.status}`);
}

function ensureEnvFile() {
  const envPath = path.join(app.getPath('userData'), '.env');
  if (!fs.existsSync(envPath)) {
    const envContent = `PORT=5173
`;
    fs.writeFileSync(envPath, envContent);
    console.log('Created default .env file at:', envPath);
  }
}

async function startServer() {
  ensureEnvFile();
  if (!app.isPackaged) {
    console.log('Development mode: using the external Vite/backend dev server.');
    return;
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    CLUSTER_ENABLED: process.env.CLUSTER_ENABLED || 'true',
    DATA_PATH: app.getPath('userData'),
    APOLLOON_APP_VERSION: app.getVersion(),
    // Node keeps the compiled server here, so later starts skip compiling it again.
    NODE_COMPILE_CACHE: path.join(app.getPath('userData'), 'compile-cache'),
  };
  const envPath = path.join(app.getPath('userData'), '.env');
  if (fs.existsSync(envPath)) {
    Object.assign(env, parseEnvText(fs.readFileSync(envPath, 'utf8')));
  }
  const serverAddress = resolveServerAddress(env);
  env.PORT = String(serverAddress.port);
  env.PUBLIC_APP_PORT = String(serverAddress.publicPort);
  appUrl = serverAddress.url;

  await waitForServer(appUrl, launchServer(env));
}

/**
 * Starts the backend and restarts it when it stops unexpectedly, so a crash
 * during the event costs seconds instead of a manual restart. Open screens
 * reconnect on their own.
 */
function launchServer(env: NodeJS.ProcessEnv, restartDelayMs = 1_000): ChildProcess {
  // The server runs from inside app.asar; Electron's Node mode reads the archive.
  const serverPath = path.join(app.getAppPath(), 'dist-server', 'server', 'index.js');
  const child = fork(serverPath, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env,
    cwd: app.getPath('userData'),
    execArgv: [],
  });
  const startedAt = Date.now();
  serverProcess = child;
  // Windows has no console for a desktop app, so the server output also goes to a file.
  const log = serverLog();
  log.write(`\n--- server start ${new Date().toISOString()} (${app.getVersion()}) ---\n`);
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    log.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    log.write(chunk);
    serverErrorTail = (serverErrorTail + chunk.toString()).slice(-4_000);
  });

  child.on('error', (err) => {
    console.error('Failed to start server:', err);
  });
  child.on('exit', (code, signal) => {
    console.log('Server exited with code:', code, 'signal:', signal);
    if (quitting || serverProcess !== child) return;
    // Back off when it keeps crashing right after starting.
    const nextDelayMs = Date.now() - startedAt < 30_000 ? Math.min(restartDelayMs * 2, 30_000) : 1_000;
    console.warn(`Restarting server in ${restartDelayMs} ms`);
    setTimeout(() => {
      // A failed start that is being retried has replaced or dropped this server already.
      if (!quitting && serverProcess === child) launchServer(env, nextDelayMs);
    }, restartDelayMs);
  });
  return child;
}

const SERVER_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** The end of the server's error output, to say why it stopped. */
let serverErrorTail = '';
let serverLogStream: fs.WriteStream | null = null;

/** Lines from the desktop app itself, among the server's in `server.log`. */
function desktopLog(message: string) {
  console.log(message);
  if (app.isReady()) serverLog().write(`[desktop ${new Date().toISOString()}] ${message}\n`);
}

const serverLogPath = () => path.join(app.getPath('userData'), 'server.log');

/** `server.log` in the app data folder, started over once it grows past a few MB. */
function serverLog(): fs.WriteStream {
  if (serverLogStream) return serverLogStream;
  const logPath = serverLogPath();
  const tooLarge = fs.existsSync(logPath) && fs.statSync(logPath).size > SERVER_LOG_MAX_BYTES;
  serverLogStream = fs.createWriteStream(logPath, { flags: tooLarge ? 'w' : 'a' });
  serverLogStream.on('error', (error) => console.error('Server log unavailable:', error));
  return serverLogStream;
}

async function waitForServer(url: string, child: ChildProcess, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  const port = Number(new URL(url).port);
  // The server says when it listens (server/index.ts); asking it over HTTP stays as the fallback.
  let listening = false;
  let wake = () => {};
  const onMessage = (message: unknown) => {
    if ((message as { type?: unknown } | null)?.type !== 'listening') return;
    listening = true;
    wake();
  };
  child.on('message', onMessage);
  try {
    while (Date.now() < deadline) {
      if (listening) return;
      if (child.exitCode !== null) {
        throw new StartupError({ kind: 'server-exited', exitCode: child.exitCode, errorOutput: serverErrorTail, port });
      }
      try {
        const response = await fetch(`${url}/api/host-info`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) return;
      } catch {
        // The local server can take a moment to open SQLite and bind its port.
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 200);
      });
    }
  } finally {
    child.off('message', onMessage);
  }
  throw new StartupError({ kind: 'server-timeout', seconds: Math.round(timeoutMs / 1000), port });
}

/** Stops a server that failed to start, without the automatic restart, so a retry starts clean. */
function dropServer() {
  const child = serverProcess;
  serverProcess = undefined;
  child?.kill();
  serverErrorTail = '';
}

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // The server needs nothing from Chromium, so it opens the database while Electron gets ready.
  const serverStarting = startServer();
  // Handled once openApp awaits it; until then a failure must not count as unhandled.
  serverStarting.catch(() => {});

  app.on('second-instance', () => {
    // Opening the app again while it starts brings the splash forward instead of doing nothing.
    // The main window stays hidden until its page has loaded, so whichever is on screen.
    const window = [mainWindow, splashWindow].find((each) => each && !each.isDestroyed() && each.isVisible());
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(() => {
    console.log('App starting');
    // Windows and Linux show no menu in a frameless window; dropping it also stops the
    // default menu's F11 from toggling fullscreen a second time. macOS keeps its menu.
    if (!isMac) Menu.setApplicationMenu(null);
    if (!smokeTest) showSplashUnlessQuick();
    // Once, before any window asks for the status: a retried start must not register it again.
    updates = setUpUpdates({
      log: desktopLog,
      send: (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('apolloon:update-status', status);
      },
      isRaceActive,
      makeBackup: backupBeforeUpdate,
    });
    void openApp(serverStarting);
  });
}

let watchingRace = false;

async function openApp(serverStarting = startServer()) {
  try {
    // The window and its page process get going while the server still starts.
    const window = createMainWindow();
    setSplashStatus('Databank openen…');
    await serverStarting;
    if (!watchingRace) {
      watchingRace = true;
      watchRace(
        () => appUrl,
        (active) => desktopLog(active ? 'Race running: keeping the screen awake' : 'Race stopped')
      );
    }
    setSplashStatus('Scherm laden…');
    await loadMainWindow(window);
    closeSplash();
    if (smokeTest) {
      const runners = await runPackagedSmokeChecks();
      fs.writeFileSync(
        path.join(app.getPath('userData'), 'smoke-result.json'),
        JSON.stringify({ version: app.getVersion(), renderer: true, database: true, runners })
      );
      app.quit();
      return;
    }
    updates?.start();
  } catch (error) {
    console.error('Failed to initialize Apolloon:', error);
    if (smokeTest) {
      app.exit(1);
      return;
    }
    desktopLog(`Start failed: ${error instanceof Error ? error.message : String(error)}`);
    // No restarts behind the question: a retry starts the server once, from the beginning.
    dropServer();
    if (await askToRetryStart(error)) {
      // The splash comes back before the half-opened main window goes, so the app does not quit.
      if (splashWindow) splashWindow.show();
      else showSplash();
      mainWindow?.destroy();
      mainWindow = null;
      setSplashStatus('Opnieuw proberen…');
      void openApp();
    } else {
      app.quit();
    }
  }
}

/** Says why the app did not open, in Dutch, with a way to retry and to find the log. */
async function askToRetryStart(error: unknown): Promise<boolean> {
  const { message, detail } = describeUnexpectedStartupError(error, serverLogPath());
  const options = {
    type: 'error' as const,
    title: 'Apolloon kon niet starten',
    message,
    detail,
    buttons: ['Opnieuw proberen', 'Logmap openen', 'Afsluiten'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  // The splash says it is still opening, so it steps aside for the dialog. Hidden, it still
  // counts as an open window, so the app does not quit underneath the question. The dialog
  // has no owner: some window managers put it behind its owner, and Wayland ends the app
  // when the owner is not on screen yet.
  cancelSplash();
  splashWindow?.hide();
  for (;;) {
    const { response } = await dialog.showMessageBox(options);
    if (response === 1) {
      await shell.openPath(app.getPath('userData'));
      continue;
    }
    return response === 0;
  }
}

/**
 * Checks that the server works from inside app.asar: database, backup worker,
 * and precompressed assets. Returns how many runners the live state has.
 */
async function runPackagedSmokeChecks(): Promise<number> {
  const response = await fetch(`${appUrl}/api/health`);
  const health = (await response.json()) as { database?: { ready?: boolean } };
  if (!response.ok || !health.database?.ready) throw new Error('SQLite is not ready');

  // Health does not read the event tables; the live state reads all of them.
  const stateResponse = await fetch(`${appUrl}/api/state`);
  const state = (await stateResponse.json()) as { runners?: unknown[]; error?: string };
  if (!stateResponse.ok || !Array.isArray(state.runners)) {
    throw new Error(`Live state failed (${stateResponse.status}): ${state.error ?? 'no runners'}`);
  }

  const backup = await fetch(`${appUrl}/trpc/backups.create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!backup.ok) throw new Error(`Verified backup failed: ${await backup.text()}`);

  const html = await (await fetch(appUrl)).text();
  const script = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  if (!script) throw new Error('index.html has no bundled script');
  const asset = await fetch(`${appUrl}${script}`, { headers: { 'Accept-Encoding': 'br' } });
  if (!asset.ok || asset.headers.get('content-encoding') !== 'br') {
    throw new Error(`Precompressed asset not served (${asset.status}, ${asset.headers.get('content-encoding')})`);
  }
  return state.runners.length;
}

function stopServer() {
  quitting = true;
  updates?.stop();
  stopWatchingRace();
  serverProcess?.kill();
}

app.on('window-all-closed', () => {
  stopServer();
  app.quit();
});

app.on('before-quit', (event) => {
  // Cmd+Q on macOS, or quitting from the dock, skips the window's close button.
  if (!quitConfirmed && !smokeTest && isRaceActive()) {
    event.preventDefault();
    void confirmQuitDuringRace().then((confirmed) => {
      if (confirmed) app.quit();
    });
    return;
  }
  stopServer();
});
