# Reliability, Failover, And Backup Model

Apolloon keeps SQLite as the storage engine on every Electron host. Reliability
comes from separating three concerns that solve different failures:

1. SQLite transactions protect one host from partial local writes.
2. Operation replication keeps independent hosts synchronized.
3. Versioned SQLite backups preserve older recovery points.

A synchronized replica is not a backup. A bad operator action can be validly
replicated to every host; an older point-in-time backup remains recoverable.

## Why This Model

Apolloon's event network may contain only two host-capable laptops and must keep
working without WLAN, internet, PostgreSQL, or another managed service. A safe
automatic leader election needs a majority. With two hosts, a network partition
cannot be distinguished from a failed peer without risking two leaders.

For that reason Apolloon does not automatically promote a timing controller.
The Raft safety model similarly elects a leader only with a majority:
<https://raft.github.io/raft.pdf>.

SQLite's online backup API creates a consistent snapshot while the live source
continues operating:
<https://www.sqlite.org/backup.html>.

## Write And Replication Policy

- Registration, labels, queue changes, and other administrative work remain
  locally writable on every host. Operation IDs make retries exactly-once and
  canonical replay converges after reconnect.
- Timing has exactly one assigned controller in normal operation.
- A planned timing transfer must be initiated on the current controller and can
  target only a reachable peer whose operation vector covers the controller's
  complete vector.
- An emergency takeover is refused while the controller is reachable. After it
  becomes unreachable, a replica that covers the controller's last-known vector
  waits ten seconds before enabling a normal takeover. This cannot prove that a
  failed controller had no final, not-yet-replicated operation.
- When the surviving host cannot prove that it has the controller's last-known
  operation vector, the normal takeover stays disabled. A separate forced path
  appears only after thirty seconds and explicitly warns that recent timing
  actions may be absent. This is an availability escape hatch, not a claim of
  data completeness.
- The emergency confirmation explicitly requires the operator to stop or
  disconnect the former timing app. No software running on the surviving side
  of a partition can fence an isolated laptop by itself.
- If both sides nevertheless record timing, Apolloon pauses timing after
  reconnect and requires the operator to select the correct history.

UDP is discovery only. Signed discovery packets find known cluster members;
authenticated HTTP exchanges carry replication operations.

Every signed discovery, bootstrap, and delta exchange includes the database
schema, replication format, application version, minimum compatible versions,
and release identity. Apolloon rejects incompatible peers before applying SQL
and shows an explicit update-required error in Admin. Update every host before
changing a migration or replication compatibility range.

## Backup Policy

Every production host starts its own backup scheduler. The default interval is
five minutes. A backup is published only after all of these steps succeed:

1. `better-sqlite3` creates a live online backup into a temporary file.
2. A separate read-only connection runs `PRAGMA quick_check` and
   `PRAGMA foreign_key_check`.
3. Apolloon compacts that private copy with `VACUUM`; the live race database is
   never vacuumed by this step.
4. A separate read-only connection repeats both integrity checks.
5. The file is flushed and atomically renamed.
6. Apolloon calculates SHA-256 and stores metadata beside the snapshot.

Published snapshots remain ordinary, directly restorable SQLite files; the
compaction only prevents deleted/free pages from being copied into every
recovery point.

Automatic retention is tiered:

- the 24 newest scheduled snapshots;
- one snapshot per hour for 72 hours;
- one snapshot per day for 30 days;
- the 20 newest manual or safety snapshots.

The retained set is additionally capped at 8 GiB by default. Apolloon removes
the oldest scheduled recovery points first while preserving the newest overall,
scheduled, and manual points. `BACKUP_MAX_TOTAL_BYTES` overrides the ceiling.

Admin exposes the last verified backup, failure state, retained count, free
disk space, next scheduled run, manual backup action, and downloads for both the
latest snapshot and its control manifest. Before sending a snapshot Apolloon
recomputes SHA-256 and repeats the SQLite integrity checks; a changed or corrupt
file is refused. Downloading both files to another laptop or USB storage
provides the off-device copy that a local disk cannot.

Overlapping work is serialized. If a manual backup is requested while the
scheduler is active, the manual request waits and then creates a distinct
snapshot instead of being incorrectly reported as the scheduled snapshot.

Backups live outside application releases:

```text
<DATA_PATH>/backups/*.sqlite
<DATA_PATH>/backups/*.sqlite.json
```

Configuration overrides:

```text
BACKUP_ENABLED=false
BACKUP_INTERVAL_MS=300000
BACKUP_INITIAL_DELAY_MS=10000
BACKUP_MIN_FREE_BYTES=2147483648
BACKUP_MAX_TOTAL_BYTES=8589934592
TIMING_TAKEOVER_GRACE_MS=10000
TIMING_FORCED_TAKEOVER_GRACE_MS=30000
```

SQLite reuses deleted pages but does not normally shrink its file. Admin shows
the physical, used, and reclaimable database sizes. When at least 16 MiB and 25
percent are reclaimable, Apolloon offers guarded compaction. It first creates a
verified safety backup and refuses to run while a race is active. Startup may
perform the same compaction automatically only when the race is inactive.

Replication checkpoints are stored locally as versioned gzip/base64 values.
Bootstrap and synchronization still exchange the normal structured checkpoint,
so compression does not leak into the wire format. Lap history stores only the
label identity and presentation fields needed to render the historical lap;
live label targets, ordering, and edit timestamps are not duplicated per lap.

## Recovery Runbook

Prefer a surviving synchronized host: start a clean additional laptop and join
it through Admin. Use a point-in-time backup when all replicas contain the same
bad change or no live replica remains.

For restoration onto the same host:

1. Stop Apolloon completely.
2. Preserve the complete current `<DATA_PATH>/data/` directory.
3. Verify the selected snapshot with `PRAGMA quick_check` and compare its
   SHA-256 with the adjacent metadata file or download response header.
4. Replace `<DATA_PATH>/data/app.db` with the snapshot and remove stale
   `app.db-wal` and `app.db-shm` files.
5. Restart Apolloon, confirm the runner/lap totals, then create a new manual
   backup before reconnecting peers.

Do not restore another laptop's raw snapshot onto a new host unless its stored
host identity is regenerated. The normal and safer cross-host recovery path is
to join from a surviving host.

## Event-Day Check

Before timing starts:

1. Confirm at least two reachable host replicas in the header.
2. Confirm the header says the data is synchronized and backed up.
3. Download one verified backup to a separate device.
   Download its control manifest beside it.
4. Perform a planned timing transfer once and transfer it back.
5. Confirm both laptops show the same active runner and lap count.
