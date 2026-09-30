import { useDesktopWindowState, type DesktopBridge } from '../lib/desktop';

/**
 * The title bar of the desktop window, which opens without the operating system's frame.
 * Everything except the buttons is a drag handle; double-clicking it maximizes, as on any window.
 * Hidden by CSS while the window is fullscreen (F11, handled in electron/main.ts), which is how
 * the public displays run on a tv.
 */
export function DesktopTitleBar({ bridge, onHome }: { bridge: DesktopBridge; onHome: () => void }) {
  const state = useDesktopWindowState(bridge);
  const mac = bridge.platform === 'darwin';
  const className = `titlebar${mac ? ' titlebar--mac' : ''}${state.focused ? '' : ' is-inactive'}`;

  return (
    <header className={className}>
      <button type="button" className="titlebar__brand" onClick={onHome} title="Naar het overzicht">
        <span className="brand-mark" aria-hidden="true" />
        <span className="visually-hidden">Apolloon, naar het overzicht</span>
      </button>
      {!mac && (
        <div className="titlebar__controls" role="group" aria-label="Venster">
          <TitleBarButton label="Minimaliseren" onClick={bridge.window.minimize}>
            <path d="M0.5 5h9" />
          </TitleBarButton>
          <TitleBarButton
            label={state.maximized ? 'Herstellen' : 'Maximaliseren'}
            onClick={bridge.window.toggleMaximize}
          >
            {state.maximized ? (
              <>
                <path d="M2.5 2.5v-1a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
                <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
              </>
            ) : (
              <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
            )}
          </TitleBarButton>
          <TitleBarButton label="Sluiten" onClick={bridge.window.close} close>
            <path d="m0.5 0.5 9 9M9.5 0.5l-9 9" />
          </TitleBarButton>
        </div>
      )}
    </header>
  );
}

function TitleBarButton({
  label,
  onClick,
  close = false,
  children,
}: {
  label: string;
  onClick: () => void;
  close?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`titlebar__control${close ? ' titlebar__control--close' : ''}`}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
        {children}
      </svg>
    </button>
  );
}
