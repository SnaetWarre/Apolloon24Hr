import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { all, one, run } from './connection.js';
import { createLabelRecord, findLabelByName, LABEL_IMAGE_PATH } from './labels.js';
import { raceProgress } from './race-state.js';
import { canonicalName, findRunnerIdByNumber } from './runners.js';

/*
 * Koppelen before the race: the laptop that joins a group first sends its
 * runners and labels, and the group's leader adds them in one replicated write
 * (`runners.merge` in router.ts). The group keeps everything else: its
 * settings, its logos, its own version of a label or a runner both sides have.
 */

const runnerRowSchema = z.object({
  id: z.string().min(1).max(128),
  runner_number: z.string().max(200).nullable(),
  name: z.string().min(1).max(1_000),
  target_laps: z.number().int().nullable(),
  historical_avg_ms: z.number().int().nullable(),
  historical_best_ms: z.number().int().nullable(),
  registration_source: z.enum(['import', 'manual']),
  notes: z.string().nullable(),
  registration_json: z.string().nullable(),
  created_at: z.number().int(),
});

const labelRowSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(1_000),
  color: z.string().max(100),
  icon: z.string().max(100),
  kind: z.string().max(100),
  image_url: z.string().max(2_048).nullable(),
  target_laps: z.number().int().nullable(),
  sort_order: z.number().int().nullable(),
});

export const mergeDataSchema = z.object({
  /** The laptop the runners come from, for Beheer › Activiteit. */
  from: z.string().max(256),
  runners: z.array(runnerRowSchema).max(100_000),
  labels: z.array(labelRowSchema).max(10_000),
  labelImages: z
    .array(z.object({ id: z.string().min(1).max(128), mime: z.string().max(200), data_base64: z.string() }))
    .max(10_000),
  runnerLabels: z.array(z.object({ runner_id: z.string(), label_id: z.string() })).max(1_000_000),
});

export type MergeData = z.infer<typeof mergeDataSchema>;

/** This laptop's runners and labels, as a group they join takes them in. */
export function exportMergeData(from: string): MergeData {
  const labels = all<MergeData['labels'][number]>(
    'SELECT id, name, color, icon, kind, image_url, target_laps, sort_order FROM labels'
  );
  const imageIds = labels.flatMap((label) => labelImageId(label.image_url) ?? []);
  return {
    from,
    runners: all<MergeData['runners'][number]>(
      `SELECT id, runner_number, name, target_laps, historical_avg_ms, historical_best_ms,
         registration_source, notes, registration_json, created_at
       FROM runners`
    ),
    labels,
    labelImages: imageIds.flatMap(
      (id) =>
        one<MergeData['labelImages'][number]>('SELECT id, mime, data_base64 FROM label_images WHERE id = ?', [id]) ?? []
    ),
    runnerLabels: all<MergeData['runnerLabels'][number]>('SELECT runner_id, label_id FROM runner_labels'),
  };
}

function labelImageId(imageUrl: string | null): string | null {
  return imageUrl?.startsWith(LABEL_IMAGE_PATH) ? imageUrl.slice(LABEL_IMAGE_PATH.length) : null;
}

/**
 * Who a runner is, for merging: the name, e-mail and phone number as typed,
 * ignoring case and the spaces around them, and the spaces, dots and dashes
 * inside a phone number. Two runners are one person only when all three match.
 */
export function personKey(name: string, registrationJson: string | null): string {
  let registration: { email?: unknown; phone?: unknown } = {};
  try {
    registration = registrationJson ? (JSON.parse(registrationJson) as typeof registration) : {};
  } catch {
    // An unreadable registration counts as one without e-mail and phone.
  }
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const email = text(registration.email).trim().toLowerCase();
  const phone = text(registration.phone)
    .replace(/[\s.-]/g, '')
    .toLowerCase();
  return JSON.stringify([canonicalName(name), email, phone]);
}

/**
 * Adds the runners and labels of a laptop that joins this group, inside the
 * leader's write. A label with the same name as one here is that label. A
 * runner with the same name, e-mail and phone as a runner here is that runner,
 * kept as it is here; each runner here stands for at most one runner that
 * comes in. Every other runner is added as registered, with its own number
 * unless a runner here has it. Only before the race.
 */
export function mergeEventData(data: MergeData, now: number): { added: number; same: number; labels: number } {
  if (raceProgress().raceStarted) {
    throw new Error('Op deze laptops is de race al gestart: lopers samenvoegen kan alleen voor de race.');
  }
  const labelIds = new Map<string, string>();
  let labels = 0;
  for (const label of data.labels) {
    const existing = findLabelByName(label.name);
    if (existing) {
      labelIds.set(label.id, existing.id);
      continue;
    }
    const imageId = labelImageId(label.image_url);
    const image = imageId ? data.labelImages.find((candidate) => candidate.id === imageId) : null;
    if (image) {
      run('INSERT OR IGNORE INTO label_images (id, mime, data_base64, created_at) VALUES (?, ?, ?, ?)', [
        image.id,
        image.mime,
        image.data_base64,
        now,
      ]);
    }
    const id = idIsFree('labels', label.id) ? label.id : randomUUID();
    createLabelRecord(
      {
        name: label.name,
        color: label.color,
        icon: label.icon,
        kind: label.kind,
        imageUrl: label.image_url,
        targetLaps: label.target_laps,
        sortOrder: label.sort_order,
      },
      id,
      now
    );
    labelIds.set(label.id, id);
    labels += 1;
  }

  const here = new Map<string, string[]>();
  for (const runner of all<{ id: string; name: string; registration_json: string | null }>(
    'SELECT id, name, registration_json FROM runners'
  )) {
    const key = personKey(runner.name, runner.registration_json);
    here.set(key, [...(here.get(key) ?? []), runner.id]);
  }
  const linksOf = new Map<string, string[]>();
  for (const link of data.runnerLabels)
    linksOf.set(link.runner_id, [...(linksOf.get(link.runner_id) ?? []), link.label_id]);
  let added = 0;
  let same = 0;
  for (const runner of data.runners) {
    if (here.get(personKey(runner.name, runner.registration_json))?.shift()) {
      same += 1;
      continue;
    }
    const id = idIsFree('runners', runner.id) ? runner.id : randomUUID();
    const number = runner.runner_number && !findRunnerIdByNumber(runner.runner_number) ? runner.runner_number : null;
    run(
      `INSERT INTO runners (
        id, runner_number, name, target_laps, historical_avg_ms, historical_best_ms, registration_source,
        notes, registration_json, status, queue_index, status_since, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered', NULL, ?, ?, ?)`,
      [
        id,
        number,
        runner.name,
        runner.target_laps,
        runner.historical_avg_ms,
        runner.historical_best_ms,
        runner.registration_source,
        runner.notes,
        runner.registration_json,
        now,
        runner.created_at,
        now,
      ]
    );
    for (const incomingLabelId of linksOf.get(runner.id) ?? []) {
      const labelId = labelIds.get(incomingLabelId);
      if (labelId) run('INSERT OR IGNORE INTO runner_labels (runner_id, label_id) VALUES (?, ?)', [id, labelId]);
    }
    added += 1;
  }
  return { added, same, labels };
}

function idIsFree(table: 'labels' | 'runners', id: string): boolean {
  return !one(`SELECT 1 FROM ${table} WHERE id = ?`, [id]);
}
