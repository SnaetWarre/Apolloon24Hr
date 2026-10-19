import { createHash, randomUUID } from 'node:crypto';
import { type Label, type LabelImageUpload, type LabelInput, type LabelPatch } from '../../shared/schemas.js';
import { all, one, run, transaction } from './connection.js';
import { canonicalLabelName } from './values.js';
import { clusterNow } from '../clock.js';
import { LABEL_ORDER_SQL } from '../../shared/labelOrder.js';

const DEFAULT_LABEL_COLOR = '#3b82f6';

type DefaultLabel = Required<LabelInput> & { id: string };

export const DEFAULT_LABEL_CREATED_AT = 1_700_000_000_000;

export const DEFAULT_LABELS: DefaultLabel[] = [
  {
    id: '00000000-0000-5000-8000-000000000001',
    name: 'Speedteam White',
    color: '#e5e7eb',
    icon: 'SW',
    kind: 'speedteam',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 10,
  },
  {
    id: '00000000-0000-5000-8000-000000000002',
    name: 'Speedteam Blue',
    color: '#1d4ed8',
    icon: 'SB',
    kind: 'speedteam',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 20,
  },
  {
    id: '00000000-0000-5000-8000-000000000003',
    name: 'HILOK',
    color: '#16a34a',
    icon: 'HI',
    kind: 'zustervereniging',
    imageUrl: '/labels/hilok.png',
    targetLaps: null,
    sortOrder: 30,
  },
  {
    id: '00000000-0000-5000-8000-000000000004',
    name: 'Mesacosa',
    color: '#f97316',
    icon: 'ME',
    kind: 'zustervereniging',
    imageUrl: '/labels/mesacosa.jpg',
    targetLaps: null,
    sortOrder: 40,
  },
  {
    id: '00000000-0000-5000-8000-000000000005',
    name: 'Kinesia',
    color: '#7c3aed',
    icon: 'KI',
    kind: 'zustervereniging',
    imageUrl: '/labels/kinesia.png',
    targetLaps: null,
    sortOrder: 50,
  },
  {
    id: '00000000-0000-5000-8000-000000000006',
    name: '1ste jaar',
    color: '#2563eb',
    icon: '1J',
    kind: 'andere',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 60,
  },
  {
    id: '00000000-0000-5000-8000-000000000007',
    name: 'Anciens',
    color: '#64748b',
    icon: 'AN',
    kind: 'andere',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 70,
  },
  {
    id: '00000000-0000-5000-8000-000000000008',
    name: 'Dames',
    color: '#db2777',
    icon: 'DA',
    kind: 'andere',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 80,
  },
  {
    id: '00000000-0000-5000-8000-000000000009',
    name: '2de bach',
    color: '#0d9488',
    icon: '2B',
    kind: 'andere',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 90,
  },
  {
    id: '00000000-0000-5000-8000-00000000000a',
    name: '3de bach',
    color: '#dc2626',
    icon: '3B',
    kind: 'andere',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 100,
  },
  {
    id: '00000000-0000-5000-8000-00000000000b',
    name: '1ste master',
    color: '#9333ea',
    icon: '1M',
    kind: 'andere',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 110,
  },
  {
    id: '00000000-0000-5000-8000-00000000000c',
    name: '2de master',
    color: '#ea580c',
    icon: '2M',
    kind: 'andere',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 120,
  },
];

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

const LABEL_ORDER = LABEL_ORDER_SQL;

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
  // A built-in label missing here, such as a year label on an older database, gets its own colour.
  const builtIn = DEFAULT_LABELS.find((label) => label.name.toLowerCase() === labelName.toLowerCase());
  return findLabelByName(labelName) ?? createLabel(builtIn ? { ...builtIn, name: labelName } : { name: labelName });
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
  return { ...label, createdAt: now, updatedAt: now };
}

export function createLabel(input: LabelInput): Label {
  return createLabelRecord(input, randomUUID(), clusterNow());
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
    [next.name, next.color, next.icon, next.kind, next.imageUrl, next.targetLaps, next.sortOrder, clusterNow(), id]
  );

  return getLabel(id);
}

export const LABEL_IMAGE_PATH = '/api/label-images/';

/** Stores a logo under a hash of its bytes, so the same file uploaded twice is kept once. */
export function saveLabelImage({ mime, dataBase64 }: LabelImageUpload): string {
  const bytes = Buffer.from(dataBase64, 'base64');
  const id = createHash('sha256').update(mime).update(bytes).digest('hex').slice(0, 32);
  run('INSERT OR IGNORE INTO label_images (id, mime, data_base64, created_at) VALUES (?, ?, ?, ?)', [
    id,
    mime,
    bytes.toString('base64'),
    clusterNow(),
  ]);
  return `${LABEL_IMAGE_PATH}${id}`;
}

export function getLabelImage(id: string): { mime: string; bytes: Buffer } | null {
  const row = one<{ mime: string; dataBase64: string }>(
    'SELECT mime, data_base64 AS dataBase64 FROM label_images WHERE id = ?',
    [id]
  );
  return row ? { mime: row.mime, bytes: Buffer.from(row.dataBase64, 'base64') } : null;
}

export function deleteLabel(id: string): boolean {
  return transaction(() => {
    run('DELETE FROM runner_labels WHERE label_id = ?', [id]);
    return run('DELETE FROM labels WHERE id = ?', [id]).changes > 0;
  });
}

/**
 * Puts a runner in a label. A runner runs for one speedteam, so joining one
 * leaves the other. False when the label or the runner no longer exists.
 */
export function addRunnerToLabel(labelId: string, runnerId: string): boolean {
  return transaction(() => {
    const label = getLabel(labelId);
    if (!label || !one('SELECT 1 FROM runners WHERE id = ?', [runnerId])) return false;
    if (label.kind === 'speedteam') {
      run(
        `DELETE FROM runner_labels
         WHERE runner_id = ? AND label_id IN (SELECT id FROM labels WHERE kind = 'speedteam' AND id != ?)`,
        [runnerId, labelId]
      );
    }
    run('INSERT OR IGNORE INTO runner_labels (runner_id, label_id) VALUES (?, ?)', [runnerId, labelId]);
    return true;
  });
}

export function removeRunnerFromLabel(labelId: string, runnerId: string): void {
  run('DELETE FROM runner_labels WHERE runner_id = ? AND label_id = ?', [runnerId, labelId]);
}

/** Each runner's stored labels. */
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
