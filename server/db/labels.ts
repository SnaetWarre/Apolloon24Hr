import { randomUUID } from 'node:crypto';
import { type Label, type LabelInput, type LabelPatch } from '../../shared/schemas.js';
import { all, one, run, transaction } from './connection.js';
import { canonicalLabelName } from './values.js';

export const TEMPORARY_TEAM_KIND = 'temporary_team';

const DEFAULT_LABEL_COLOR = '#3b82f6';

const LABEL_COLUMNS = `
  l.id,
  l.name,
  l.color,
  l.icon,
  l.kind,
  l.image_url AS imageUrl,
  l.target_laps AS targetLaps,
  l.sort_order AS sortOrder,
  l.created_at AS createdAt,
  l.updated_at AS updatedAt`;

const LABEL_ORDER = 'COALESCE(l.sort_order, 9999), l.name';

export function getLabels(): Label[] {
  return all<Label>(`SELECT ${LABEL_COLUMNS} FROM labels l ORDER BY ${LABEL_ORDER}`);
}

function getLabel(id: string): Label | null {
  return one<Label>(`SELECT ${LABEL_COLUMNS} FROM labels l WHERE l.id = ?`, [id]);
}

export function findLabelByName(name: string): Label | null {
  const labelName = canonicalLabelName(name);
  if (!labelName) return null;
  return one<Label>(`SELECT ${LABEL_COLUMNS} FROM labels l WHERE l.name = ? COLLATE NOCASE LIMIT 1`, [labelName]);
}

export function ensureLabel(name: string): Label | null {
  const labelName = canonicalLabelName(name);
  if (!labelName) return null;
  return findLabelByName(labelName) ?? createLabel({ name: labelName });
}

export function ensureTemporaryTeamRow(labelId: string): void {
  run('INSERT OR IGNORE INTO temporary_teams (label_id, active, activated_at) VALUES (?, 0, NULL)', [labelId]);
}

export function createLabelRecord(input: LabelInput, id: string, now: number): Label {
  const labelName = input.name.trim();
  if (!labelName) throw new Error('Een label heeft een naam nodig');
  if (findLabelByName(labelName)) {
    throw new Error('Er bestaat al een label met deze naam');
  }
  const label = {
    id,
    name: labelName,
    color: input.color || DEFAULT_LABEL_COLOR,
    icon: input.icon || labelName.slice(0, 2).toUpperCase(),
    kind: input.kind || 'custom',
    imageUrl: input.imageUrl ?? null,
    targetLaps: input.targetLaps ?? null,
    sortOrder: input.sortOrder ?? null,
  };
  run(
    `INSERT INTO labels (
      id,
      name,
      color,
      icon,
      kind,
      image_url,
      target_laps,
      sort_order,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      label.id,
      label.name,
      label.color,
      label.icon,
      label.kind,
      label.imageUrl,
      label.targetLaps,
      label.sortOrder,
      now,
      now,
    ]
  );
  if (label.kind === TEMPORARY_TEAM_KIND) ensureTemporaryTeamRow(label.id);
  return { ...label, createdAt: now, updatedAt: now };
}

export function createLabel(input: LabelInput): Label {
  return createLabelRecord(input, randomUUID(), Date.now());
}

export function updateLabel(id: string, fields: LabelPatch): Label | null {
  const existing = getLabel(id);
  if (!existing) return null;

  const next = {
    name: fields.name || existing.name,
    color: fields.color || existing.color,
    icon: fields.icon || existing.icon,
    kind: fields.kind || existing.kind,
    imageUrl: fields.imageUrl !== undefined ? fields.imageUrl : existing.imageUrl,
    targetLaps: fields.targetLaps !== undefined ? fields.targetLaps : existing.targetLaps,
    sortOrder: fields.sortOrder !== undefined ? fields.sortOrder : existing.sortOrder,
  };
  const conflictingLabel = findLabelByName(next.name);
  if (conflictingLabel && conflictingLabel.id !== id) {
    throw new Error('Er bestaat al een label met deze naam');
  }

  run(
    `UPDATE labels
     SET name = ?,
         color = ?,
         icon = ?,
         kind = ?,
         image_url = ?,
         target_laps = ?,
         sort_order = ?,
         updated_at = ?
     WHERE id = ?`,
    [next.name, next.color, next.icon, next.kind, next.imageUrl, next.targetLaps, next.sortOrder, Date.now(), id]
  );

  if (next.kind === TEMPORARY_TEAM_KIND) {
    ensureTemporaryTeamRow(id);
  } else {
    run('DELETE FROM temporary_teams WHERE label_id = ?', [id]);
  }

  return getLabel(id);
}

export function deleteLabel(id: string): boolean {
  return transaction(() => {
    run('DELETE FROM runner_labels WHERE label_id = ?', [id]);
    return run('DELETE FROM labels WHERE id = ?', [id]).changes > 0;
  });
}

/**
 * SQL condition, with one `?` for the current time, under which night team `t`
 * replaces its members' speedteam: inside its schedule, or switched on by hand
 * when it has no schedule.
 */
export const TEMPORARY_TEAM_ACTIVE_SQL = `(CASE WHEN t.starts_at IS NULL OR t.ends_at IS NULL
  THEN t.active = 1 ELSE ? BETWEEN t.starts_at AND t.ends_at - 1 END)`;

function activeTemporaryTeamLabels(nowMs: number, runnerId?: string): Array<Label & { runnerId: string }> {
  return all<Label & { runnerId: string }>(
    `SELECT m.runner_id AS runnerId, ${LABEL_COLUMNS}
     FROM temporary_team_members m
     JOIN temporary_teams t ON t.label_id = m.team_label_id
     JOIN labels l ON l.id = t.label_id
     WHERE ${TEMPORARY_TEAM_ACTIVE_SQL} ${runnerId ? 'AND m.runner_id = ?' : ''}`,
    runnerId ? [nowMs, runnerId] : [nowMs]
  );
}

export function activeTemporaryTeamIdForRunner(runnerId: string, nowMs = Date.now()): string | null {
  return activeTemporaryTeamLabels(nowMs, runnerId)[0]?.id ?? null;
}

function compareLabels(a: Label, b: Label): number {
  return (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.name.localeCompare(b.name);
}

/**
 * Each runner's labels at `nowMs`: the stored labels, with the speedteam
 * swapped for the night team while that team is active.
 */
export function getRunnerLabelsMap(runnerId?: string, nowMs = Date.now()): Map<string, Label[]> {
  const rows = all<Label & { runnerId: string }>(
    `SELECT rl.runner_id AS runnerId, ${LABEL_COLUMNS}
     FROM runner_labels rl
     JOIN labels l ON l.id = rl.label_id
     ${runnerId ? 'WHERE rl.runner_id = ?' : ''}
     ORDER BY ${LABEL_ORDER}`,
    runnerId ? [runnerId] : []
  );
  const map = new Map<string, Label[]>();
  for (const { runnerId: owner, ...label } of rows) {
    const labels = map.get(owner);
    if (labels) labels.push(label);
    else map.set(owner, [label]);
  }
  for (const { runnerId: member, ...team } of activeTemporaryTeamLabels(nowMs, runnerId)) {
    const labels = (map.get(member) ?? []).filter((label) => label.kind !== 'speedteam');
    map.set(member, [...labels, team].sort(compareLabels));
  }
  return map;
}

export function getRunnerLabels(runnerId: string, nowMs = Date.now()): Label[] {
  return getRunnerLabelsMap(runnerId, nowMs).get(runnerId) ?? [];
}
