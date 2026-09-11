import { type Label, type LabelInput, type LabelPatch } from '../../shared/schemas.js';
import { all, one, run, transaction } from './connection.js';
import { normalizeName, canonicalLabelName, cleanText, cleanInt, parseStringArray } from './values.js';
import { v4 as uuidv4 } from 'uuid';

export const TEMPORARY_TEAM_KIND = 'temporary_team';

export function getLabels(): Label[] {
  return all<Label>(
    `SELECT
       id,
       name,
       color,
       icon,
       kind,
       image_url AS imageUrl,
       target_laps AS targetLaps,
       sort_order AS sortOrder,
       created_at AS createdAt,
       updated_at AS updatedAt
     FROM labels
     ORDER BY
       COALESCE(sort_order, 9999),
       name`
  );
}

export function findLabelByName(name: unknown): Label | null {
  const normalized = normalizeName(canonicalLabelName(name));
  if (!normalized) return null;
  return one<Label>(
    `SELECT
       id,
       name,
       color,
       icon,
       kind,
       image_url AS imageUrl,
       target_laps AS targetLaps,
       sort_order AS sortOrder,
       created_at AS createdAt,
       updated_at AS updatedAt
     FROM labels
     WHERE name = ? COLLATE NOCASE
     LIMIT 1`,
    [canonicalLabelName(name)]
  );
}

export function ensureLabel(name: unknown, options: Partial<LabelInput> = {}): Label | null {
  const labelName = canonicalLabelName(name);
  if (!labelName) return null;
  const existing = findLabelByName(labelName);
  if (existing) return existing;
  return createLabel({
    name: labelName,
    color: options.color || '#3b82f6',
    icon: options.icon || labelName.slice(0, 2).toUpperCase(),
    kind: options.kind || 'custom',
    imageUrl: options.imageUrl || null,
    targetLaps: options.targetLaps ?? null,
    sortOrder: options.sortOrder ?? null,
  });
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
    color: cleanText(input.color) || '#3b82f6',
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
  if (label.kind === TEMPORARY_TEAM_KIND) {
    run('INSERT OR IGNORE INTO temporary_teams (label_id, active, activated_at) VALUES (?, 0, NULL)', [
      label.id,
    ]);
  }
  return { ...label, createdAt: now, updatedAt: now };
}

export function createLabel(input: LabelInput): Label {
  return createLabelRecord(input, uuidv4(), Date.now());
}

export function updateLabel(id: string, fields: LabelPatch): Label | null {
  const existing = one<{
    name: string;
    color: string;
    icon: string;
    kind: string;
    imageUrl: string | null;
    targetLaps: number | null;
    sortOrder: number | null;
  }>(
    `SELECT
       name,
       color,
       icon,
       kind,
       image_url AS imageUrl,
       target_laps AS targetLaps,
       sort_order AS sortOrder
     FROM labels
     WHERE id = ?`,
    [id]
  );
  if (!existing) return null;
  const temporaryState = one<{ active: number }>('SELECT active FROM temporary_teams WHERE label_id = ?', [id]);
  if (temporaryState?.active && fields.kind !== undefined && fields.kind !== TEMPORARY_TEAM_KIND) {
    throw new Error('Een actieve tijdelijke nachtploeg kan niet van type veranderen');
  }

  const next = {
    name: fields.name !== undefined ? cleanText(fields.name) || existing.name : existing.name,
    color: fields.color !== undefined ? cleanText(fields.color) || existing.color : existing.color,
    icon: fields.icon !== undefined ? cleanText(fields.icon) || existing.icon : existing.icon,
    kind: fields.kind !== undefined ? cleanText(fields.kind) || existing.kind : existing.kind,
    imageUrl: fields.imageUrl !== undefined ? cleanText(fields.imageUrl) || null : existing.imageUrl,
    targetLaps: fields.targetLaps !== undefined ? cleanInt(fields.targetLaps) : existing.targetLaps,
    sortOrder: fields.sortOrder !== undefined ? cleanInt(fields.sortOrder) : existing.sortOrder,
    updatedAt: Date.now(),
  };
  const conflictingLabel = findLabelByName(next.name);
  if (conflictingLabel && conflictingLabel.id !== id) {
    throw new Error('Er bestaat al een label met deze naam');
  }
  if (
    fields.kind !== undefined &&
    next.kind !== existing.kind &&
    isRestoreLabelForActiveTemporaryTeam(id)
  ) {
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
      next.updatedAt,
      id,
    ]
  );

  if (next.kind === TEMPORARY_TEAM_KIND) {
    run('INSERT OR IGNORE INTO temporary_teams (label_id, active, activated_at) VALUES (?, 0, NULL)', [id]);
  } else {
    run('DELETE FROM temporary_teams WHERE label_id = ? AND active = 0', [id]);
  }

  return getLabels().find((label) => label.id === id) ?? null;
}

export function deleteLabel(id: string): boolean {
  const temporaryState = one<{ active: number }>('SELECT active FROM temporary_teams WHERE label_id = ?', [id]);
  if (temporaryState?.active) throw new Error('Deactiveer deze tijdelijke nachtploeg voor je ze verwijdert');
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
    `SELECT
      rl.runner_id AS runnerId,
      l.id,
      l.name,
      l.color,
      l.icon,
      l.kind,
      l.image_url AS imageUrl,
      l.target_laps AS targetLaps,
      l.sort_order AS sortOrder,
      l.created_at AS createdAt,
      l.updated_at AS updatedAt
    FROM runner_labels rl
    JOIN labels l ON l.id = rl.label_id
    ${runnerId ? 'WHERE rl.runner_id = ?' : ''}
    ORDER BY COALESCE(l.sort_order, 9999), l.name`,
    runnerId ? [runnerId] : []
  );
  const map = new Map<string, Label[]>();
  for (const row of rows) {
    if (!map.has(row.runnerId)) map.set(row.runnerId, []);
    map.get(row.runnerId)?.push({
      id: row.id,
      name: row.name,
      color: row.color,
      icon: row.icon,
      kind: row.kind,
      imageUrl: row.imageUrl ?? null,
      targetLaps: row.targetLaps ?? null,
      sortOrder: row.sortOrder ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
  return map;
}

export function getRunnerLabels(runnerId: string): Label[] {
  return getRunnerLabelsMap(runnerId).get(runnerId) ?? [];
}
