/** Labels list by kind (speedteams first), then alphabetically. */
export function labelKindOrder(kind: string) {
  if (kind === 'speedteam') return 0;
  if (kind === 'temporary_team') return 1;
  if (kind === 'zustervereniging' || kind === 'association') return 2;
  if (kind === 'andere' || kind === 'group') return 3;
  return 4;
}

export function compareLabels(a: { kind: string; name: string }, b: { kind: string; name: string }) {
  return labelKindOrder(a.kind) - labelKindOrder(b.kind) || a.name.localeCompare(b.name, 'nl-BE');
}

/** The same order in SQL, for a labels table aliased `l`. */
export const LABEL_ORDER_SQL = `CASE l.kind
    WHEN 'speedteam' THEN 0
    WHEN 'temporary_team' THEN 1
    WHEN 'zustervereniging' THEN 2
    WHEN 'association' THEN 2
    WHEN 'andere' THEN 3
    WHEN 'group' THEN 3
    ELSE 4
  END, l.name COLLATE NOCASE`;
