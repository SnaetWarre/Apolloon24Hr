/** Labels list by kind (speedteams first), then alphabetically. */
export function labelKindOrder(kind: string) {
  if (kind === 'speedteam') return 0;
  if (kind === 'zustervereniging' || kind === 'association') return 1;
  if (kind === 'andere' || kind === 'group') return 2;
  return 3;
}

export function compareLabels(a: { kind: string; name: string }, b: { kind: string; name: string }) {
  return labelKindOrder(a.kind) - labelKindOrder(b.kind) || a.name.localeCompare(b.name, 'nl-BE');
}

/** The same order in SQL, for a labels table aliased `l`. */
export const LABEL_ORDER_SQL = `CASE l.kind
    WHEN 'speedteam' THEN 0
    WHEN 'zustervereniging' THEN 1
    WHEN 'association' THEN 1
    WHEN 'andere' THEN 2
    WHEN 'group' THEN 2
    ELSE 3
  END, l.name COLLATE NOCASE`;
