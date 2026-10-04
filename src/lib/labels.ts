import { compareLabels } from '../../shared/labelOrder';
import type { Label } from '../types';

/** Labels by kind, in display order (speedteams first), for pickers and lists. */
export function groupLabels(labels: Label[]): Array<[string, Label[]]> {
  const grouped = new Map<string, Label[]>();
  for (const label of [...labels].sort(compareLabels)) {
    if (!grouped.has(label.kind)) grouped.set(label.kind, []);
    grouped.get(label.kind)?.push(label);
  }
  return [...grouped.entries()];
}

/**
 * Turns a label on or off for a runner. A runner runs for one speedteam, so
 * picking one drops the other; other labels combine (1ste jaar and Dames).
 * Night teams follow their schedule and cannot be picked by hand.
 */
export function toggleRunnerLabel(selectedIds: string[], labelId: string, labels: Label[]): string[] {
  const label = labels.find((item) => item.id === labelId);
  if (!label || label.kind === 'temporary_team') return selectedIds;
  if (selectedIds.includes(labelId)) return selectedIds.filter((id) => id !== labelId);
  if (label.kind !== 'speedteam') return [...selectedIds, labelId];
  return [...selectedIds.filter((id) => labels.find((item) => item.id === id)?.kind !== 'speedteam'), labelId];
}
