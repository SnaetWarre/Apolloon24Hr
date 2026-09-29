import { app, BrowserWindow, dialog } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { fork } from 'child_process';
import { parseEnvText, resolveServerAddress } from './server-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let serverProcess;
let quitting = false;
let appUrl = 'http://127.0.0.1:5173';
const smokeTest = process.env.APOLLOON_PACKAGE_SMOKE === '1';
if (smokeTest) {
  if (!process.env.APOLLOON_SMOKE_DATA) throw new Error('Missing smoke test data directory');
  app.setPath('userData', process.env.APOLLOON_SMOKE_DATA);
}

async function createWindow() {
  if (mainWindow) return; // Prevent multiple windows

  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#f5f7fb',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
    },
  });
  mainWindow = window;

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

async function loadPackagedRenderer(window) {
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

async function rendererHasContent(window) {
  if (window.isDestroyed()) return false;
  return window.webContents.executeJavaScript("Boolean(document.getElementById('root')?.childElementCount)");
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
  if (!app.isPackaged) {
    console.log('Development mode: using the external Vite/backend dev server.');
    return;
  }

  const env = {
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
function launchServer(env, restartDelayMs = 1_000) {
  const cwd = path.join(process.resourcesPath, 'app.asar.unpacked');
  const serverPath = path.join(cwd, 'dist-server', 'server', 'index.js');
  const child = fork(serverPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env, cwd, execArgv: [] });
  const startedAt = Date.now();
  serverProcess = child;

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

async function waitForServer(url, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Local server stopped before startup completed (exit ${child.exitCode}).`);
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
    ensureEnvFile();
    try {
      await startServer();
      await createWindow();
      if (smokeTest) {
        const response = await fetch(`${appUrl}/api/health`);
        const health = await response.json();
        if (!response.ok || !health.database?.ready) throw new Error('SQLite is not ready');
        fs.writeFileSync(
          path.join(app.getPath('userData'), 'smoke-result.json'),
          JSON.stringify({ version: app.getVersion(), renderer: true, database: true })
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

function stopServer() {
  quitting = true;
  serverProcess?.kill();
}

app.on('window-all-closed', () => {
  stopServer();
  app.quit();
});

app.on('before-quit', stopServer);
