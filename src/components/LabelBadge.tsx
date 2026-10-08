import type { Label } from '../types';

export function LabelBadge({ label, compact = false }: { label: Label; compact?: boolean }) {
  return (
    <span
      className={`label-pill${compact ? ' label-pill--compact' : ''}`}
      style={{ borderColor: label.color }}
      title={label.name}
    >
      {label.imageUrl ? (
        <img src={label.imageUrl} alt="" className="label-image" />
      ) : (
        <span className="label-dot" style={{ background: label.color }} />
      )}
      <span className="label-pill__name">{label.name}</span>
    </span>
  );
}

export function labelKindTitle(kind: string) {
  if (kind === 'speedteam') return 'Speedteams';
  if (kind === 'temporary_team') return 'Tijdelijke nachtploegen';
  if (kind === 'zustervereniging' || kind === 'association') return 'Zusterverenigingen';
  if (kind === 'andere' || kind === 'group') return 'Andere';
  return 'Custom';
}

export { compareLabels, labelKindOrder } from '../../shared/labelOrder';
