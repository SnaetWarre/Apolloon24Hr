import React from 'react';
import { useAppActions } from '../../app/index';
import { useConfirm } from '../ConfirmDialog';
import { labelKindTitle } from '../LabelBadge';
import type { Label, Runner, TemporaryTeam } from '../../types';
import { AdminNoticeBanner, useAdminAction } from './AdminNotice';
import { groupLabels } from './adminFormat';
import { LabelAdminRow } from './LabelAdminRow';
import { TemporaryTeamAdminCard } from './TemporaryTeamAdminCard';
import { TemporaryTeamCreateForm } from './TemporaryTeamCreateForm';

export function LabelsSection({
  labels,
  runners,
  temporaryTeams,
}: {
  labels: Label[];
  runners: Runner[];
  temporaryTeams: TemporaryTeam[];
}) {
  const { createTemporaryTeam, setTemporaryTeamMembers, setTemporaryTeamActive, setTemporaryTeamSchedule } =
    useAppActions();
  return (
    <>
      <section className="panel">
        <h2>Tijdelijke nachtploegen</h2>
        <p className="panel-copy">
          Plan wanneer de lopers tijdelijk van hun gewone speedteam naar deze ploeg gaan. Na het einduur keren ze
          automatisch terug.
        </p>
        <TemporaryTeamCreateForm runners={runners} allTeams={temporaryTeams} onCreate={createTemporaryTeam} />
        {temporaryTeams.length ? (
          <div className="temporary-team-list">
            {temporaryTeams.map((team) => {
              const label = labels.find((item) => item.id === team.labelId);
              return label ? (
                <TemporaryTeamAdminCard
                  key={team.labelId}
                  label={label}
                  team={team}
                  allTeams={temporaryTeams}
                  runners={runners}
                  onSaveMembers={setTemporaryTeamMembers}
                  onSetActive={setTemporaryTeamActive}
                  onSetSchedule={setTemporaryTeamSchedule}
                />
              ) : null;
            })}
          </div>
        ) : (
          <div className="empty-inline">Nog geen tijdelijke nachtploegen. Maak hierboven de eerste aan.</div>
        )}
      </section>
      <LabelsPanel labels={labels} />
    </>
  );
}

function LabelsPanel({ labels }: { labels: Label[] }) {
  const confirm = useConfirm();
  const { createLabel, updateLabel, deleteLabel } = useAppActions();
  const { pending, notice, run } = useAdminAction();
  const [name, setName] = React.useState('');
  const [color, setColor] = React.useState('#3b82f6');
  const [kind, setKind] = React.useState('andere');
  const [imageUrl, setImageUrl] = React.useState('');
  const [targetLaps, setTargetLaps] = React.useState('');
  const [sortOrder, setSortOrder] = React.useState('');

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
          imageUrl: imageUrl.trim() || null,
          targetLaps: targetLaps ? Number(targetLaps) : null,
          sortOrder: sortOrder ? Number(sortOrder) : null,
        }),
      `${labelName} is toegevoegd.`,
      'Label toevoegen mislukt'
    );
    if (!created) return;
    setName('');
    setImageUrl('');
    setTargetLaps('');
    setSortOrder('');
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
          value={color}
          onChange={(event) => setColor(event.target.value)}
        />
        <select className="input" value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="speedteam">Speedteam</option>
          <option value="zustervereniging">Zustervereniging</option>
          <option value="andere">Andere</option>
          <option value="custom">Custom</option>
        </select>
        <input
          className="input"
          value={imageUrl}
          onChange={(event) => setImageUrl(event.target.value)}
          placeholder="/labels/logo.png optioneel"
        />
        <input
          className="input input--number"
          type="number"
          min="0"
          value={targetLaps}
          onChange={(event) => setTargetLaps(event.target.value)}
          placeholder="Doel"
        />
        <input
          className="input input--number"
          type="number"
          min="0"
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value)}
          placeholder="Positie"
        />
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
