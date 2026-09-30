// Sandboxed preload: only the small bridge the renderer needs from the desktop app.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('apolloonDesktop', {
  /** Opens the file dialog in Downloads; resolves to the chosen file, or null when cancelled. */
  pickImage: () => ipcRenderer.invoke('apolloon:pick-image'),
});
