# Leuven 24h Runner Tracker

Telsysteem for the Apolloon 24 Urenloop. One Electron laptop is the **primary**: it orders every change in its SQLite database. The other Electron laptops (for example the queue desk and the warm-up post) run as **standbys**: each keeps a live copy and can take over, and their own screens work normally because they pass every change on to the primary. TVs and borrowed laptops open any laptop's address in a browser.

## Event Network

Recommended defaults:

```text
Server port: 5173
Event URL:   shown by the app, for example http://<primary-lan-ip>:5173
```

Browser and TV clients use automatic DHCP. Give the primary and standby laptops a fixed address so every screen keeps working after a cable or router restart. With access to the event router, a DHCP reservation does this. Without it, open Beheer › Systeem & herstel on the laptop itself and use **Vast netwerkadres**: it pins the wired adapter to its current address through the operating system's permission prompt (Windows, Linux with NetworkManager, macOS) and switches it back to DHCP after the event. The same panel offers the scripts in `public/event-network/` for manual use.

### Primary and standby

Laptop coupling is enabled in the packaged app. The primary accepts every change and records it in a replication log in the same SQLite transaction. Each standby pulls that log a few times per second and replays it, so it holds a byte-for-byte copy that is at most a fraction of a second behind.

Normal event setup:

```text
1. Plug the Electron laptops into the same wired switch.
2. Start Apolloon on the laptop that should be primary and import the registrations there.
3. Start Apolloon on the second laptop, open Beheer › Systeem & herstel,
   enter the primary's Event URL, and choose "Standby worden".
4. Check Beheer › Voorbereiding: the standby must be reachable and caught up.
5. Open the primary's Event URL on every operator laptop and TV.
```

Becoming a standby replaces that laptop's database with the primary's; a backup of the old database is kept first. A change made on a standby's screen goes to the primary, and the screen shows it as soon as the standby's own copy has it, a few milliseconds later. When the primary cannot be reached, a banner says so and changes wait until it is back or a standby takes over. Browsers remember the other laptops and reopen the same page on another one when theirs disappears; the Electron app always stays on its own laptop.

**Planned switch** (for example to move the primary): on the standby, choose "Deze laptop primair maken". The primary hands over its last changes, becomes a standby of the new primary, and no data is lost.

**Failure of the primary**: on the standby, choose "Deze laptop primair maken" and confirm the emergency takeover once the old primary is really stopped or unplugged. Changes from the last fraction of a second that had not been copied may be missing; check the last laps. Open the new primary's address on the browser laptops; the red connection banner links to it. If the old primary comes back, it notices the newer primary, follows it as a standby, and keeps anything it wrote in the meantime in a backup.

Laptops only couple with the same Apolloon version and database schema; otherwise Admin shows an "Upgrade vereist" error.

Developer overrides:

```text
CLUSTER_ENABLED=true             # enable laptop coupling in development
CLUSTER_SELF_URL=http://host:port  # address announced to other laptops (tests)
```

Admin includes a wedstrijdgereedheid checklist for backup freshness, free disk space, and the standby.

Laptops at the event have no internet time, so their clocks can differ by seconds. Every laptop therefore keeps an offset to the primary's clock (the cluster clock), measured on each sync, and a laptop that takes over keeps using it, so times stay continuous across a switch.

### Recovery backups

Every host creates a verified SQLite backup every five minutes and keeps the latest 48 scheduled backups plus the latest 20 manual and safety backups under `<DATA_PATH>/backups`. Each backup is checked with `quick_check` and `foreign_key_check` off the main thread before it is kept, so checks never delay timing. Admin can create and download a backup immediately. Download one to another laptop or USB storage before the event: the standby protects against a broken laptop, a backup also protects against a wrong action that was copied to the standby.

Screens receive only live state; lap history is loaded separately as full, recent, or per-runner data. Registration answers with contact details are loaded only where an operator needs them (profiles and Beheer).

See `docs/reliability-model.md` for the failover policy, retention rules, recovery procedure, and event-day checklist.

## Tech Stack

- Frontend: React 19, Vite 8, TanStack Router, TanStack Query, TanStack Table, and small Zustand UI state.
- Backend: Express 5 with tRPC on `/trpc`, Socket.IO realtime events, and native SQLite via `better-sqlite3`.
- Packaging: Electron + electron-builder. Production builds compile the backend to `dist-server/` and serve the Vite build from the local server.
- Exports: plain HTTP endpoints under `/api/export/*` for browser downloads and external tools.

In development, Vite serves the frontend on `5173` and proxies `/trpc`, `/api`, and `/socket.io` to the backend on `3000`. `npm run dev` starts both after seeding `.dev-data/`.

For the repository layout, runtime boundaries, and validation commands, see `docs/codebase-map.md`.
For hosting the app directly on the VPS without a laptop tunnel, see `docs/vps-deploy.md`.

## Running The Event

1. Connect the primary and standby laptops to the local router/switch by Ethernet.
2. Start the Electron app on both and couple the standby (see [Primary and standby](#primary-and-standby)).
3. Allow the firewall prompt for port `5173` if Windows asks.
4. Copy the Event URL shown on the primary laptop.
5. On every other laptop, open that Event URL. Do not use `localhost` on client laptops.
6. Choose the role from the start page:
   - Telsysteem 1 - Wachtrij
   - Telsysteem 2 - Timing
   - Buitenscherm
   - Binnenscherm
   - Analyse & Export
   - Admin / Import / Labels

There is no password login. The physical local network is the trust boundary.

## Night Teams

A tijdelijke nachtploeg moves its members from their speedteam to the night team during a planned window. Labels are derived from the schedule: nothing is rewritten, so members are back in their own speedteam as soon as the window ends or the team is removed. Each lap keeps the labels of the moment its runner started.

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
- A lap runs from one press to the next as the timing screen recorded them from the key events, not from when the request reached the server. The lap time is measured on the browser's monotonic clock between the two presses, so network delay, a busy server, and clock corrections never change it.
- Undo Last Handoff restores the previous active/next state and removes the last recorded lap.

There is no automatic 24-hour cutoff in the software.

## Test Seed Data

Development seed commands only use `.dev-data/`. They do not overwrite the normal app database in `data/app.db`.

Useful development checks:

```text
npm run typecheck       Type-check client, server, and tests
npm run lint            Lint with oxlint
npm run format          Format with oxfmt (format:check only reports)
npm run check           Type-check, lint, format check, and build the Vite client
npm run build           Type-check the client, build Vite, and compile the server
npm test                Unit tests
npm run test:e2e        Build, then run real servers (standby, failover, night teams)
npm run test:ui         Browser checks against the build (npx playwright install chromium once)
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

## Building Installers

Installers are written to `release/`. Build each one on its own platform:

```text
npm run electron:build:win     Windows installer (on Windows)
npm run electron:build:linux   Linux AppImage
npm run electron:build:mac     macOS dmg and zip (on macOS)
```

## Exports

The analysis page links to:

```text
/api/export/laps.csv
/api/export/laps.json
/api/export/current-state.json
```

These endpoints are local and can be opened from MATLAB, RStudio, or another laptop on the event LAN.
