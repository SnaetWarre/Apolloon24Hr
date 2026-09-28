import React from 'react';

/** Page-level keyboard shortcuts must stay quiet while a modal owns the keyboard. */
export function isModalDialogOpen(): boolean {
  return document.querySelector('dialog[open]') !== null;
}

/** Native modal behavior keeps keyboard focus and pointer actions in the top dialog. */
export function ModalDialog({
  label,
  onRequestClose,
  initialFocusRef,
  closeOnBackdrop = false,
  children,
}: {
  label: string;
  onRequestClose: () => void;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  closeOnBackdrop?: boolean;
  children: React.ReactNode;
}) {
  const [opener] = React.useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  const dialogRef = React.useRef<HTMLDialogElement>(null);

  React.useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    initialFocusRef?.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [initialFocusRef, opener]);

  return (
    <dialog
      ref={dialogRef}
      className="modal-backdrop"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onRequestClose();
      }}
      onClick={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onRequestClose();
      }}
    >
      {children}
    </dialog>
  );
}
