// No app imports: the schema check builds a reference database from this on its own.

/** Every table and index of the current schema. Safe to run on an existing database. */
export const SCHEMA_SQL = `
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
      status TEXT NOT NULL DEFAULT 'registered' CHECK(status IN ('registered','warming_up','waiting','running','ran')),
      queue_index INTEGER,
      status_since INTEGER,
      hidden_at INTEGER,
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

    CREATE TABLE IF NOT EXISTS label_images (
      id TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      data_base64 TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runner_labels (
      runner_id TEXT NOT NULL,
      label_id TEXT NOT NULL,
      PRIMARY KEY (runner_id, label_id),
      FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE CASCADE,
      FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
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
      FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS temporary_team_members (
      team_label_id TEXT NOT NULL,
      runner_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY (team_label_id, runner_id),
      FOREIGN KEY (team_label_id) REFERENCES temporary_teams(label_id) ON DELETE CASCADE,
      FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      occurred_at INTEGER NOT NULL,
      action TEXT NOT NULL,
      summary TEXT NOT NULL,
      origin TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cluster_members (
      host_id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS forwarded_writes (
      request_id TEXT PRIMARY KEY,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS replication_log (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      epoch INTEGER NOT NULL,
      type TEXT NOT NULL,
      statements_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_laps_runner_finished
      ON laps(runner_id, finished_at DESC, duration_ms);

    CREATE INDEX IF NOT EXISTS idx_laps_finished
      ON laps(finished_at DESC);

    CREATE INDEX IF NOT EXISTS idx_race_events_occurred
      ON race_events(occurred_at DESC, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_activity_log_occurred
      ON activity_log(occurred_at DESC);

    CREATE INDEX IF NOT EXISTS idx_runner_labels_label
      ON runner_labels(label_id, runner_id);
`;

/** Needs the queue columns on `runners`, so it is created after the migrations add them. */
export const RUNNER_QUEUE_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_runners_queue_order ON runners(status, queue_index, status_since)';
