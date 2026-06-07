import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { fork } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let serverProcess;

function createWindow() {
  if (mainWindow) return; // Prevent multiple windows

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL('http://localhost:5173');
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
    DATA_PATH: app.getPath('userData'),
    PUBLIC_APP_PORT: process.env.PUBLIC_APP_PORT || '5173',
  };

  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const [key, value] = line.split('=');
      if (key && value) env[key.trim()] = value.trim();
    });
  }

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

  app.whenReady().then(() => {
    console.log('App starting');
    ensureEnvFile();
    startServer();
    if (app.isPackaged) {
      setTimeout(() => createWindow(), 2000);
    } else {
      createWindow();
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
