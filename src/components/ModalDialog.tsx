import React from 'react';

/** Native modal behavior keeps keyboard focus and pointer actions in the top dialog. */
export function ModalDialog({
  label,
  onRequestClose,
  children,
}: {
  label: string;
  onRequestClose: () => void;
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
    return () => {
      dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);

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
