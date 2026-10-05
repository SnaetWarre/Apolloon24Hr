import React from 'react';

// The bridge electron/preload.cts exposes. Only set inside the desktop app; a browser
// on another laptop has none of this and shows the ordinary browser chrome.
export type DesktopWindowState = { maximized: boolean; fullscreen: boolean; focused: boolean };

export type DesktopUpdate = {
  version: string;
  pageUrl: string;
  downloadUrl: string | null;
  publishedAt: number | null;
};

/** Mirrors UpdateStatus in electron/update-check.ts. */
export type DesktopUpdateStatus =
  | { state: 'checking'; checkedAt: number | null }
  | { state: 'current'; checkedAt: number }
  | { state: 'available'; checkedAt: number; update: DesktopUpdate }
  | { state: 'unreachable'; checkedAt: number };

export type DesktopDiagnostics = {
  appVersion: string;
  electron: string;
  chrome: string;
  os: string;
  dataPath: string;
  logTail: string;
};

export type DesktopBridge = {
  /** 'win32', 'darwin' or 'linux'. macOS keeps its own window buttons. */
  platform: string;
  pickImage: () => Promise<{ name: string; bytes: Uint8Array } | null>;
  openDataFolder: () => Promise<string | null>;
  getDiagnostics: () => Promise<DesktopDiagnostics>;
  update: {
    getStatus: () => Promise<DesktopUpdateStatus>;
    check: () => Promise<DesktopUpdateStatus>;
    open: (url: string) => Promise<void>;
    onChange: (listener: (status: DesktopUpdateStatus) => void) => () => void;
  };
  window: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    getState: () => Promise<DesktopWindowState | null>;
    onStateChange: (listener: (state: DesktopWindowState) => void) => () => void;
  };
};

declare global {
  interface Window {
    apolloonDesktop?: DesktopBridge;
  }
}

export function getDesktop(): DesktopBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.apolloonDesktop;
}

const INITIAL_STATE: DesktopWindowState = { maximized: false, fullscreen: false, focused: true };

/** Follows the window from the main process and mirrors fullscreen onto <html>, so CSS can drop the title bar. */
export function useDesktopWindowState(bridge: DesktopBridge): DesktopWindowState {
  const [state, setState] = React.useState(INITIAL_STATE);

  React.useEffect(() => {
    let active = true;
    void bridge.window.getState().then((current) => {
      if (active && current) setState(current);
    });
    const stop = bridge.window.onStateChange(setState);
    return () => {
      active = false;
      stop();
    };
  }, [bridge]);

  React.useLayoutEffect(() => {
    const root = document.documentElement;
    if (state.fullscreen) root.dataset.desktopFullscreen = '';
    else delete root.dataset.desktopFullscreen;
  }, [state.fullscreen]);

  return state;
}

/** The desktop app's update check; null in a browser, which cannot install anything. */
export function useDesktopUpdate(): {
  status: DesktopUpdateStatus | null;
  check: () => void;
  open: (url: string) => void;
} {
  const bridge = getDesktop();
  const [status, setStatus] = React.useState<DesktopUpdateStatus | null>(null);

  React.useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.update.getStatus().then((current) => {
      if (active) setStatus(current);
    });
    const stop = bridge.update.onChange(setStatus);
    return () => {
      active = false;
      stop();
    };
  }, [bridge]);

  const check = React.useCallback(() => {
    void bridge?.update.check().then(setStatus);
  }, [bridge]);
  const open = React.useCallback(
    (url: string) => {
      void bridge?.update.open(url);
    },
    [bridge]
  );
  return { status, check, open };
}
