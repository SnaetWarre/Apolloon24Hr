import React from 'react';
import { ModalDialog } from './ModalDialog';

export type ConfirmOptions = {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Danger confirmations start on Annuleer, so Enter never confirms by accident. */
  tone?: 'default' | 'danger';
};

type ConfirmFunction = (options: ConfirmOptions) => Promise<boolean>;

type PendingConfirm = {
  id: number;
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
};

const ConfirmContext = React.createContext<ConfirmFunction | null>(null);

/**
 * In-app replacement for window.confirm. The native prompt blocks the renderer,
 * which freezes the live clocks and realtime updates while it is open.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<PendingConfirm | null>(null);
  const pendingRef = React.useRef<PendingConfirm | null>(null);
  const nextIdRef = React.useRef(0);

  const confirm = React.useCallback<ConfirmFunction>(
    (options) =>
      new Promise<boolean>((resolve) => {
        pendingRef.current?.resolve(false);
        const next = { id: ++nextIdRef.current, options, resolve };
        pendingRef.current = next;
        setPending(next);
      }),
    []
  );

  const settle = (confirmed: boolean) => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    setPending(null);
    current.resolve(confirmed);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && <ConfirmModal key={pending.id} options={pending.options} onSettle={settle} />}
    </ConfirmContext.Provider>
  );
}

function ConfirmModal({ options, onSettle }: { options: ConfirmOptions; onSettle: (confirmed: boolean) => void }) {
  const { title, message, confirmLabel = 'Bevestig', cancelLabel = 'Annuleer', tone = 'default' } = options;
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const confirmRef = React.useRef<HTMLButtonElement>(null);
  const danger = tone === 'danger';

  return (
    <ModalDialog label={title} onRequestClose={() => onSettle(false)} initialFocusRef={danger ? cancelRef : confirmRef}>
      <div className={`confirm-modal${danger ? ' confirm-modal--danger' : ''}`}>
        <h3>{title}</h3>
        {message &&
          (typeof message === 'string' ? <p>{message}</p> : <div className="confirm-modal__body">{message}</div>)}
        <div className="modal-actions">
          <button ref={cancelRef} className="btn" onClick={() => onSettle(false)}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={() => onSettle(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}

export function useConfirm(): ConfirmFunction {
  const confirm = React.useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used inside ConfirmProvider');
  return confirm;
}
