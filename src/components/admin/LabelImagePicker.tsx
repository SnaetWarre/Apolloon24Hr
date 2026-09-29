import React from 'react';
import { useAppActions } from '../../app/index';
import { pickImageFile, prepareLabelImage } from '../../lib/labelImage';

/** Picks a logo from disk, scales it down in the browser and stores it on the laptops. */
export function LabelImagePicker({
  imageUrl,
  onChange,
  compact = false,
}: {
  imageUrl: string | null;
  onChange: (imageUrl: string | null) => Promise<void> | void;
  compact?: boolean;
}) {
  const { uploadLabelImage } = useAppActions();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const buttonClass = compact ? 'btn btn--sm' : 'btn';

  async function apply(task: () => Promise<string | null | undefined>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await task();
      if (next !== undefined) await onChange(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Logo kiezen mislukt');
    } finally {
      setBusy(false);
    }
  }

  const choose = () =>
    apply(async () => {
      const file = await pickImageFile();
      if (!file) return undefined;
      return (await uploadLabelImage(await prepareLabelImage(file))).imageUrl;
    });

  return (
    <div className="label-image-picker">
      {imageUrl ? <img src={imageUrl} alt="" className="label-image-picker__preview" /> : null}
      <button type="button" className={buttonClass} onClick={() => void choose()} disabled={busy}>
        {busy ? 'Logo laden...' : imageUrl ? 'Ander logo' : 'Logo kiezen'}
      </button>
      {imageUrl ? (
        <button
          type="button"
          className={`${buttonClass} btn--quiet`}
          onClick={() => void apply(async () => null)}
          disabled={busy}
          aria-label="Logo weghalen"
        >
          Weg
        </button>
      ) : null}
      {error ? <span className="warning-inline">{error}</span> : null}
    </div>
  );
}
