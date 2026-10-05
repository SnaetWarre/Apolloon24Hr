# Backend Architecture

Apolloon's backend is a local Node.js process embedded in every packaged
Electron app. The Electron laptops form one group that chooses a leader by
majority vote; the leader orders every write and the others hold full copies.
Browser-only screens connect to any laptop and keep no database.

## Runtime Topology

```text
Browser / Electron renderer
  |
  | HTTP, tRPC (live revision over WebSocket)
  v
server/index.ts
  |-- server/router.ts -------- validated commands
  |     |
  |     v
  |   server/db.ts ----------- SQLite + replication log
  |
  |-- server/raft.ts ---------- leader election, log replication, majority commit
  |-- server/consensus.ts ----- runs raft.ts on SQLite, peer sockets, and real timers
  |-- server/cluster.ts ------- peer endpoints, joining, forwarding writes, status
  |-- server/discovery.ts ----- UDP announcements: finding laptops on the LAN
  |     |
  |     | WebSocket /api/cluster/peer: appends, votes
  |     | HTTP: /api/cluster/snapshot, /members, /api/time
  |     v
  |   the other Electron laptops
  |
  |-- server/app-state.ts ----- live snapshot and lap history
  |-- server/backups.ts ------- verified point-in-time backups
  |-- server/host.ts ---------- LAN address selection
  |-- server/exports.ts ------- CSV/JSON exports
  `-- server/static-files.ts -- packaged frontend
