import { encode } from 'uqr';
import { ModalDialog } from './ModalDialog';

/**
 * The laptops cannot place calls, so the crew scans this code with any phone
 * camera. The code holds only the `tel:` link, so it needs no network.
 */
export function CallQrDialog({
  name,
  phone,
  href,
  onClose,
}: {
  name: string;
  phone: string;
  href: string;
  onClose: () => void;
}) {
  const { size, data } = encode(href, { border: 4 });
  let path = '';
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    })
  );

  return (
    <ModalDialog label={`${name} bellen`} onRequestClose={onClose} closeOnBackdrop>
      <div className="modal modal--call-qr">
        <div className="modal-header">
          <div>
            <span className="modal-kicker">Bellen</span>
            <h2>{name}</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Sluiten">
            ✕
          </button>
        </div>
        <svg
          className="call-qr__code"
          viewBox={`0 0 ${size} ${size}`}
          shapeRendering="crispEdges"
          role="img"
          aria-label={`QR-code om ${phone} te bellen`}
        >
          <rect width={size} height={size} fill="#fff" />
          <path d={path} fill="#000" />
        </svg>
        <strong className="call-qr__phone">{phone}</strong>
        <p className="call-qr__hint">Scan met de camera van je telefoon en tik op Bellen.</p>
      </div>
    </ModalDialog>
  );
}
