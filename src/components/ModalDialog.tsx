import React from 'react';

/** Native modal behavior keeps keyboard focus and pointer actions in the top dialog. */
export function ModalDialog({
  label,
  onRequestClose,
  initialFocusRef,
  children,
}: {
  label: string;
  onRequestClose: () => void;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
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
    >
      {children}
    </dialog>
  );
}
