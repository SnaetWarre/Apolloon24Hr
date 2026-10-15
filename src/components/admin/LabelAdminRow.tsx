import React from 'react';
import { LabelBadge } from '../LabelBadge';
import type { Label, LabelPatch, Runner } from '../../types';
import { LabelImagePicker } from './LabelImagePicker';
import { LabelMembers } from './LabelMembers';
import { labelMembers } from '../../lib/labels';

export function LabelAdminRow({
  label,
  runners,
  onSave,
  onDelete,
}: {
  label: Label;
  runners: Runner[];
  onSave: (fields: LabelPatch) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const memberCount = labelMembers(runners, label.id).length;
  const membersId = `label-members-${label.id}`;

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
      <button
        className="btn btn--sm btn--quiet label-admin-row__count"
        aria-expanded={open}
        aria-controls={membersId}
        onClick={() => setOpen((current) => !current)}
      >
        {memberCount} {memberCount === 1 ? 'loper' : 'lopers'}
        <span aria-hidden="true" className="label-admin-row__chevron" />
      </button>
      <div className="label-logo-editor">
        <span className="label-logo-editor__caption">Logo</span>
        <LabelImagePicker imageUrl={label.imageUrl} onChange={saveImage} compact />
      </div>
      <button className="btn btn--sm btn--quiet btn--danger-outline" onClick={onDelete}>
        Verwijder
      </button>
      {error && <span className="warning-inline">{error}</span>}
      {open && (
        <div id={membersId} className="label-admin-row__members">
          <LabelMembers label={label} runners={runners} />
        </div>
      )}
    </div>
  );
}
