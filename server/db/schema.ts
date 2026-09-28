import { type LabelInput } from '../../shared/schemas.js';
import {
  LEGACY_REPLICATION_CHECKPOINT_KEY,
  REPLICATION_CHECKPOINT_KEY,
  compactStoredLapLabels,
  decodeReplicationCheckpoint,
  storeReplicationCheckpoint,
} from './checkpoint.js';
import { all, getDb, one, run } from './connection.js';
import { createLabelRecord, findLabelByName, getRunnerLabelsMap } from './labels.js';
import { deleteLocalSetting, getSetting, setLocalSetting } from './settings.js';

export const DATABASE_SCHEMA_VERSION = 12;

type DefaultLabel = Required<LabelInput> & { id: string };

const DEFAULT_LABEL_CREATED_AT = 1_700_000_000_000;

const DEFAULT_LABELS: DefaultLabel[] = [
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
];

export function createSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runners (
      id TEXT PRIMARY KEY,
      runner_number TEXT UNIQUE,
      name TEXT NOT NULL,
      target_laps INTEGER,
      historical_avg_ms INTEGER,
      historical_best_ms INTEGER,
      registration_source TEXT NOT NULL DEFAULT 'manual' CHECK(registration_source IN ('import','manual')),
      notes TEXT DEFAULT '',
      registration_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL,
      icon TEXT NOT NULL,
      kind TEXT NOT NULL,
      image_url TEXT,
      target_laps INTEGER,
      sort_order INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runner_labels (
      runner_id TEXT NOT NULL,
      label_id TEXT NOT NULL,
      PRIMARY KEY (runner_id, label_id),
      FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE CASCADE,
      FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS queue_entries (
      runner_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('registered','warming_up','waiting','running','ran')),
      queue_index INTEGER,
      status_since INTEGER,
      hidden_at INTEGER,
      FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS race_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      active_runner_id TEXT,
      active_started_at INTEGER,
      race_started_at INTEGER,
      race_finished_at INTEGER,
      active_labels_json TEXT,
      FOREIGN KEY (active_runner_id) REFERENCES runners(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS laps (
      id TEXT PRIMARY KEY,
      runner_id TEXT NOT NULL,
      lap_number INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      labels_json TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS handoff_history (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      undone INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS race_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('burgie_gepakt')),
      message TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      runner_id TEXT,
      runner_number TEXT,
      runner_name TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS temporary_teams (
      label_id TEXT PRIMARY KEY,
      active INTEGER NOT NULL DEFAULT 0,
      activated_at INTEGER,
      starts_at INTEGER,
      ends_at INTEGER,
      schedule_owner_host_id TEXT,
      FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS temporary_team_members (
      team_label_id TEXT NOT NULL,
      runner_id TEXT NOT NULL UNIQUE,
      restore_label_ids_json TEXT,
      PRIMARY KEY (team_label_id, runner_id),
      FOREIGN KEY (team_label_id) REFERENCES temporary_teams(label_id) ON DELETE CASCADE,
      FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS replication_operations (
      id TEXT PRIMARY KEY,
      cluster_id TEXT NOT NULL,
      origin_host_id TEXT NOT NULL,
      origin_seq INTEGER NOT NULL,
      hlc_wall_ms INTEGER NOT NULL,
      hlc_counter INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      statements_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      race_base_key TEXT,
      status TEXT NOT NULL CHECK(status IN ('accepted','conflict','rejected')),
      checksum TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      applied_at INTEGER NOT NULL,
      UNIQUE(origin_host_id, origin_seq)
    );

    CREATE INDEX IF NOT EXISTS idx_replication_operations_order
      ON replication_operations(hlc_wall_ms, hlc_counter, origin_host_id, origin_seq);

    CREATE INDEX IF NOT EXISTS idx_replication_operations_race_base
      ON replication_operations(race_base_key)
      WHERE race_base_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS replication_peer_progress (
      peer_host_id TEXT NOT NULL,
      origin_host_id TEXT NOT NULL,
      acknowledged_seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(peer_host_id, origin_host_id)
    );

    CREATE TABLE IF NOT EXISTS replication_conflicts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      operation_ids_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','resolved')),
      resolution_operation_id TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_laps_runner_finished
      ON laps(runner_id, finished_at DESC);

    CREATE INDEX IF NOT EXISTS idx_laps_finished
      ON laps(finished_at DESC);

    CREATE INDEX IF NOT EXISTS idx_queue_status_order
      ON queue_entries(status, queue_index, status_since);

    CREATE INDEX IF NOT EXISTS idx_race_events_occurred
      ON race_events(occurred_at DESC, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_runner_labels_label
      ON runner_labels(label_id, runner_id);
  `);

  run(
    `INSERT OR IGNORE INTO race_state (
      id,
      active_runner_id,
      active_started_at,
      race_started_at,
      race_finished_at
    ) VALUES (1, NULL, NULL, NULL, NULL)`
  );
}

function tableHasColumn(table: string, column: string): boolean {
  return all<{ name: string }>(`PRAGMA table_info(${table})`).some((row) => row.name === column);
}

export function migrateSchema(): void {
  const previousVersion = Number(getSetting('schema_version') || 0);
  if (!tableHasColumn('runners', 'registration_json')) {
    run('ALTER TABLE runners ADD COLUMN registration_json TEXT');
  }
  if (!tableHasColumn('race_state', 'active_labels_json')) {
    run('ALTER TABLE race_state ADD COLUMN active_labels_json TEXT');
  }
  if (!tableHasColumn('laps', 'labels_json')) {
    run("ALTER TABLE laps ADD COLUMN labels_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!tableHasColumn('temporary_teams', 'starts_at')) {
    run('ALTER TABLE temporary_teams ADD COLUMN starts_at INTEGER');
  }
  if (!tableHasColumn('temporary_teams', 'ends_at')) {
    run('ALTER TABLE temporary_teams ADD COLUMN ends_at INTEGER');
  }
  if (!tableHasColumn('temporary_teams', 'schedule_owner_host_id')) {
    run('ALTER TABLE temporary_teams ADD COLUMN schedule_owner_host_id TEXT');
  }

  if (previousVersion < 5) {
    const labelsByRunner = getRunnerLabelsMap();
    for (const lap of all<{ id: string; runnerId: string }>('SELECT id, runner_id AS runnerId FROM laps')) {
      run('UPDATE laps SET labels_json = ? WHERE id = ?', [
        JSON.stringify(labelsByRunner.get(lap.runnerId) ?? []),
        lap.id,
      ]);
    }
    const active = one<{ runnerId: string | null }>(
      'SELECT active_runner_id AS runnerId FROM race_state WHERE id = 1'
    );
    if (active?.runnerId) {
      run('UPDATE race_state SET active_labels_json = ? WHERE id = 1', [
        JSON.stringify(labelsByRunner.get(active.runnerId) ?? []),
      ]);
    }
  }
  if (previousVersion < 6) {
    run('DROP INDEX IF EXISTS idx_laps_runner_finished');
    run(
      `CREATE INDEX idx_laps_runner_finished
       ON laps(runner_id, finished_at DESC, duration_ms)`
    );
  }
  if (previousVersion < 8) {
    // `cluster_operations` belonged to the retired leader/log replication design.
    // Local-first replication has used `replication_operations` since schema 7.
    run('DROP TABLE IF EXISTS cluster_operations');
  }
  if (previousVersion < 9) {
    compactStoredLapLabels();

    const storedCheckpoint =
      getSetting(REPLICATION_CHECKPOINT_KEY) || getSetting(LEGACY_REPLICATION_CHECKPOINT_KEY);
    if (storedCheckpoint) {
      storeReplicationCheckpoint(decodeReplicationCheckpoint(storedCheckpoint));
    }
    deleteLocalSetting(LEGACY_REPLICATION_CHECKPOINT_KEY);
  }
  setLocalSetting('schema_version', String(DATABASE_SCHEMA_VERSION));
  getDb().pragma(`user_version = ${DATABASE_SCHEMA_VERSION}`);
}

export function seedDefaultLabels(): void {
  for (const label of DEFAULT_LABELS) {
    const existing = findLabelByName(label.name);
    if (existing) {
      run(
        `UPDATE labels
         SET color = ?,
             icon = ?,
             kind = ?,
             image_url = ?,
             target_laps = COALESCE(target_laps, ?),
             sort_order = COALESCE(sort_order, ?)
         WHERE id = ?`,
        [label.color, label.icon, label.kind, label.imageUrl, label.targetLaps, label.sortOrder, existing.id]
      );
      continue;
    }
    createLabelRecord(label, label.id, DEFAULT_LABEL_CREATED_AT);
  }
}
