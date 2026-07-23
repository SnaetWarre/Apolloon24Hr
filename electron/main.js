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
let appUrl = 'http://127.0.0.1:5173';

function createWindow() {
  if (mainWindow) return; // Prevent multiple windows

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
    },
  });

  if (!app.isPackaged) {
    mainWindow.loadURL(appUrl);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL(appUrl);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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

  const serverPath = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'dist-server',
    'server',
    'index.js'
  );

  const envPath = path.join(app.getPath('userData'), '.env');
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    CLUSTER_ENABLED: process.env.CLUSTER_ENABLED || 'true',
    DATA_PATH: app.getPath('userData'),
  };

  if (fs.existsSync(envPath)) {
    Object.assign(env, parseEnvText(fs.readFileSync(envPath, 'utf8')));
  }
  const serverAddress = resolveServerAddress(env);
  env.PORT = String(serverAddress.port);
  env.PUBLIC_APP_PORT = String(serverAddress.publicPort);
  appUrl = serverAddress.url;

  const cwd = path.join(process.resourcesPath, 'app.asar.unpacked');

  console.log('Starting server:', { serverPath, cwd });

  serverProcess = fork(serverPath, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env,
    cwd,
    execArgv: []
  });

  serverProcess.on('error', (err) => {
    console.error('Failed to start server:', err);
  });

  serverProcess.on('exit', (code, signal) => {
    console.log('Server exited with code:', code, 'signal:', signal);
  });

  await waitForServer(appUrl, serverProcess);
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
      createWindow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Failed to initialize Apolloon:', error);
      dialog.showErrorBox('Apolloon kon niet starten', message);
      app.quit();
    }
  });
}

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
  app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
});
