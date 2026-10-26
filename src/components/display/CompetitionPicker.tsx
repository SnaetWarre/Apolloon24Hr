import React from 'react';
import type { Label } from '../../types';
import { Icon } from '../Icon';
import { compareLabels, labelKindTitle } from '../LabelBadge';
import { ModalDialog } from '../ModalDialog';
import { competitionKey } from '../../../shared/competitions';

/** Tick the teams of one competition, then add it. */
export function CompetitionPicker({
  labels,
  taken,
  error,
  onCancel,
  onAdd,
}: {
  labels: Label[];
  /** Keys of the competitions already on the screen. */
  taken: Set<string>;
  /** Why the last add failed, for example when no laptop can save it. */
  error: string | null;
  onCancel: () => void;
  onAdd: (teams: Label[]) => void;
}) {
  const [picked, setPicked] = React.useState<string[]>([]);
  const sorted = [...labels].sort(compareLabels);
  const groups = new Map<string, Label[]>();
  for (const label of sorted) {
    const title = labelKindTitle(label.kind);
    groups.set(title, [...(groups.get(title) ?? []), label]);
  }
  const duplicate = taken.has(competitionKey(picked));
  const toggle = (id: string) =>
    setPicked((current) => (current.includes(id) ? current.filter((other) => other !== id) : [...current, id]));

  return (
    <ModalDialog label="Nieuwe competitie" onRequestClose={onCancel} closeOnBackdrop>
      <div className="competition-picker">
        <h2>Nieuwe competitie</h2>
        <p>Kies twee of meer ploegen die tegen elkaar strijden.</p>
        {[...groups.entries()].map(([title, groupLabels]) => (
          <div key={title} className="competition-picker__group" role="group" aria-label={title}>
            <h3>{title}</h3>
            <div className="competition-picker__choices">
              {groupLabels.map((label) => (
                <button
                  key={label.id}
                  type="button"
                  className="competition-picker__choice"
                  style={{ '--team': label.color } as React.CSSProperties}
                  aria-pressed={picked.includes(label.id)}
                  onClick={() => toggle(label.id)}
                >
                  {label.imageUrl ? (
                    <img src={label.imageUrl} alt="" />
                  ) : (
                    <i className="competition__dot" aria-hidden="true" />
                  )}
                  <span>{label.name}</span>
                  <Icon name="check" size={16} className="competition-picker__check" />
                </button>
              ))}
            </div>
          </div>
        ))}
        {error && (
          <p className="competition-picker__error" role="alert">
            {error}
          </p>
        )}
        <div className="competition-picker__actions">
          <button type="button" className="inside-control-button" onClick={onCancel}>
            Annuleer
          </button>
          <button
            type="button"
            className="inside-control-button is-primary"
            disabled={picked.length < 2 || duplicate}
            onClick={() => onAdd(sorted.filter((label) => picked.includes(label.id)))}
          >
            {picked.length < 2
              ? 'Kies minstens 2 ploegen'
              : duplicate
                ? 'Deze competitie staat er al op'
                : `Toevoegen met ${picked.length} ploegen`}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
