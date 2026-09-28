import { v4 as uuidv4 } from 'uuid';
import { type Label, type LabelInput, type LabelPatch } from '../../shared/schemas.js';
import { all, one, run, transaction } from './connection.js';
import { canonicalLabelName, cleanInt, cleanText, parseStringArray } from './values.js';

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

export function findLabelByName(name: unknown): Label | null {
  const labelName = canonicalLabelName(name);
  if (!labelName) return null;
  return one<Label>(
    `SELECT ${LABEL_COLUMNS} FROM labels l WHERE l.name = ? COLLATE NOCASE LIMIT 1`,
    [labelName]
  );
}

export function ensureLabel(name: unknown): Label | null {
  const labelName = canonicalLabelName(name);
  if (!labelName) return null;
  return findLabelByName(labelName) ?? createLabel({ name: labelName });
}

export function ensureTemporaryTeamRow(labelId: string): void {
  run('INSERT OR IGNORE INTO temporary_teams (label_id, active, activated_at) VALUES (?, 0, NULL)', [labelId]);
}

export function isActiveTemporaryTeam(labelId: string): boolean {
  return Boolean(one<{ active: number }>('SELECT active FROM temporary_teams WHERE label_id = ?', [labelId])?.active);
}

export function createLabelRecord(input: LabelInput, id: string, now: number): Label {
  const labelName = cleanText(input.name);
  if (!labelName) throw new Error('label name required');
  if (findLabelByName(labelName)) {
    throw new Error('Er bestaat al een label met deze naam');
  }
  const label = {
    id,
    name: labelName,
    color: cleanText(input.color) || DEFAULT_LABEL_COLOR,
    icon: cleanText(input.icon) || labelName.slice(0, 2).toUpperCase(),
    kind: cleanText(input.kind) || 'custom',
    imageUrl: cleanText(input.imageUrl),
    targetLaps: cleanInt(input.targetLaps),
    sortOrder: cleanInt(input.sortOrder),
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
  return createLabelRecord(input, uuidv4(), Date.now());
}

export function updateLabel(id: string, fields: LabelPatch): Label | null {
  const existing = getLabel(id);
  if (!existing) return null;
  if (isActiveTemporaryTeam(id) && fields.kind !== undefined && fields.kind !== TEMPORARY_TEAM_KIND) {
    throw new Error('Een actieve tijdelijke nachtploeg kan niet van type veranderen');
  }

  const next = {
    name: fields.name !== undefined ? cleanText(fields.name) || existing.name : existing.name,
    color: fields.color !== undefined ? cleanText(fields.color) || existing.color : existing.color,
    icon: fields.icon !== undefined ? cleanText(fields.icon) || existing.icon : existing.icon,
    kind: fields.kind !== undefined ? cleanText(fields.kind) || existing.kind : existing.kind,
    imageUrl: fields.imageUrl !== undefined ? cleanText(fields.imageUrl) : existing.imageUrl,
    targetLaps: fields.targetLaps !== undefined ? cleanInt(fields.targetLaps) : existing.targetLaps,
    sortOrder: fields.sortOrder !== undefined ? cleanInt(fields.sortOrder) : existing.sortOrder,
  };
  const conflictingLabel = findLabelByName(next.name);
  if (conflictingLabel && conflictingLabel.id !== id) {
    throw new Error('Er bestaat al een label met deze naam');
  }
  if (next.kind !== existing.kind && isRestoreLabelForActiveTemporaryTeam(id)) {
    throw new Error('Deactiveer de tijdelijke nachtploeg voordat je dit speedteamtype wijzigt');
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
    [
      next.name,
      next.color,
      next.icon,
      next.kind,
      next.imageUrl,
      next.targetLaps,
      next.sortOrder,
      Date.now(),
      id,
    ]
  );

  if (next.kind === TEMPORARY_TEAM_KIND) {
    ensureTemporaryTeamRow(id);
  } else {
    run('DELETE FROM temporary_teams WHERE label_id = ? AND active = 0', [id]);
  }

  return getLabel(id);
}

export function deleteLabel(id: string): boolean {
  if (isActiveTemporaryTeam(id)) throw new Error('Deactiveer deze tijdelijke nachtploeg voor je ze verwijdert');
  if (isRestoreLabelForActiveTemporaryTeam(id)) {
    throw new Error('Deactiveer de tijdelijke nachtploeg voordat je dit speedteamlabel verwijdert');
  }
  return transaction(() => {
    run('DELETE FROM runner_labels WHERE label_id = ?', [id]);
    return run('DELETE FROM labels WHERE id = ?', [id]).changes > 0;
  });
}

function isRestoreLabelForActiveTemporaryTeam(labelId: string): boolean {
  return all<{ restoreJson: string | null }>(
    `SELECT ttm.restore_label_ids_json AS restoreJson
     FROM temporary_team_members ttm
     JOIN temporary_teams tt ON tt.label_id = ttm.team_label_id
     WHERE tt.active = 1
       AND ttm.restore_label_ids_json IS NOT NULL`
  ).some((row) => parseStringArray(row.restoreJson).includes(labelId));
}

export function getRunnerLabelsMap(runnerId?: string): Map<string, Label[]> {
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
  return map;
}

export function getRunnerLabels(runnerId: string): Label[] {
  return getRunnerLabelsMap(runnerId).get(runnerId) ?? [];
}

export function getBaseSpeedteamLabels(runnerId: string): Label[] {
  return getRunnerLabels(runnerId).filter((label) => label.kind === 'speedteam');
}
