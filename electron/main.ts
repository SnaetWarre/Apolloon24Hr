import { app, BrowserWindow, dialog, ipcMain, Menu, type OpenDialogOptions } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { fork, type ChildProcess } from 'child_process';
import { parseEnvText, resolveServerAddress } from './server-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | undefined;
let quitting = false;
let appUrl = 'http://127.0.0.1:5173';
const smokeTest = process.env.APOLLOON_PACKAGE_SMOKE === '1';
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'apng'];
const isMac = process.platform === 'darwin';
if (smokeTest) {
  if (!process.env.APOLLOON_SMOKE_DATA) throw new Error('Missing smoke test data directory');
  app.setPath('userData', process.env.APOLLOON_SMOKE_DATA);
}

async function createWindow() {
  if (mainWindow) return; // Prevent multiple windows

  // The renderer draws its own title bar (src/components/DesktopTitleBar.tsx), so the
  // window opens without the operating system's frame. macOS keeps its traffic lights.
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    show: false,
    frame: isMac,
    titleBarStyle: isMac ? 'hidden' : 'default',
    trafficLightPosition: { x: 14, y: 11 },
    backgroundColor: '#f5f7fb',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow = window;
  wireWindowState(window);

  if (!app.isPackaged) {
    await window.loadURL(appUrl);
    window.webContents.openDevTools();
  } else {
    await loadPackagedRenderer(window);
  }
  if (!smokeTest && !window.isDestroyed()) window.show();

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
}

async function loadPackagedRenderer(window: BrowserWindow) {
  // A failed/older AppImage can leave cached 404 responses for the same hashed
  // assets. Clear that persistent HTTP cache before loading the local UI.
  await window.webContents.session.clearCache();

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
    throw new Error('De gebruikersinterface kon niet worden geladen.');
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
      if (!quitting) launchServer(env, nextDelayMs);
    }, restartDelayMs);
  });
  return child;
}

const SERVER_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** The end of the server's error output, to say why it stopped. */
let serverErrorTail = '';
let serverLogStream: fs.WriteStream | null = null;

/** `server.log` in the app data folder, started over once it grows past a few MB. */
function serverLog(): fs.WriteStream {
  if (serverLogStream) return serverLogStream;
  const logPath = path.join(app.getPath('userData'), 'server.log');
  const tooLarge = fs.existsSync(logPath) && fs.statSync(logPath).size > SERVER_LOG_MAX_BYTES;
  serverLogStream = fs.createWriteStream(logPath, { flags: tooLarge ? 'w' : 'a' });
  serverLogStream.on('error', (error) => console.error('Server log unavailable:', error));
  return serverLogStream;
}

async function waitForServer(url: string, child: ChildProcess, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const reason = serverErrorTail.match(/^\w*Error: .*$/m)?.[0];
      throw new Error(
        `Local server stopped before startup completed (exit ${child.exitCode}).` +
          (reason ? `\n\n${reason}` : '') +
          `\n\nDetails: ${path.join(app.getPath('userData'), 'server.log')}`
      );
    }
    try {
      const response = await fetch(`${url}/api/host-info`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The local server can take a moment to open SQLite and bind its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Local server did not become ready at ${url} within ${timeoutMs} ms.`);
}

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    console.log('App starting');
    // Windows and Linux show no menu in a frameless window; dropping it also stops the
    // default menu's F11 from toggling fullscreen a second time. macOS keeps its menu.
    if (!isMac) Menu.setApplicationMenu(null);
    ensureEnvFile();
    try {
      await startServer();
      await createWindow();
      if (smokeTest) {
        const runners = await runPackagedSmokeChecks();
        fs.writeFileSync(
          path.join(app.getPath('userData'), 'smoke-result.json'),
          JSON.stringify({ version: app.getVersion(), renderer: true, database: true, runners })
        );
        app.quit();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Failed to initialize Apolloon:', error);
      if (smokeTest) app.exit(1);
      else {
        dialog.showErrorBox('Apolloon kon niet starten', message);
        app.quit();
      }
    }
  });
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
  serverProcess?.kill();
}

app.on('window-all-closed', () => {
  stopServer();
  app.quit();
});

app.on('before-quit', stopServer);
