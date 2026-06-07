# Leuven 24h Runner Tracker

Local-first telsysteem for the Apolloon 24 Urenloop setup. One host laptop runs the Electron app and local server. Every other laptop or TV screen connects to that host through a browser on the wired local network.

## Event Network

Only the host laptop needs to be reachable on the local network.

Recommended defaults:

```text
Server port: 5173
Event URL:   shown by the app, for example http://<host-lan-ip>:5173
```

Client laptops and TV laptops can use automatic DHCP. Their IP addresses do not matter because they only connect to the host.

## Tech Stack

- Frontend: React 19, Vite 8, TanStack Router, TanStack Query, TanStack Table, and small Zustand UI state.
- Backend: Express 5 with tRPC on `/trpc`, Socket.IO realtime events, and native SQLite via `better-sqlite3`.
- Packaging: Electron + electron-builder. Production builds compile the backend to `dist-server/` and serve the Vite build from the local server.
- Exports: plain HTTP endpoints under `/api/export/*` for browser downloads and external tools.

In development, Vite serves the frontend on `5173` and proxies `/trpc`, `/api`, and `/socket.io` to the backend on `3000`. `npm run dev` starts both after seeding `.dev-data/`.

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
