import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import fs from 'fs';
import { createSetupServer } from './setup-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let serverProcess;
let setupServer;

function createWindow(showSetup = false) {
  mainWindow = new BrowserWindow({
    width: showSetup ? 600 : 1400,
    height: showSetup ? 700 : 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (showSetup) {
    const setupPath = path.join(__dirname, 'setup.html');
    mainWindow.loadFile(setupPath);
  } else if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL('http://localhost:5173');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function needsSetup() {
  const envPath = path.join(app.getPath('userData'), '.env');
  return !fs.existsSync(envPath);
}

function startServer() {
  const isDev = process.env.NODE_ENV === 'development';
  const serverPath = isDev 
    ? path.join(__dirname, '../server/index.js')
    : path.join(process.resourcesPath, 'app.asar.unpacked/server/index.js');
  
  const envPath = path.join(app.getPath('userData'), '.env');
  const env = { 
    ...process.env, 
    NODE_ENV: 'production',
    NODE_PATH: isDev ? '' : path.join(process.resourcesPath, 'app.asar.unpacked/node_modules'),
    DATA_PATH: app.getPath('userData')
  };
  
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const [key, value] = line.split('=');
      if (key && value) env[key.trim()] = value.trim();
    });
  }
  
  const cwd = isDev ? process.cwd() : path.join(process.resourcesPath, 'app.asar.unpacked');
  
  serverProcess = spawn('node', [serverPath], {
    stdio: 'inherit',
    env,
    cwd,
  });

  serverProcess.on('error', (err) => {
    console.error('Failed to start server:', err);
  });
}

app.whenReady().then(() => {
  if (needsSetup()) {
    setupServer = createSetupServer();
    createWindow(true);
    
    const checkSetup = setInterval(() => {
      if (!needsSetup()) {
        clearInterval(checkSetup);
        if (mainWindow) mainWindow.close();
        startServer();
        setTimeout(() => createWindow(false), 2000);
      }
    }, 500);
  } else {
    startServer();
    setTimeout(() => createWindow(false), 2000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(!needsSetup());
    }
  });
});

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
  if (setupServer) {
    setupServer.close();
  }
});

