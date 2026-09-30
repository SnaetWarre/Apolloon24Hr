# Leuven 24h Runner Tracker

Telsysteem for the Apolloon 24 Urenloop. Three Electron laptops (timing, the queue desk, and the warm-up post) are linked into one group: each holds the full SQLite database, every laptop's screen can make changes, and when a laptop fails the other two carry on by themselves without losing anything that was confirmed. TVs and borrowed laptops open any laptop's address in a browser.

## Event Network

Recommended defaults:

```text
Server port: 5173
Event URL:   shown by the app, for example http://<laptop-lan-ip>:5173
```

Browser and TV clients use automatic DHCP. The Electron laptops find each other on the network by themselves (UDP broadcast on port 45737), also after their addresses change. Give them a fixed address anyway, so TVs and browser screens keep working after a cable or router restart. With access to the event router, a DHCP reservation does this. Without it, open Beheer › Systeem & herstel on the laptop itself and use **Vast netwerkadres**: it pins the wired adapter to its current address through the operating system's permission prompt (Windows, Linux with NetworkManager, macOS) and switches it back to DHCP after the event. The same panel offers the scripts in `public/event-network/` for manual use.

### Linked laptops

Linking laptops is enabled in the packaged app. The laptops choose one of them by majority vote to put every change in order; it records each change in a replication log in the same SQLite transaction and sends it to the others at once. A change counts as saved once two laptops hold it, so any one laptop can fail without losing a confirmed change. Changes made on another laptop's screen are passed to that laptop automatically, and the screen shows the result a few milliseconds later.

Normal event setup:

```text
1. Plug the three Electron laptops into the same wired switch.
2. Start Apolloon on the first laptop and import the registrations there.
3. On the second and third laptop, open Beheer › Systeem & herstel.
   The first laptop is listed by itself; click "Koppelen" next to it.
4. Check Beheer › Voorbereiding: all three laptops must be reachable.
5. Open any laptop's Event URL on the TVs and other screens.
```

Linking replaces that laptop's database with the group's; a backup of the old database is kept first.

When a laptop dies or loses its cable, the other two notice within a second or two, choose a new leader if needed, and carry on. A timing key press during those seconds waits and then counts with the time of the press. The laptop catches up by itself when it returns. Browsers remember the laptops and reopen the same page on another one when theirs disappears; the Electron app always stays on its own laptop.

With only one laptop left, nothing is saved until a second one is back, because one laptop cannot know whether the others are gone or still working behind a broken cable. If the others are truly gone, Beheer › Systeem offers **Alleen verder werken**. See `docs/reliability-model.md` for the details and a rehearsal checklist.

Laptops only link with the same Apolloon version and database schema; otherwise Admin shows an "Upgrade vereist" error.

Developer overrides:

```text
CLUSTER_ENABLED=true             # enable linking laptops in development
CLUSTER_DISCOVERY=false          # do not announce or listen on UDP 45737
CLUSTER_SELF_URL=http://host:port  # address announced to other laptops (tests)
```

Admin includes a wedstrijdgereedheid checklist for backup freshness, free disk space, and the linked laptops.

Laptops at the event have no internet time, so their clocks can differ by seconds. Every laptop therefore keeps an offset to the leading laptop's clock (the group clock), measured every two seconds, and a laptop that takes over keeps using it, so times stay continuous across a takeover.

### Recovery backups

Every host creates a verified SQLite backup every five minutes and keeps the latest 48 scheduled backups plus the latest 20 manual and safety backups under `<DATA_PATH>/backups`. Each backup is checked with `quick_check` and `foreign_key_check` off the main thread before it is kept, so checks never delay timing. Admin can create and download a backup immediately. Download one to USB storage before the event: the linked laptops protect against a broken laptop, a backup also protects against a wrong action that was copied to every laptop.

Screens receive only live state; lap history is loaded separately as full, recent, or per-runner data. Registration answers with contact details are loaded only where an operator needs them (profiles and Beheer).

See `docs/reliability-model.md` for the failover policy, retention rules, recovery procedure, and event-day checklist.

## Tech Stack

- Frontend: React 19, Vite 8, TanStack Router, TanStack Query, and TanStack Table.
- Backend: Express 5 with tRPC on `/trpc`, Socket.IO realtime events, and SQLite through Node's built-in `node:sqlite`, so there is no native module to rebuild for Electron.
- Packaging: Electron + electron-builder. Production builds compile the backend to `dist-server/` and serve the Vite build from the local server.
- Exports: plain HTTP endpoints under `/api/export/*` for browser downloads and external tools.

In development, Vite serves the frontend on `5173` and proxies `/trpc`, `/api`, and `/socket.io` to the backend on `3000`. `npm run dev` starts both after seeding `.dev-data/`.

For the repository layout, runtime boundaries, and validation commands, see `docs/codebase-map.md`.
For hosting the app directly on the VPS without a laptop tunnel, see `docs/vps-deploy.md`.

## Running The Event

1. Connect the three Electron laptops to the local router/switch by Ethernet.
2. Start the Electron app on all three and link them (see [Linked laptops](#linked-laptops)).
3. Allow the firewall prompt for port `5173` if Windows asks.
4. Copy the Event URL shown on one of the laptops.
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
npm run test:e2e        Build, then run real servers (three laptops, failover, night teams)
npm run test:ui         Browser checks against the build (npx playwright install chromium once)
npm run test:sim        Consensus simulation: thousands of seeded crashes and partitions
npm run rehearse        Three real servers under random failures, then compare the lap logs
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
