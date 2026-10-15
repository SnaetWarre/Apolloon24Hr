import { compareLabels } from '../../shared/labelOrder';
import type { Label, Runner, RunnerRegistration } from '../types';
import { foldSearchText } from './runners';

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
 */
export function toggleRunnerLabel(selectedIds: string[], labelId: string, labels: Label[]): string[] {
  const label = labels.find((item) => item.id === labelId);
  if (!label) return selectedIds;
  if (selectedIds.includes(labelId)) return selectedIds.filter((id) => id !== labelId);
  if (label.kind !== 'speedteam') return [...selectedIds, labelId];
  return [...selectedIds.filter((id) => labels.find((item) => item.id === id)?.kind !== 'speedteam'), labelId];
}

/** Runners in a label, by number, then by name. */
export function labelMembers(runners: Runner[], labelId: string): Runner[] {
  return runners.filter((runner) => runner.labels.some((label) => label.id === labelId)).sort(compareRunners);
}

/**
 * Runners outside the label who match what was typed in its add box: the
 * exact number first, then names that start with it, then any other match.
 */
export function runnersToAdd(runners: Runner[], labelId: string, query: string, limit = 6): Runner[] {
  const q = foldSearchText(query.trim());
  if (!q) return [];
  const rank = (runner: Runner) => {
    if (runner.runnerNumber && foldSearchText(runner.runnerNumber) === q) return 0;
    const name = foldSearchText(runner.name);
    if (name.split(/\s+/).some((word) => word.startsWith(q)) || name.startsWith(q)) return 1;
    return foldSearchText(`${runner.runnerNumber ?? ''} ${runner.name}`).includes(q) ? 2 : null;
  };
  return runners
    .filter((runner) => !runner.labels.some((label) => label.id === labelId))
    .flatMap((runner) => {
      const score = rank(runner);
      return score === null ? [] : [{ runner, score }];
    })
    .sort((a, b) => a.score - b.score || compareRunners(a.runner, b.runner))
    .slice(0, limit)
    .map(({ runner }) => runner);
}

/** What someone typed as study phase when they forgot to tick the matching form box. */
const STUDY_PHASE_HINTS: Record<string, RegExp> = {
  '1ste jaar': /^\s*(1\s*(ste|e)?|eerste)\s*(bach|jaar)/i,
  anciens: /afgestudeerd|alumn|oud-?student|ex-?student/i,
};

/** Runners outside the label whose study phase suggests they belong in it. */
export function suggestedMembers(
  runners: Runner[],
  label: Pick<Label, 'id' | 'name'>,
  registrations: Record<string, RunnerRegistration>
): Runner[] {
  const hint = STUDY_PHASE_HINTS[label.name.trim().toLowerCase()];
  if (!hint) return [];
  return runners
    .filter(
      (runner) =>
        !runner.labels.some((own) => own.id === label.id) && hint.test(registrations[runner.id]?.studyPhase ?? '')
    )
    .sort(compareRunners);
}

function compareRunners(a: Runner, b: Runner): number {
  return (
    (a.runnerNumber || '').localeCompare(b.runnerNumber || '', undefined, { numeric: true }) ||
    a.name.localeCompare(b.name, 'nl-BE')
  );
}
