import React from 'react';
import { useAppActions } from '../../app/index';
import { useConfirm } from '../ConfirmDialog';
import { labelKindTitle } from '../LabelBadge';
import type { Label, Runner } from '../../types';
import { AdminNoticeBanner, useAdminAction } from './AdminNotice';
import { groupLabels } from '../../lib/labels';
import { LabelAdminRow } from './LabelAdminRow';
import { LabelImagePicker } from './LabelImagePicker';

export function LabelsSection({ labels, runners }: { labels: Label[]; runners: Runner[] }) {
  const confirm = useConfirm();
  const { createLabel, updateLabel, deleteLabel } = useAppActions();
  const { pending, notice, run } = useAdminAction();
  const [name, setName] = React.useState('');
  const [color, setColor] = React.useState('#3b82f6');
  const [kind, setKind] = React.useState('andere');
  const [imageUrl, setImageUrl] = React.useState<string | null>(null);

  async function addLabel() {
    const labelName = name.trim();
    if (!labelName || pending) return;
    const created = await run(
      () =>
        createLabel({
          name: labelName,
          color,
          icon: labelName.slice(0, 2).toUpperCase(),
          kind,
          imageUrl,
        }),
      `${labelName} is toegevoegd.`,
      'Label toevoegen mislukt'
    );
    if (!created) return;
    setName('');
    setImageUrl(null);
  }

  async function removeLabel(label: Label) {
    const confirmed = await confirm({
      title: `Label ${label.name} verwijderen?`,
      message: 'Dit verwijdert het label ook van lopers.',
      confirmLabel: 'Label verwijderen',
      tone: 'danger',
    });
    if (confirmed) await run(() => deleteLabel(label.id), `${label.name} is verwijderd.`, 'Label verwijderen mislukt');
  }

  return (
    <section className="panel">
      <h2>Labels</h2>
      <div className="form-row label-create-row">
        <input
          className="input"
          aria-label="Naam van het nieuwe label"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Nieuw label"
        />
        <input
          className="input input--color"
          type="color"
          aria-label="Kleur van het nieuwe label"
          value={color}
          onChange={(event) => setColor(event.target.value)}
        />
        <select
          className="input"
          aria-label="Soort van het nieuwe label"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          <option value="speedteam">Speedteam</option>
          <option value="zustervereniging">Zustervereniging</option>
          <option value="andere">Andere</option>
          <option value="custom">Custom</option>
        </select>
        <LabelImagePicker imageUrl={imageUrl} onChange={setImageUrl} />
        <button className="btn btn--primary" onClick={() => void addLabel()} disabled={!name.trim() || pending}>
          {pending ? 'Toevoegen...' : 'Label toevoegen'}
        </button>
      </div>

      <AdminNoticeBanner notice={notice} />

      <div className="label-admin-list">
        {groupLabels(labels).map(([labelKind, groupedLabels]) => (
          <section key={labelKind} className="label-admin-group">
            <h3>{labelKindTitle(labelKind)}</h3>
            {groupedLabels.map((label) => (
              <LabelAdminRow
                key={label.id}
                label={label}
                runners={runners}
                onSave={async (fields) => {
                  await updateLabel(label.id, fields);
                }}
                onDelete={() => removeLabel(label)}
              />
            ))}
          </section>
        ))}
      </div>
    </section>
  );
}
