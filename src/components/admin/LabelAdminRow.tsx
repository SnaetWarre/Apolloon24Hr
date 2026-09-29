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
  const [target, setTarget] = React.useState(label.targetLaps?.toString() || '');
  const [sortOrder, setSortOrder] = React.useState(label.sortOrder?.toString() || '');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setTarget(label.targetLaps?.toString() || '');
    setSortOrder(label.sortOrder?.toString() || '');
  }, [label.targetLaps, label.sortOrder]);

  async function saveLabelSettings() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        targetLaps: target ? Number(target) : null,
        sortOrder: sortOrder ? Number(sortOrder) : null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Label opslaan mislukt');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="label-admin-row">
      <LabelBadge label={label} />
      <div className="label-target-editor">
        <span className="label-target-editor__caption">Logo</span>
        <LabelImagePicker imageUrl={label.imageUrl} onChange={(imageUrl) => onSave({ imageUrl })} compact />
      </div>
      <label className="label-target-editor">
        <span className="label-target-editor__caption">Doel (rondes)</span>
        <input
          className="input input--number"
          type="number"
          min="0"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder="Auto"
        />
      </label>
      <label className="label-target-editor">
        <span className="label-target-editor__caption">Positie</span>
        <input
          className="input input--number"
          type="number"
          min="0"
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value)}
          placeholder="Auto"
        />
      </label>
      <button className="btn btn--sm" onClick={saveLabelSettings} disabled={saving}>
        {saving ? 'Opslaan...' : 'Opslaan'}
      </button>
      <button className="btn btn--sm btn--quiet btn--danger-outline" onClick={onDelete}>
        Verwijder
      </button>
      {error && <span className="warning-inline">{error}</span>}
    </div>
  );
}
