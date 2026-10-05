// Sandboxed preload: only the small bridge the renderer needs from the desktop app.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

type WindowState = { maximized: boolean; fullscreen: boolean; focused: boolean };
/** See UpdateStatus in electron/update-check.ts. */
type UpdateStatus = { state: string; checkedAt: number | null };

contextBridge.exposeInMainWorld('apolloonDesktop', {
  /** 'win32', 'darwin' or 'linux': macOS draws its own window buttons. */
  platform: process.platform,
  /** Opens the file dialog in Downloads; resolves to the chosen file, or null when cancelled. */
  pickImage: () => ipcRenderer.invoke('apolloon:pick-image'),
  /** Opens the app data folder (server.log, database, backups); resolves to an error text or null. */
  openDataFolder: () => ipcRenderer.invoke('apolloon:open-data-folder'),
  /** Version, operating system, data folder and the end of server.log, for "Diagnose kopiëren". */
  getDiagnostics: () => ipcRenderer.invoke('apolloon:diagnostics'),
  /** Whether a newer version is published; checked a few seconds after start and every six hours. */
  update: {
    getStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('apolloon:update-status'),
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke('apolloon:check-update'),
    /** Opens a page or installer of the releases repository in the browser. */
    open: (url: string) => ipcRenderer.invoke('apolloon:open-release', url),
    onChange: (listener: (status: UpdateStatus) => void) => {
      const handler = (_event: unknown, status: UpdateStatus) => listener(status);
      ipcRenderer.on('apolloon:update-status', handler);
      return () => ipcRenderer.removeListener('apolloon:update-status', handler);
    },
  },
  /** Window buttons of the title bar the renderer draws itself. */
  window: {
    minimize: () => ipcRenderer.send('apolloon:window', 'minimize'),
    toggleMaximize: () => ipcRenderer.send('apolloon:window', 'toggle-maximize'),
    close: () => ipcRenderer.send('apolloon:window', 'close'),
    getState: (): Promise<WindowState | null> => ipcRenderer.invoke('apolloon:window-state'),
    /** Calls back on every change; returns the function that stops listening. */
    onStateChange: (listener: (state: WindowState) => void) => {
      const handler = (_event: unknown, state: WindowState) => listener(state);
      ipcRenderer.on('apolloon:window-state', handler);
      return () => ipcRenderer.removeListener('apolloon:window-state', handler);
    },
  },
});
