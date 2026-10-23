import { groupLabels } from '../../lib/labels';
import type { Label } from '../../types';
import { labelKindTitle } from '../LabelBadge';

export function LabelTogglePicker({
  labels,
  enabledLabelIds,
  onToggle,
}: {
  labels: Label[];
  enabledLabelIds: string[];
  onToggle: (labelId: string) => void;
}) {
  const enabled = new Set(enabledLabelIds);
  return (
    <div className="label-toggle-groups">
      {groupLabels(labels).map(([kind, groupedLabels]) => (
        <section key={kind} className="label-toggle-group">
          <h3>{labelKindTitle(kind)}</h3>
          <div className="label-toggle-list">
            {groupedLabels.map((label) => {
              const checked = enabled.has(label.id);
              return (
                <button
                  key={label.id}
                  className={`label-toggle-row${checked ? ' is-on' : ''}`}
                  onClick={() => onToggle(label.id)}
                  aria-pressed={checked}
                >
                  <span className="label-toggle-name">
                    {label.imageUrl ? (
                      <img src={label.imageUrl} alt="" className="label-image" />
                    ) : (
                      <i className="label-dot" style={{ background: label.color }} />
                    )}
                    {label.name}
                  </span>
                  <span className="label-switch">
                    <i />
                  </span>
                  <strong>{checked ? 'Aan' : 'Uit'}</strong>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
