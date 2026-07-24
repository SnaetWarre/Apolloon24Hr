# Leuven 24h Runner Tracker

Local-first telsysteem for the Apolloon 24 Urenloop setup. Every laptop running the packaged Electron app has its own complete, writable SQLite database. Browser-only laptops and TV screens connect to one of those Electron laptops through the wired local network.

## Event Network

A single Electron laptop works on its own. With multiple Electron laptops, each one remains usable when the others disconnect and synchronizes its queued operations after reconnecting.

Recommended defaults:

```text
Server port: 5173
Event URL:   shown by the app, for example http://<host-lan-ip>:5173
```

Browser and TV clients can use automatic DHCP. They do not store or replicate the database.

### Local-first laptop cluster

Cluster mode is enabled automatically in the packaged app. Linux, Windows, and macOS Electron builds use the same HTTP and UDP protocol and can participate in the same cluster.

There is no Primary, quorum, promotion, Kubernetes, or external message broker. One, two, three, or more connected Electron laptops are all locally writable. Writes are committed to SQLite together with an idempotent operation record before the UI reports success. Peers exchange only missing operations and replay them in one canonical order, so reconnect order does not decide the final state.

Normal event setup:

```text
1. Plug the Electron laptops into the same wired switch.
2. Start Apolloon on the laptop whose database should be the initial source.
3. Open Admin and note its Event URL and eight-character pairing code.
4. Start Apolloon on each additional laptop.
5. On each additional laptop, open Admin, enter the creator URL and code, and confirm.
6. Wait until the header shows the expected number of synchronized laptops.
7. Open any shown Event URL on browser-only operator and display devices.
```

Joining deliberately replaces the additional laptop's current database with the creator's database. Before replacement, Apolloon stores a timestamped recovery copy beside its local database. After the first pairing, UDP discovery reconnects peers automatically on the local network. Fixed peer URLs remain available for tests and unusual network configurations.

Developer overrides:

```text
CLUSTER_ENABLED=false           # disable cluster behavior
CLUSTER_ENABLED=true            # enable cluster behavior in development
CLUSTER_PEERS=http://host:5173  # optional fixed peer list for tests
CLUSTER_DISCOVERY=false         # disable UDP discovery
```

The header shows reachable copies, changes still waiting for another copy, and sync conflicts. Timing is owned by one Electron laptop. If two isolated laptops both create a timing history, timing pauses after reconnect; an operator chooses the correct laptop in Admin and that history is then synchronized to the others. Queue and registration work remains available on a single surviving laptop.

## Tech Stack

- Frontend: React 19, Vite 8, TanStack Router, TanStack Query, TanStack Table, and small Zustand UI state.
- Backend: Express 5 with tRPC on `/trpc`, Socket.IO realtime events, and native SQLite via `better-sqlite3`.
- Packaging: Electron + electron-builder. Production builds compile the backend to `dist-server/` and serve the Vite build from the local server.
- Exports: plain HTTP endpoints under `/api/export/*` for browser downloads and external tools.

In development, Vite serves the frontend on `5173` and proxies `/trpc`, `/api`, and `/socket.io` to the backend on `3000`. `npm run dev` starts both after seeding `.dev-data/`.

For the repository layout, runtime boundaries, and validation commands, see `docs/codebase-map.md`.
For hosting the app directly on the VPS without a laptop tunnel, see `docs/vps-deploy.md`.

## Running The Event

1. Connect the host laptop to the local router/switch by Ethernet.
2. Start the Electron app on the host laptop.
3. Allow the firewall prompt for port `5173` if Windows asks.
4. Copy the Event URL shown on the host laptop.
5. On every other laptop, open that Event URL. Do not use `localhost` on client laptops.
6. Choose the role from the start page:
   - Telsysteem 1 - Wachtrij
   - Telsysteem 2 - Timing
   - Buitenscherm
   - Binnenscherm
   - Analyse & Export
   - Admin / Import / Labels

There is no password login. The physical local network is the trust boundary.

## Registration Import

Export Google Forms/Sheets data to CSV before the event and import it through `Admin / Import / Labels`.
The import creates the full registration database. Imported runners stay in the `Ingeschreven` state and do not appear on the queue board until Telsysteem 1 activates them for warm-up.

Default label categories:

- Speedteams: `Speedteam White`, `Speedteam Blue`
- Zusterverenigingen: `HILOK`, `Mesacosa`, `Kinesia`
- Andere: `1ste jaar`, `Anciens`, `Dames`

The zustervereniging labels use the logo files in `public/labels/`.

Label progress goals can be adjusted in `Admin / Import / Labels` through the `Doel toeren` field per label. If a label goal is empty, the app automatically uses the sum of the target laps of all runners with that label. The `Positie` field controls the order in which labels appear in progress lists.

Expected CSV columns:

```text
runner_number,name,labels,target_laps,historical_avg,historical_best
```

The importer also reads common Google Forms columns such as `zustervereniging`, `vereniging`, `club`, `team`, `speedteam`, `jaar`, and `groep` as labels.

Notes:

- `runner_number` and `name` are required.
- `labels` can contain comma, semicolon, or pipe separated labels.
- Existing runner numbers are updated instead of duplicated.
- Missing labels are created automatically.
- Re-importing does not reset live statuses such as warm-up, waiting, running, or ran.

Telsysteem 1 has two entry actions:

- `Ingeschrevene zoeken`: find an imported runner and move them to warm-up.
- `Nieuwe loper`: create an onsite runner manually and put them directly in warm-up.

## Timing Flow

Telsysteem 1 controls the waiting queue. Telsysteem 2 uses the spacebar:

- Opening the app does not start the race.
- The first spacebar press starts the race clock and starts the first runner in the waiting queue.
- If no runner is active, spacebar starts the first runner in the waiting queue.
- If a runner is active, spacebar saves that runner's lap and immediately starts the next queued runner.
- Undo Last Handoff restores the previous active/next state and removes the last recorded lap.

There is no automatic 24-hour cutoff in the software.

## Test Seed Data

Development seed commands only use `.dev-data/`. They do not overwrite the normal app database in `data/app.db`.

Useful development checks:

```text
npm run typecheck       Type-check client and server without packaging
npm run check           Type-check everything and build the Vite client
npm run build           Type-check the client, build Vite, and compile the server
```

```text
npm run dev                Clean ready data and start dev app
npm run db:dev:empty       Clean empty dev DB
npm run db:dev:seed        Clean ready-to-start dev DB
npm run db:dev:seed:live   Clean live-race dev DB
npm run db:dev:seed:large  Clean large stress-test dev DB
npm run dev:seeded         Run app against .dev-data
npm run dev:fresh          Seed ready data and start dev app
npm run dev:fresh:live     Seed live data and start dev app
npm run dev:fresh:large    Seed large data and start dev app
```

The seeded scenarios are:

- `empty`: default labels only, with no runners or laps.
- `ready`: 40 runners split across registered, warming up, and waiting. The race has not started yet.
- `live`: 60 runners, an active race, queue data, display data, and lap history.
- `large`: 120 runners and about 250 laps for stress-testing the board, displays, admin page, and analysis page.

The older `npm run seed:test` and `npm run seed:test:live` commands are still available as aliases for the ready and live scenarios.

## Exports

The analysis page links to:

```text
/api/export/laps.csv
/api/export/laps.json
/api/export/current-state.json
```

These endpoints are local and can be opened from MATLAB, RStudio, or another laptop on the event LAN.
