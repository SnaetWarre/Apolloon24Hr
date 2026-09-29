# Backend Architecture

Apolloon's backend is a local Node.js process embedded in every packaged
Electron app. One laptop is the primary and owns every write; browser-only
operator laptops and displays connect to it and keep no database.

## Runtime Topology

```text
Browser / Electron renderer
  |
  | HTTP, tRPC, Socket.IO
  v
server/index.ts
  |-- server/router.ts -------- validated commands
  |     |
  |     v
  |   server/db.ts ----------- SQLite + replication log
  |
  |-- server/cluster.ts ------- primary/standby roles, log pulling, promotion
  |     |
  |     | HTTP: /api/cluster/pull, /snapshot, /handover
  |     v
  |   standby Electron laptop
  |
  |-- server/app-state.ts ----- live snapshot and lap history
  |-- server/backups.ts ------- verified point-in-time backups
  |-- server/host.ts ---------- LAN address selection
  |-- server/exports.ts ------- CSV/JSON exports
  `-- server/static-files.ts -- packaged frontend
```

## Process Boundaries

### `electron/main.js`

- Starts the compiled backend as a child process and passes the app version.
- Restarts the backend with backoff when it stops unexpectedly; open screens
  reconnect on their own.
- Stores configuration and SQLite data under Electron's per-user data path.
- Waits for `/api/host-info` before opening the renderer.
- Stops the child when Electron exits. The backend also exits if the parent IPC
  channel disappears.

### `server/index.ts`

- Owns the Express and HTTP server.
- Mounts tRPC at `/trpc` (validated commands, see `docs/api-contracts.md`).
- Serves the live snapshot (`/api/state`), lap history (`/api/history`), clock,
  host, health, backup download, and export endpoints under `/api`.
- Announces the data revision over Socket.IO after every committed change;
  clients refetch when their revision differs.
- Re-announces the revision when a night team starts or stops, since their
  labels follow the clock rather than a write.
- Initializes SQLite before listening and shuts down gracefully.

### `server/router.ts`

- Defines every mutation exposed to the UI, validated with Zod.
- Refuses writes on a standby with a message that names the primary.
- Runs each write through `recordWrite`, so data and log entry commit together.
- Timing commands carry the race state the operator saw; a stale second press
  is refused instead of recording an extra lap.

### `server/db.ts` (facade over `server/db/`)

- `connection.ts`: the single `better-sqlite3` connection, statement cache,
  write capture, and the data revision.
- `schema.ts`: tables and migrations. Schema 13 dropped the multi-master
  replication tables, moved the queue state onto `runners`, and derives
  night-team labels.
- `replication.ts`: the replication log. `recordWrite` captures the SQL a
  command executes and appends it as one log entry in the same transaction.
  `applyLogEntries` replays entries on a standby; `serializeDatabase` and
  `installDatabaseImage` bootstrap a standby from a full copy.
- `settings.ts`: replicated settings (`public_record_mode`) and host-local
  settings (identity, cluster role, schema version), which never replicate.
- Domain modules: `runners`, `runner-queries`, `queue`, `race-state`, `timing`,
  `labels`, `teams`, `history`, `storage`, `values`.

Application tables:

```text
runners (incl. queue)   labels
runner_labels           race_state
laps                    handoff_history
race_events             temporary_teams
temporary_team_members  settings
replication_log
```

### `server/cluster.ts`

- Keeps this laptop's role (`primary` or `standby`), the primary it follows,
  and the promotion epoch as host-local settings.
- A standby pulls up to 500 log entries at a time and replays them in order.
  A standby that diverged from the primary, or fell behind the retained log
  (5,000 entries), takes a backup and re-installs a full database image.
- Planned promotion: the standby asks the primary to hand over; the primary
  stops writing, returns its last entries, and follows the new primary.
- Emergency promotion: only after the operator confirms; the epoch increases.
- A primary checks the other known laptops; if one is primary with a higher
  epoch, it becomes that laptop's standby and re-syncs. Two primaries with the
  same epoch are reported as a conflict in Admin.
- Peers exchange the app version and schema version on every request; any
  difference is refused with HTTP 426 and an "Upgrade vereist" message.

### Supporting modules

- `server/backups.ts`: online backups every five minutes, verified in a worker
  thread (`server/backup-verify-worker.ts`), with simple count-based retention.
- `server/app-state.ts`: live snapshot and history scopes.
- `server/http-json.ts`: gzip, ETags, and one serialization per revision.
- `server/host.ts`: picks the LAN address other laptops should use.
- `server/net-setup.ts`: pins the wired adapter to a static address and back
  to DHCP through the OS permission prompt. Its `/api/net/*` writes only
  accept requests from the laptop itself.
- `server/env.ts`: data root, app version, release id, and number parsing.
- `server/static-files.ts`: packaged frontend, never outside the build root.
- `shared/schemas.ts`: client/server contracts.

## Write Path

```text
UI mutation
  -> Zod validation
  -> primary check and race preconditions
  -> SQLite transaction
       -> application table changes
       -> captured SQL appended to replication_log
  -> tRPC response
  -> Socket.IO state:revision
  -> standbys pull the new entry
```

## Storage And Durability

- Database: `<DATA_PATH>/data/app.db`, WAL mode, `synchronous = FULL`.
- The replication log keeps the latest 5,000 entries; older gaps re-bootstrap.
- Joining and re-syncing keep a backup of the replaced database.
- Replication is not backup: a wrong action is copied to the standby too.
  See `docs/reliability-model.md`.

## Trust Boundary

The event's physical LAN is the trust boundary. There is no user login, and
the replication endpoints are as open as the operator API. Contact details
from registrations are not part of the live snapshot; only the profile and
Beheer views request them.

## Validation

```text
npm test
npm run check
npm run test:e2e
npm run test:ui
```

The E2E suite starts real backend processes and covers standalone writes,
joining as a standby, catch-up after a restart, planned and emergency
promotion, a returning old primary, version mismatches, backups, and night
teams across a restart.
