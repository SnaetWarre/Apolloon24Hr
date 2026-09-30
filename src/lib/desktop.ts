import React from 'react';

// The bridge electron/preload.cts exposes. Only set inside the desktop app; a browser
// on another laptop has none of this and shows the ordinary browser chrome.
export type DesktopWindowState = { maximized: boolean; fullscreen: boolean; focused: boolean };

export type DesktopBridge = {
  /** 'win32', 'darwin' or 'linux'. macOS keeps its own window buttons. */
  platform: string;
  pickImage: () => Promise<{ name: string; bytes: Uint8Array } | null>;
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