```

## Process Boundaries

### `electron/main.ts`

- Compiled to `dist-electron/` by `npm run electron:compile`; the Electron
  build scripts run that step first.
- Starts the compiled backend as a child process and passes the app version.
  The backend, frontend build, and dependencies all stay inside `app.asar`;
  Electron's Node mode reads the archive, so nothing is unpacked.
- The packaged smoke test (`scripts/package-smoke.mjs`) checks the database,
  a verified backup (the worker thread), and a precompressed asset.
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
- Announces the data revision over the `live.revision` tRPC subscription after
  every committed change; clients refetch when their revision differs, and get
  only the changes since the revision they hold (`server/deltas.ts`).
- Pushes the laptop status over `live.cluster` when it changes, so screens do
  not poll it.
- Re-announces the revision when a night team starts or stops, since their
  labels follow the clock rather than a write.
- Initializes SQLite before listening and shuts down gracefully.

### `server/router.ts`

- Defines every mutation exposed to the UI, validated with Zod.
- `write()` makes every mutation callable on every laptop. On the leader it
  runs the command through `recordWrite`, so data and log entry commit
  together, and answers once a majority stored the entry. Elsewhere it passes
  the call to the leader (`forwardWrite`) and answers once its own copy has
  the result. While the laptops choose a leader it waits (up to 12 s); when
  the leader fails meanwhile it repeats the call at the next one, and a
  request id stored with the result (`forwarded_writes`) makes the repeat
  apply only once. A laptop that no longer leads refuses forwarded calls
  before running them, so calls never loop.
- Timing commands carry the race state the operator saw; a stale second press
  is refused instead of recording an extra lap.

### `server/db.ts` (facade over `server/db/`)

- `connection.ts`: the single `node:sqlite` connection, statement cache,
  transactions (a nested call becomes a savepoint), write capture, and the
  data revision.
- `sqlite-file.ts`: opens a standalone database file (a backup or a received
  image) and runs `PRAGMA quick_check`; also used by the backup worker.
- `schema.ts`: tables and migrations. Schema 13 dropped the multi-master
  replication tables, moved the queue state onto `runners`, and derives
  night-team labels.
- `replication.ts`: the replication log. `recordWrite` captures the SQL a
  command executes and appends it as one log entry in the same transaction.
  `appendFromLeader` stores a leader's entries after checking that they
  continue this log; `serializeDatabase` and `installDatabaseImage` give a
  joining or diverged laptop a full copy.
- `members.ts`: the group's laptops, a replicated table, so all agree on who
  votes and how many make a majority.
- `forwarded-writes.ts`: results of forwarded writes by request id.
- `settings.ts`: replicated settings (`public_record_mode`) and host-local
  settings (identity, term, vote, clock offset, schema version), which never
  replicate.
- Domain modules: `runners`, `runner-queries`, `queue`, `race-state`, `timing`,
  `labels`, `teams`, `history`, `storage`, `values`.

Application tables:

```text
runners (incl. queue)   labels
runner_labels           race_state
laps                    handoff_history
race_events             temporary_teams
temporary_team_members  settings
cluster_members         forwarded_writes
replication_log
```

### `server/raft.ts` and `server/consensus.ts`

Raft among the laptops in `cluster_members`. `raft.ts` holds the algorithm
and receives its storage, network, clock, timers, and randomness;
`consensus.ts` passes the SQLite log, a WebSocket per other laptop for
appends and votes (`peer-socket.ts`), HTTP for full copies and the clock,
and real timers; the simulation tests pass fakes.

- Terms and this laptop's vote are host-local settings, so a laptop never
  votes twice in a term, also across restarts. Log entries carry the term
  they were written in.
- The leader sends appends every 150 ms; they double as heartbeats. A
  follower that hears nothing for 1.5 to 3 s runs a pre-vote, then an
  election. Votes go only to a laptop whose log is at least as complete
  (last term, then last position).
- A laptop that hears from a live leader refuses votes and names the leader,
  so a laptop returning from a broken cable follows instead of disrupting.
- An entry is committed once a majority stored it; `waitForCommit` lets a
  write answer only then. A leader that cannot reach a majority for one
  election timeout steps down.
- A follower whose log diverged (it holds entries the leader does not), or
  that needs entries the leader no longer keeps (5,000 retained), takes a
  backup and installs a full image from the leader.
- A re-sync is abandoned when the leader it copies from goes quiet or
  another laptop leads, and waits at most 10 s for the copy to start, so a
  laptop never sits out an election waiting for a laptop that lost power.
- Timeouts run on the monotonic clock (`performance.now()`). The wall clock
  may jump when the system corrects it; a laptop whose clock jumped back
  would otherwise refuse to vote for as long as the jump.
- Followers keep their clock offset to the leader (`server/clock.ts`).

### `server/cluster.ts`

- Peer endpoints (`append`, `vote`, `snapshot`, `members`); app and schema
  version must match or the request is refused with HTTP 426 and an
  "Upgrade vereist" message.
- Joining: a laptop asks the leader to add it to `cluster_members`, then
  installs the leader's image and follows it.
- A laptop asking for votes while this one leads is taken (back) into the
  group, for example after "continue alone" or with a new address.
- "Continue alone" (`continueAlone`): only when no majority is reachable, a
  laptop becomes a group of one in a new term.
- Two groups of the same lineage that went on separately find each other
  through remembered and announced addresses; the smaller one re-syncs from
  the larger.
- `clusterStatus` sums it up for the screens: `solo`, `healthy`, `degraded`,
  `electing`, or `no-majority`.
- Tests can cut a laptop off (`CLUSTER_TEST_FAULTS=true` with
  `NODE_ENV=test`).

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
- `server/clock.ts`: the group clock, the leader's time as every laptop
  estimates it; data timestamps and timing use it.
- `server/peers.ts`: requests between laptops and their addresses.
- `server/discovery.ts`: every laptop broadcasts who it is (host, group,
  address, version, leader, group size, runner count) every two seconds on UDP
  45737. Group members use the announced addresses when theirs changed (the
  leader stores them); a laptop on its own lists other groups to join. An
  announcement never joins or changes anything by itself.
- `server/static-files.ts`: packaged frontend, never outside the build root.
- `shared/schemas.ts`: client/server contracts.

## Write Path

```text
UI mutation on any laptop
  -> Zod validation
  -> not the leader: passed on to the leader, answered after this copy has it
  -> race preconditions
  -> SQLite transaction
       -> application table changes
       -> captured SQL appended to replication_log
  -> entry sent to the other laptops
  -> a majority stored it: tRPC response
  -> live.revision on every laptop that stored it
```

## Storage And Durability

- Database: `<DATA_PATH>/data/app.db`, WAL mode, `synchronous = FULL`.
- The replication log keeps the latest 5,000 entries; older gaps re-sync.
- Joining and re-syncing keep a backup of the replaced database.
- Replication is not backup: a wrong action is copied to every laptop too.
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
three laptops forming a group and writing everywhere, the leader dying during
a timed lap, a follower catching up after being off, a laptop cut off from
the others, continuing alone after two laptops fail, finding each other
again after every address changed, exactly-once repeats,
version mismatches, backups, and night teams across a restart.

`npm test` also runs the consensus simulation (`tests/raft-sim.test.ts`), and
`npm run rehearse` puts three real servers through random failures; see
`docs/codebase-map.md`.
