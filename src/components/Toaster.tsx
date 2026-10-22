import React from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

/** `text` is the outcome in one line; `detail` is an optional second line, like what to do next. */
export type ToastMessage = { text: string; detail?: string };
export type ToastInput = ToastMessage & { tone: 'success' | 'error' };

type ToastEntry = ToastInput & { id: number; leaving: boolean };

// Long enough to read two lines after looking up from the button, short enough not to pile up.
const SUCCESS_MS = 7_000;
// More stack up only after rapid repeats; the oldest goes first.
const MAX_SHOWN = 3;

const ToastContext = React.createContext<((toast: ToastInput) => void) | null>(null);
/** Where a notice that stays (StickyToast) goes: above the toasts in the same corner. */
const StickyHostContext = React.createContext<HTMLElement | null>(null);

/**
 * Says how an action went in a card at the bottom right, so feedback never pushes the page around.
 * A success leaves after a few seconds; a failure stays until someone clicks it away.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastEntry[]>([]);
  const [stickyHost, setStickyHost] = React.useState<HTMLElement | null>(null);
  const nextIdRef = React.useRef(0);
  const [host] = React.useState(() => {
    const element = document.createElement('div');
    element.style.display = 'contents';
    return element;
  });

  // An open modal dialog blocks clicks on everything outside it, so the toasts move into the top one.
  // moveBefore keeps their animations and timers running; append restarts them, in older browsers only.
  React.useLayoutEffect(() => {
    const place = () => {
      const modals = document.querySelectorAll('dialog:modal');
      const parent = modals[modals.length - 1] ?? document.body;
      if (host.parentNode === parent) return;
      if (host.isConnected && 'moveBefore' in parent) parent.moveBefore(host, null);
      else parent.append(host);
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(document.body, { attributes: true, attributeFilter: ['open'], subtree: true });
    return () => {
      observer.disconnect();
      host.remove();
    };
  }, [host]);

  const toast = React.useCallback((input: ToastInput) => {
    const entry = { ...input, id: ++nextIdRef.current, leaving: false };
    setToasts((current) => [...current, entry].slice(-MAX_SHOWN));
  }, []);

  const dismiss = React.useCallback((id: number) => {
    setToasts((current) => current.map((entry) => (entry.id === id ? { ...entry, leaving: true } : entry)));
  }, []);

  const remove = React.useCallback((id: number) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      <StickyHostContext.Provider value={stickyHost}>{children}</StickyHostContext.Provider>
      {createPortal(
        <section className="toaster" aria-label="Meldingen">
          <div ref={setStickyHost} className="toaster__sticky" />
          {toasts.map((entry) => (
            <Toast key={entry.id} toast={entry} onDismiss={dismiss} onRemove={remove} />
          ))}
        </section>,
        host
      )}
    </ToastContext.Provider>
  );
}

function Toast({
  toast,
  onDismiss,
  onRemove,
}: {
  toast: ToastEntry;
  onDismiss: (id: number) => void;
  onRemove: (id: number) => void;
}) {
  const { id, tone, text, detail, leaving } = toast;
  const timed = tone === 'success';
  const [held, setHeld] = React.useState(false);
  // Time left on the clock, kept across pauses so a hover does not restart it.
  const remainingRef = React.useRef(SUCCESS_MS);

  React.useEffect(() => {
    if (!timed || held || leaving) return;
    const startedAt = performance.now();
    const timeout = window.setTimeout(() => onDismiss(id), remainingRef.current);
    return () => {
      window.clearTimeout(timeout);
      remainingRef.current -= performance.now() - startedAt;
    };
  }, [timed, held, leaving, id, onDismiss]);

  return (
    <div
      className={`toast toast--${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
      data-leaving={leaving || undefined}
      data-held={held || undefined}
      style={{ '--toast-ms': `${SUCCESS_MS}ms` } as React.CSSProperties}
      onClick={() => onDismiss(id)}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      onAnimationEnd={(event) => {
        if (leaving && event.target === event.currentTarget) onRemove(id);
      }}
    >
      <span className="toast__mark" aria-hidden="true">
        <Icon name={tone === 'error' ? 'alert' : 'check'} size={14} />
      </span>
      <span className="toast__body">
        <strong>{text}</strong>
        {detail && <span>{detail}</span>}
      </span>
      <button type="button" className="toast__close" aria-label="Melding sluiten">
        <Icon name="close" size={14} />
      </button>
      {timed && <span className="toast__timer" aria-hidden="true" />}
    </div>
  );
}

export function useToast() {
  const toast = React.useContext(ToastContext);
  if (!toast) throw new Error('useToast must be used inside ToastProvider');
  return toast;
}

/** A notice in the toast corner that stays as long as it is rendered: it has no close button and no timer. */
export function StickyToast({ text, detail }: ToastMessage) {
  const host = React.useContext(StickyHostContext);
  if (!host) return null;
  return createPortal(
    <div className="toast toast--success toast--sticky" role="status">
      <span className="toast__mark" aria-hidden="true">
        <Icon name="check" size={14} />
      </span>
      <span className="toast__body">
        <strong>{text}</strong>
        {detail && <span>{detail}</span>}
      </span>
    </div>,
    host
  );
}
