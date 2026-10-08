import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  DATA_DIR,
  captureWrite,
  getDb,
  iterate,
  markAppDataChanged,
  one,
  runUncaptured,
  transaction,
} from './connection.js';
import { type AppendOutcome, type LogView, canContinueFrom as canContinueFromLog, planAppend } from './append-rules.js';
import { schemaProblems } from './schema-check.js';
import { REPLICATED_SETTING_KEYS, getSetting } from './settings.js';
import { openExistingDatabase, quickCheck } from './sqlite-file.js';
import { type ReplicatedStatement, type ReplicationLogEntry } from './types.js';

/**
 * Entries kept for laptops that fall briefly behind. A laptop that needs an
 * older entry re-syncs from a full database image instead.
 */
const LOG_RETENTION = 5_000;

const MAX_ENTRIES_PER_BATCH = 500;

/*
 * A batch of entries travels to a laptop in one peer message, which may be
 * at most 20 MB (peer-socket.ts). A batch stops at MAX_BATCH_BYTES, well
 * under that, but always holds at least one entry. An entry too large for a
 * message on its own (a restore with many logos) is never sent: the laptop
 * that misses it takes a full copy instead.
 */
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
/** The fields around an entry's statements, generously. */
const ENTRY_OVERHEAD_BYTES = 512;

/** Event tables in foreign-key insert order, plus the log itself. */
const REPLICATED_TABLES = [
  'label_images',
  'labels',
  'runners',
  'runner_labels',
  'race_state',
  'laps',
  'handoff_history',
  'race_events',
  'temporary_teams',
  'temporary_team_members',
  'activity_log',
  'cluster_members',
  'cluster_member_names',
  'forwarded_writes',
  'replication_log',
] as const;

const replicatedStatementSchema = z.object({
  sql: z
    .string()
    .min(1)
    .max(100_000)
    .refine((sql) => /^\s*(insert|update|delete|replace)\b/i.test(sql) && !/\breplication_log\b/i.test(sql), {
      message: 'only application data changes can be replicated',
    }),
  params: z.array(z.union([z.string(), z.number().finite(), z.null()])).max(10_000),
});

export const replicationLogEntrySchema = z.object({
  seq: z.number().int().positive(),
  id: z.string().min(1).max(128),
  epoch: z.number().int().nonnegative(),
  type: z.string().min(1).max(128),
  statements: z.array(replicatedStatementSchema),
  createdAt: z.number().int().nonnegative(),
});

type LogRow = Omit<ReplicationLogEntry, 'statements'> & {
  statementsJson: string;
};

const LOG_SELECT = `SELECT seq, id, epoch, type, statements_json AS statementsJson, created_at AS createdAt
  FROM replication_log`;

function entryFromRow({ statementsJson, ...row }: LogRow): ReplicationLogEntry {
  return {
    ...row,
    statements: JSON.parse(statementsJson) as ReplicatedStatement[],
  };
}

export function getClusterEpoch(): number {
  const epoch = Number(getSetting('cluster_epoch') || 0);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : 0;
}

export type LogHead = { seq: number; id: string | null; epoch: number };

/** The last entry: its position, identity, and the term it was written in. */
export function getLogHead(): LogHead {
  return (
    one<LogHead>('SELECT seq, id, epoch FROM replication_log ORDER BY seq DESC LIMIT 1') ?? {
      seq: 0,
      id: null,
      epoch: 0,
    }
  );
}

export function getLogEntryId(seq: number): string | null {
  return one<{ id: string }>('SELECT id FROM replication_log WHERE seq = ?', [seq])?.id ?? null;
}

/**
 * The entries after `seq`, as many as fit in `maxBytes` but at least one;
 * null when the next entry alone is too large to send to another laptop.
 */
export function getLogEntriesAfter(
  seq: number,
  limit = MAX_ENTRIES_PER_BATCH,
  maxBytes = MAX_BATCH_BYTES
): ReplicationLogEntry[] | null {
  const entries: ReplicationLogEntry[] = [];
  let bytes = 0;
  for (const row of iterate<LogRow>(`${LOG_SELECT} WHERE seq > ? ORDER BY seq LIMIT ?`, [
    seq,
    Math.min(Math.max(1, limit), MAX_ENTRIES_PER_BATCH),
  ])) {
    const size = Buffer.byteLength(row.statementsJson) + ENTRY_OVERHEAD_BYTES;
    if (!entries.length && size > MAX_ENTRY_BYTES) return null;
    if (entries.length && bytes + size > maxBytes) break;
    bytes += size;
    entries.push(entryFromRow(row));
  }
  return entries;
}

/** This log as the append rules see it. */
function sqliteLog(): LogView {
  return {
    headSeq: getLogHead().seq,
    idAt: getLogEntryId,
    oldestSeq: () => one<{ seq: number | null }>('SELECT MIN(seq) AS seq FROM replication_log')?.seq ?? null,
  };
}

/** True when a follower at (`after`, `afterId`) holds a prefix of this log that is still retained. */
export function canContinueFrom(after: number, afterId: string | null): boolean {
  return canContinueFromLog(sqliteLog(), after, afterId);
}

