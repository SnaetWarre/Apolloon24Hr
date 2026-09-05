# Backend Architecture

Apolloon's backend is a local Node.js process embedded in every packaged
Electron host. Browser-only operator laptops and displays do not run a backend
or keep a database.

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
  |   server/db.ts ----------- SQLite + operation log
  |
  |-- server/cluster.ts ------- peer lifecycle and sync loop
  |     |
  |     | UDP discovery + HTTP delta exchange
  |     v
  |   another Electron host
  |
  |-- server/app-state.ts ----- cached live and replication snapshots
  |-- server/app-history.ts --- lazy race history
  |-- server/backups.ts ------- verified point-in-time snapshots
  |-- server/realtime.ts ------ typed Socket.IO events
  |-- server/host.ts ---------- LAN address selection
  `-- server/static-files.ts -- packaged frontend
```

## Process Boundaries

### `electron/main.js`

- Starts the compiled backend as an Electron child process.
- Stores configuration and SQLite data under Electron's per-user data path.
- Waits for `/api/host-info` before opening the renderer.
- Stops the child when Electron exits. The backend also exits if the parent IPC
  channel disappears unexpectedly.

### `server/index.ts`

- Owns the Express and HTTP server.
- Mounts tRPC at `/trpc`.
- Exposes state, clock, host information, and export endpoints under `/api`.
- Exposes `/api/health` with database readiness, release identity, uptime, and
  backup warnings; deployments verify the exact new release through this route.
- Hosts Socket.IO and emits the current state revision on connection.
- Serves live state separately from gzip-compressed historical laps/events, so
  ordinary operator screens do not repeatedly transfer the full race history.
- Serves precompressed immutable Vite assets and the uncached HTML shell.
- Initializes SQLite before listening and performs graceful shutdown.
- Starts and stops the backup scheduler with the database lifecycle.

### `server/router.ts`

- Defines every query and mutation exposed to the UI.
- Validates payloads with Zod.
- Adds `_commandId` and `_clientId` metadata to writes.
- Enforces queue and timing preconditions before committing.
- Emits small realtime deltas after successful local writes.

### `server/db.ts`

- Owns the single `better-sqlite3` connection and prepared statement cache.
- Creates and migrates the relational application schema.
- Runs local writes and their replication operation in one SQLite transaction.
- Provides exactly-once command handling.
- Maintains hybrid logical clocks, origin vectors, peer acknowledgements,
  checkpoints, operation history, and conflict records.
- Rebuilds application tables deterministically from the checkpoint and
  canonical operation order when concurrent histories arrive.

Application tables:

```text
runners                 labels
queue_entries           runner_labels
race_state              laps
handoff_history         race_events
temporary_teams         temporary_team_members
settings
```

Replication tables:

```text
replication_operations
replication_peer_progress
replication_conflicts
```

### `server/cluster.ts`

- Keeps the in-memory peer registry and reachability/backoff state.
- Broadcasts signed discovery packets on every physical IPv4 LAN interface.
- Exchanges at most 250 missing operations per peer per sync request.
- Exchanges schema, replication-format, app-version, and release compatibility
  before accepting bootstrap data or replayable SQL. Incompatible hosts are
  rejected with HTTP 426 and remain visibly disconnected in Admin.
- Updates peer vectors only after a valid batch has been accepted.
- Replaces stale peer URLs when a known host moves to another address.
- Keeps a working interface while retaining up to eight recently discovered
  alternatives. On transport loss, tries an alternative without inheriting the
  failed address's retry delay. Cancels obsolete requests before they can alter
  a rediscovered peer or a newly joined cluster.
- Uses the successful request URL for outgoing sync and the incoming source IP
  for IPv4 LAN exchanges, so a peer's preferred interface cannot displace a
  working route. Rejects responses from an unexpected host identity.
