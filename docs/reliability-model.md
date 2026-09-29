# Reliability, Failover, And Backup Model

Apolloon keeps SQLite as the storage engine on every Electron laptop.
Reliability comes from three separate mechanisms, each for a different failure:

1. SQLite transactions protect one laptop from partial writes.
2. A standby laptop keeps a live copy, for when the primary laptop fails.
3. Point-in-time backups keep older versions, for when a wrong action was
   copied to every laptop.

## Why This Model

The critical path of the event runs from the wachtrij to the timing: timing
starts whoever the queue put next. Every operator screen therefore has to see
the same queue, which is simplest when one laptop owns all writes. Operator
laptops and TVs are browsers on the same wired network as that laptop; if
the network itself fails, no design keeps the stations talking to each other.

So Apolloon uses one primary and one or more standbys rather than laptops
that all accept writes and merge later. A standby replays exactly what the
primary committed, in the same order, so the two can never disagree about
the queue or the laps. There is no automatic failover: with two laptops a
broken cable and a dead laptop look the same, so an operator decides.

## Primary And Standby

- The primary writes every change and its replication log entry in one
  SQLite transaction.
- Each standby pulls new entries about four times per second and replays them.
  A standby's data is at most a fraction of a second behind.
- A standby is read-only. Its screens show live data with a banner that
  names the primary.
- A standby whose log no longer matches the primary (after a failover), or
  that is further behind than the retained 5,000 entries, backs up its
  database and installs a full copy from the primary.
- Laptops only couple when app version and database schema are identical.

## Promotion

**Planned** (primary still reachable), from Beheer on the standby:

1. The standby asks the primary to hand over.
2. The primary stops accepting writes and returns the entries the standby
   does not have yet.
3. The standby applies them and becomes primary with a higher epoch.
4. The old primary becomes a standby of the new one. Nothing is lost.

**Emergency** (primary unreachable):

1. The operator confirms that the old primary is stopped or unplugged.
2. The standby becomes primary with a higher epoch.
3. Changes the old primary committed but the standby had not pulled yet
   (the last fraction of a second) are missing from the live data. Check the
   last laps on the timing screen.

If the old primary comes back, it sees a laptop with a higher epoch, becomes
its standby, and re-syncs. Whatever it wrote after the failover is replaced,
but stays in the `pre-standby-resync` backup it takes first.

No software on one side of a broken cable can stop the other side. If both
laptops keep working as primary with the same epoch, Admin reports two
primaries; re-join one as a standby.

Browser laptops keep the address they opened. After a failover, open the new
primary's address; the red connection banner links to the other laptops this
browser knows about.

### Laptop addresses

Standbys and browsers reach the primary by its IP address. Give the primary a
fixed address, preferably with a DHCP reservation on the event router. The
scripts in `docs/event-network/` pin a wired adapter to a static address on
Windows, Linux, and macOS when no router configuration is possible.

## Backup Policy

Every laptop runs its own backup scheduler, every five minutes by default. A
backup is kept only after all of these steps succeed:

1. `better-sqlite3` creates an online backup into a temporary file.
2. A worker thread converts it to a single rollback-journal file and runs
   `PRAGMA quick_check` and `PRAGMA foreign_key_check`, so the checks never
   delay a timing request.
3. The file is flushed and atomically renamed.

Retention keeps the 48 newest scheduled backups (four hours at the default
interval) and the 20 newest manual and safety backups (taken before joining
or re-syncing). Admin shows the last backup, failures, free disk space, and
offers a backup download.

```text
<DATA_PATH>/backups/apolloon-<time>-<reason>-<id>.sqlite
```

Configuration overrides:

```text
BACKUP_ENABLED=false
BACKUP_INTERVAL_MS=300000
BACKUP_INITIAL_DELAY_MS=10000
BACKUP_MIN_FREE_BYTES=2147483648
```

## Recovery Runbook

Prefer the standby: promote it in Beheer. Use a point-in-time backup when the
standby holds the same wrong change or no laptop survives.

Restoring a backup on a laptop:

1. Stop Apolloon completely.
2. Preserve the complete current `<DATA_PATH>/data/` directory.
3. Check the chosen backup with `PRAGMA quick_check`.
4. Replace `<DATA_PATH>/data/app.db` with the backup and remove any
   `app.db-wal` and `app.db-shm` files.
5. Restart Apolloon, check the runners and laps, then create a manual backup.
6. Re-join any other laptop as a standby of this one.

## Event-Day Check

Before timing starts:

1. Beheer › Voorbereiding shows the standby as reachable and caught up.
2. The last backup is recent; download one to a separate device.
3. The clocks of the laptops differ by less than two seconds.
4. Do a planned switch to the standby and back, and check both show the same
   active runner and lap count.