function insertLogEntry(entry: ReplicationLogEntry): void {
  runUncaptured(
    `INSERT INTO replication_log (seq, id, epoch, type, statements_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.seq, entry.id, entry.epoch, entry.type, JSON.stringify(entry.statements), entry.createdAt]
  );
  if (entry.seq % 500 === 0) {
    runUncaptured('DELETE FROM replication_log WHERE seq <= ?', [entry.seq - LOG_RETENTION]);
  }
}

/**
 * Runs a write and appends the SQL it executed to the replication log in the
 * same transaction, so a laptop replaying the log ends up byte-for-byte equal.
 */
export function recordWrite<T>(type: string, action: () => T): T {
  const { result, changed } = transaction(() => {
    const { result, statements } = captureWrite(action);
    if (statements.length) {
      insertLogEntry({
        seq: getLogHead().seq + 1,
        id: crypto.randomUUID(),
        epoch: getClusterEpoch(),
        type,
        statements,
        createdAt: Date.now(),
      });
    }
    return { result, changed: statements.length > 0 };
  });
  if (changed) markAppDataChanged();
  return result;
}

/** Replays the leader's entries, which must continue this log without gaps. */
export function applyLogEntries(entries: ReplicationLogEntry[]): void {
  if (!entries.length) return;
  transaction(() => {
    let expected = getLogHead().seq + 1;
    for (const entry of entries) {
      if (entry.seq !== expected) throw new Error(`replication gap: expected ${expected}, received ${entry.seq}`);
      for (const { sql, params } of entry.statements) runUncaptured(sql, params);
      insertLogEntry(entry);
      expected += 1;
    }
  });
  markAppDataChanged();
}

/** Stores a leader's entries that follow (`prevSeq`, `prevId`); see `planAppend`. */
export function appendFromLeader(
  prevSeq: number,
  prevId: string | null,
  entries: ReplicationLogEntry[]
): AppendOutcome {
  const plan = planAppend(sqliteLog(), prevSeq, prevId, entries);
  if (!plan.ok) return plan;
  applyLogEntries(plan.fresh);
  return { ok: true };
}

/** A consistent copy of the whole database, for a laptop that joins or re-syncs. */
export function serializeDatabase(): Buffer {
  const image = getDb().serialize();
  return Buffer.from(image.buffer, image.byteOffset, image.byteLength);
}

/**
 * Replaces this host's event data and log with the leader's database image.
 * Host-local settings (identity, role) stay; the cluster id is adopted.
 */
export function installDatabaseImage(image: Buffer, expectedSchemaVersion: number): { clusterId: string } {
  const imagePath = path.join(DATA_DIR, `bootstrap-${crypto.randomUUID()}.sqlite`);
  fs.writeFileSync(imagePath, image);
  let clusterId: string;
  try {
    clusterId = inspectImage(imagePath, expectedSchemaVersion);
    const db = getDb();
    db.prepare('ATTACH DATABASE ? AS incoming').run(imagePath);
    try {
      transaction(() => {
        db.exec('PRAGMA defer_foreign_keys = ON');
        for (const table of [...REPLICATED_TABLES].reverse()) runUncaptured(`DELETE FROM main."${table}"`);
        for (const table of REPLICATED_TABLES) {
          const columns = (
            db.prepare(`PRAGMA main.table_info("${table}")`).all() as Array<{
              name: string;
            }>
          )
            .map((column) => `"${column.name}"`)
            .join(', ');
          db.exec(`INSERT INTO main."${table}" (${columns}) SELECT ${columns} FROM incoming."${table}"`);
        }
        const keys = REPLICATED_SETTING_KEYS.map(() => '?').join(', ');
        db.prepare(`DELETE FROM main.settings WHERE key IN (${keys})`).run(...REPLICATED_SETTING_KEYS);
        db.prepare(
          `INSERT INTO main.settings (key, value) SELECT key, value FROM incoming.settings WHERE key IN (${keys})`
        ).run(...REPLICATED_SETTING_KEYS);
        runUncaptured("INSERT OR REPLACE INTO settings(key, value) VALUES('replication_cluster_id', ?)", [clusterId]);
      });
    } finally {
      db.prepare('DETACH DATABASE incoming').run();
    }
  } finally {
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${imagePath}${suffix}`, { force: true });
  }
  markAppDataChanged();
  return { clusterId };
}

function inspectImage(imagePath: string, expectedSchemaVersion: number): string {
  const image = openExistingDatabase(imagePath);
  try {
    image.exec('PRAGMA journal_mode = DELETE');
    const check = quickCheck(image);
    if (check !== 'ok') throw new Error(`De ontvangen database is beschadigd (${check}).`);
    const setting = (key: string) =>
      (image.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    const schemaVersion = Number(setting('schema_version') || 0);
    if (schemaVersion !== expectedSchemaVersion) {
      throw new Error(`De ontvangen database heeft schema ${schemaVersion}, deze laptop ${expectedSchemaVersion}.`);
    }
    // The version alone is not proof: an old table could once be stamped current.
    const problems = schemaProblems(image).filter((problem) => problem.kind === 'table');
    if (problems.length) {
      throw new Error(
        `De ontvangen database heeft niet de verwachte tabellen (${problems.map((problem) => problem.detail).join('; ')}).`
      );
    }
    const clusterId = setting('replication_cluster_id');
    if (!clusterId) throw new Error('De ontvangen database heeft geen cluster-id.');
    return clusterId;
  } finally {
    image.close();
  }
}
