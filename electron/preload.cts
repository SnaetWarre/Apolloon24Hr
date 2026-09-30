// Sandboxed preload: only the small bridge the renderer needs from the desktop app.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

type WindowState = { maximized: boolean; fullscreen: boolean; focused: boolean };

contextBridge.exposeInMainWorld('apolloonDesktop', {
  /** 'win32', 'darwin' or 'linux': macOS draws its own window buttons. */
  platform: process.platform,
  /** Opens the file dialog in Downloads; resolves to the chosen file, or null when cancelled. */
  pickImage: () => ipcRenderer.invoke('apolloon:pick-image'),
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
