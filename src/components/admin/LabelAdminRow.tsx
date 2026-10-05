import React from 'react';
import { LabelBadge } from '../LabelBadge';
import type { Label, LabelPatch } from '../../types';
import { LabelImagePicker } from './LabelImagePicker';

export function LabelAdminRow({
  label,
  onSave,
  onDelete,
}: {
  label: Label;
  onSave: (fields: LabelPatch) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [error, setError] = React.useState<string | null>(null);

  async function saveImage(imageUrl: string | null) {
    setError(null);
    try {
      await onSave({ imageUrl });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Logo opslaan mislukt');
    }
  }

  return (
    <div className="label-admin-row">
      <LabelBadge label={label} />
      <div className="label-logo-editor">
        <span className="label-logo-editor__caption">Logo</span>
        <LabelImagePicker imageUrl={label.imageUrl} onChange={saveImage} compact />
      </div>
      <button className="btn btn--sm btn--quiet btn--danger-outline" onClick={onDelete}>
        Verwijder
      </button>
      {error && <span className="warning-inline">{error}</span>}
    </div>
  );
}