- Restarts UDP discovery after socket errors, including a temporary bind failure.
- Keeps every host locally writable; timing conflicts pause only timing.
- Allows planned timing transfer only to a reachable peer whose operation
  vector covers the controller's full vector.
- Delays manual emergency takeover after controller loss, distinguishes a
  caught-up replica from an uncertain one, and never promotes automatically.

### `server/cluster-protocol.ts`

- Canonicalizes and validates operation vectors received from the network.
- Signs UDP discovery envelopes with HMAC-SHA256.
- Rejects modified or foreign discovery packets before a sync request can send
  cluster credentials.
- Provides constant-time secret comparison.

### Supporting modules

- `server/backups.ts`: creates compact online SQLite snapshots, verifies their
  integrity, calculates SHA-256, serializes overlapping manual/scheduled
  requests, applies tiered retention, reports disk capacity, and re-verifies
  downloads.
- `server/app-state.ts`: caches the small live snapshot separately from the full
  replication/export snapshot and refreshes only clock/host metadata per request.
- `server/app-history.ts`: serves cached full, recent, or per-runner history.
- `server/realtime.ts`: isolates database/router code from Socket.IO.
- `server/host.ts`: ranks physical LAN interfaces, calculates directed
  broadcast addresses, and refreshes automatic host selection.
- `server/static-files.ts`: prevents static file paths escaping the build root.
- `shared/schemas.ts`: client/server wire contracts.
- `shared/time.ts`: shared time formatting.

## Write Path

```text
UI mutation
  -> Zod validation
  -> command and race precondition checks
  -> SQLite transaction
       -> application table changes
       -> captured SQL statement list
       -> immutable replication operation
  -> tRPC response
  -> Socket.IO delta
```

Reusing the same command ID with the same payload returns its original result.
Reusing it for another write is rejected.

## Replication Path

```text
signed UDP discovery
  -> peer address registry
  -> authenticated HTTP exchange
  -> validate the complete batch
  -> atomically persist operation records
  -> apply directly, or rebuild in canonical order
  -> acknowledge vectors
  -> emit state revision
```

An invalid batch changes neither application data, the operation log, nor peer
progress. A disconnected host continues writing locally and sends its missing
operations after reconnecting.

## Storage And Durability

- Database: `<DATA_PATH>/data/app.db`
- SQLite mode: WAL
- Production synchronization: `FULL`
- Busy timeout: 5 seconds
- Page cache target: 8 MiB
- WAL journal limit: 16 MiB
- A creator bootstrap creates a recovery SQLite backup before replacement.
- Production hosts create verified backups every five minutes under
  `<DATA_PATH>/backups`, outside application releases.
- Backup retention also has an 8 GiB byte ceiling by default.
- Startup compaction runs only when reclaimable space exceeds both 16 MiB and
  25 percent and no race is active. Admin exposes the same guarded maintenance
  path after creating a verified safety backup.

The operation log is intentionally retained so a laptop that was absent for a
long time can still catch up without a central service.

Replication is not backup: a valid but incorrect action can reach every replica.
See `docs/reliability-model.md` for backup retention, download, restoration, and
timing failover procedures.

## Trust Boundary

The event's physical LAN is the application trust boundary. There is no user
login. Cluster delta exchange is authenticated, and discovery is signed, but
operator APIs and exports are intentionally reachable by devices on that LAN.

## Validation

```text
npm test
npm run check
npm run test:e2e
```

The E2E suite starts real backend processes and covers standalone writes,
two-way sync, five-node convergence, disconnect/restart catch-up, bootstrap
replacement, invalid batch rollback, peer address changes, concurrent edits,
timing conflicts, health/release reporting, verified backup downloads, and
exactly-once commands.

`tests/cluster-network.e2e.test.ts` additionally exercises signed UDP delivery,
address backoff, multiple interfaces, late replies/timeouts, a temporarily
occupied discovery port, IP reuse, and two running databases catching up after
a forwarding endpoint moves between loopback IPs on Linux.
