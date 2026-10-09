# Apolloon Telsysteem

Lap counting for the Apolloon 24 Urenloop. Three Electron laptops (timing, the queue desk, and the warm-up post) are linked into one group: each holds the full SQLite database, every laptop's screen can make changes, and when a laptop fails the other two carry on by themselves without losing anything that was confirmed. TVs and borrowed laptops open any laptop's address in a browser.

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
3. Start Apolloon on the second and third laptop. While they hold no runners,
   they link with the first laptop by themselves within a few seconds.
4. Check Beheer › Voorbereiding: all three laptops must be reachable.
5. Open any laptop's Event URL on the TVs and other screens.
```

A laptop whose group holds no runners links by itself with the other laptops it finds on the network: with the group that holds runners, or with another empty laptop (then the registrations can be imported on any of them). A laptop or group that holds runners never links by itself. An empty laptop that finds two groups with runners does not guess; it says so and waits for someone to press Koppelen. Beheer › Systeem & herstel and the overview show "Automatisch gekoppeld met LAPTOP-TIJD, 3 minuten geleden" on the laptop that linked by itself, and "LAPTOP-X is automatisch bijgekomen" on the others.

Koppelen still works by hand: open Beheer › Systeem & herstel, where the other laptops are listed under their computer names. It works from either laptop. A laptop where the race does not run takes the data of one where it runs (started and not finished), whatever the runner counts, so a spare with the registration list, or with a practice race that was finished, takes the running race instead of replacing it. Then a laptop where the race has not started takes the data of one where it has. Otherwise the side with fewer runners takes the other's data, so pressing it on the laptop with the registrations brings an empty laptop over instead of emptying the registrations. The laptop that takes the data keeps a backup of its old database first.

When a laptop dies or loses its cable, the other two notice within a second or two, choose a new leader if needed, and carry on. A timing key press during those seconds waits and then counts with the time of the press. The laptop catches up by itself when it returns. Browsers remember the laptops and reopen the same page on another one when theirs disappears; the Electron app always stays on its own laptop.

With only one laptop left, nothing is saved until a second one is back, because one laptop cannot know whether the others are gone or still working behind a broken cable. If the others are truly gone, Beheer › Systeem offers **Alleen verder werken**.

A laptop that is gone for good still counts as one of the group, so linking a spare next to it makes four laptops that need three for a majority: the next failure would stop all saving. Once a laptop has not answered for 30 seconds, Beheer › Systeem shows **Uit de groep halen** next to it. Click it first, then link the spare, and the group is three laptops again. A spare that already holds runners, or a finished practice race, takes the group's race; press Koppelen on the spare. A laptop taken out is not taken back in by itself; if it works again, click **Opnieuw koppelen** on it. See `docs/reliability-model.md` for the details and a rehearsal checklist.

Laptops only link with the same Apolloon version and database schema; otherwise Beheer shows an "Upgrade vereist" error.

Developer overrides:

```text
CLUSTER_ENABLED=true             # enable linking laptops in development
CLUSTER_DISCOVERY=false          # do not announce or listen on UDP 45737
CLUSTER_SELF_URL=http://host:port  # address announced to other laptops (tests)
CLUSTER_LAPTOP_NAME=LAPTOP-TIJD   # name shown to other laptops instead of the computer name (tests)
CLUSTER_AUTO_LINK=false          # empty laptops wait for Koppelen instead of linking by themselves
CLUSTER_REMOVABLE_AFTER_MS=30000 # how long a laptop is silent before "Uit de groep halen" is offered
```

Beheer › Voorbereiding has a wedstrijdgereedheid checklist for backup freshness, free disk space, and the linked laptops.

Laptops at the event have no internet time, so their clocks can differ by seconds. Every laptop therefore keeps an offset to the leading laptop's clock (the group clock), measured every two seconds, and a laptop that takes over keeps using it, so times stay continuous across a takeover.

### Recovery backups

Every host creates a verified SQLite backup every five minutes and keeps the latest 48 scheduled backups plus the latest 20 manual and safety backups under `<DATA_PATH>/backups`. Each backup is checked with `quick_check` and `foreign_key_check` off the main thread before it is kept, so checks never delay timing. Beheer › Systeem & herstel can create and download a backup immediately. Download one to USB storage before the event: the linked laptops protect against a broken laptop, a backup also protects against a wrong action that was copied to every laptop.

**Backup terugzetten** in the same section puts every linked laptop back to one of this laptop's backups at once. The leader first keeps the current group state as a verified `pre-restore` backup; the result tells you which laptop holds it so you can undo the restore there. Beheer › Activiteit lists every change with the screen and address it came from, on every laptop, so the moment before a mistake is easy to find.

### First start

The desktop app shows a small window as soon as it is opened, while the local server opens the database. If it cannot start, it says why in Dutch (port already in use, disk full, damaged database, …) and offers **Opnieuw proberen** and **Logmap openen**.

A laptop without runners opens on a welcome screen with the two ways to begin: import the registrations on this laptop, or link to a laptop the app found on the network. Linking happens by itself; the screen says with which laptop, or why it waits. It goes away by itself once the laptop has runners.

### Desktop app on race day

While the race runs, the desktop app keeps the screen on and the laptop awake, and asks before it closes: a closed or sleeping laptop drops out of the group. A page that crashes or freezes for ten seconds is reloaded by itself, and every screen shows a recovery screen instead of going blank; the error goes to `server.log` in the app data folder. The window reopens where it was.

Screens receive only live state; lap history is loaded separately as full, recent, or per-runner data. Registration answers with contact details are loaded only where an operator needs them (profiles and Beheer).

See `docs/reliability-model.md` for the failover policy, retention rules, recovery procedure, and event-day checklist.

## Tech Stack

- Frontend: React 19, Vite 8, TanStack Router, TanStack Query, and TanStack Table.
- Backend: Express 5 with tRPC on `/trpc` (live updates as a subscription over a WebSocket on the same path), and SQLite through Node's built-in `node:sqlite`, so there is no native module to rebuild for Electron.
- Packaging: Electron + electron-builder. Production builds compile the backend to `dist-server/` and serve the Vite build from the local server.
- Exports: plain HTTP endpoints under `/api/export/*` for browser downloads and external tools.

In development, Vite serves the frontend on `5173` and proxies `/trpc` (including its WebSocket) and `/api` to the backend on `3000`. `npm run dev` starts both after seeding `.dev-data/`.

For the repository layout, runtime boundaries, and validation commands, see `docs/codebase-map.md`.
For hosting the app directly on the VPS without a laptop tunnel, see `docs/vps-deploy.md`.

## Running The Event

1. Connect the three Electron laptops to the event router by Ethernet.
2. Start Apolloon Telsysteem on all three and link them (see [Linked laptops](#linked-laptops)).
3. On Windows, the installer asks once for permission to open the firewall (TCP `5173`, UDP `45737`). If someone said no, use **Vast netwerkadres** in Beheer › Systeem, which opens the same rules.
4. Copy the Event URL with **Adres voor andere laptop kopiëren** on Overzicht, or from the bottom of the sidebar.
5. Open that Event URL on the TVs and any other screen. Do not use `localhost` on those.
6. Pick a page from the sidebar:
   - **Overzicht**: race time, the runner on the track, the latest laps, and system status.
   - **Wachtrij** (Telsysteem 1): warm-up and the queue of runners who are ready.
   - **Timing** (Telsysteem 2): the spacebar that records every handoff.
   - **Analyse**: figures, charts, and the exports.
   - **Tactiek**: the live race against the target and against last year.
   - **Binnenscherm** and **Buitenscherm**: the public screens for the TVs.
   - **Beheer**: preparation, runners, teams and labels, public screens, and system and recovery.

There is no password login. The event network is wired only, and that physical network is the trust boundary.

## Night Teams

A tijdelijke nachtploeg (Beheer › Ploegen & labels) moves its members from their speedteam to the night team during a planned window. Labels are derived from the schedule: nothing is rewritten, so members are back in their own speedteam as soon as the window ends or the team is removed. Each lap keeps the labels of the moment its runner started.

## Registration Import

Import the registrations in Beheer › Voorbereiding › Inschrijvingen importeren, from the form's Excel file (`.xlsx`, as downloaded from Google Sheets) or a CSV file. An Excel file is read from its first sheet and then imported exactly like a CSV. Imported runners stay in the `Ingeschreven` state and do not appear on the queue board until Wachtrij moves them to warm-up.

Two kinds of sheet are accepted:

- **The Google Form export.** It is recognised by its e-mail column. The row number becomes the runner number, the answers (availability, estimates, remarks, contact details) go into the runner's profile as typed, and the "Behoor je tot" answers become labels. Every row with a name is imported. On a repeat import a row updates the runner it became before, found by its e-mail address, else its submission time, else its row number and name, so answers such as `///` in the e-mail field do not mix runners up.
- **A plain runner list** with these columns:

  ```text
  runner_number,name,labels,historical_avg,historical_best
  ```

  `runner_number` and `name` are required. `labels` can hold several labels separated by commas, semicolons, or pipes. Columns such as `zustervereniging`, `vereniging`, `club`, `team`, `speedteam`, `jaar`, and `groep` are read as labels too. Times accept `ss`, `mm:ss`, or `hh:mm:ss`.

Existing runner numbers are updated instead of duplicated, missing labels are created automatically, and re-importing does not reset live statuses such as warm-up, waiting, running, or ran.

## Labels

Default labels:

- Speedteams: `Speedteam White`, `Speedteam Blue`
- Zusterverenigingen: `HILOK`, `Mesacosa`, `Kinesia`, with their logos from `public/labels/`
- Andere: `1ste jaar`, `Anciens`, `Dames`

Labels are listed by kind, then by name. In Beheer › Ploegen & labels each label can get a logo. The inside screen compares the labels of each kind by their laps; there are no lap goals per team.

## Timing Flow

Wachtrij (Telsysteem 1) controls the queue with two entry actions: **Loper zoeken** finds an imported runner and moves them to warm-up, and **Nieuwe loper** creates a runner on the spot and puts them straight into warm-up. Timing (Telsysteem 2) uses the spacebar or Enter:

- Opening the app does not start the race.
- The first press starts the race clock and the first runner in the queue.
- If no runner is active, a press starts the first runner in the queue.
- If a runner is active, a press saves that runner's lap and immediately starts the next runner in the queue.
- A lap runs from one press to the next as the timing screen recorded them from the key events, not from when the request reached the server. The lap time is measured on the browser's monotonic clock between the two presses, so network delay, a busy server, and clock corrections never change it.
- **Laatste wissel ongedaan maken** restores the previous runner on the track and the queue, and removes the lap that handoff recorded.
- Older laps are fixed in **Beheer › Rondes**: give a lap to the runner who really ran it, split a lap in two halves when a press was missed, or delete a press too many. Laps far shorter or longer than the race's usual lap are marked there. Each fix is listed in Beheer › Activiteit.
- **Race beëindigen** stops the race after a second confirmation. A press after that asks whether to resume the race.

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
                        (--hardware: the three event laptops, see docs/rehearse-hardware.md)
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

Installers are written to `release/` as `Apolloon Telsysteem`. Build each one on its own platform:

```text
npm run electron:build:win     Windows installer (on Windows)
npm run electron:build:linux   Linux AppImage
npm run electron:build:mac     macOS dmg and zip (on macOS)
```

## Releases And Updates

A version tag (`v4.3.0`) builds the installers into a draft release (`.github/workflows/release.yml`). Publishing that draft copies the installers, notes, and `SHA256SUMS.txt` to the public repository [SnaetWarre/apolloon-releases](https://github.com/SnaetWarre/apolloon-releases/releases) (`publish-public-release.yml`), because this repository is private. That workflow runs in the `public-releases` environment, whose `PUBLIC_RELEASES_TOKEN` may write to the public repository.

The desktop app reads the latest release there a few seconds after it starts and every six hours. On Windows and from an AppImage it downloads a newer version in the background (`electron-updater`, from the release's `latest.yml` / `latest-linux.yml`), and Beheer › Systeem & herstel › Over deze installatie then offers **Nu installeren en herstarten**: it makes a verified backup, closes, installs silently, removes the downloaded installer, and starts the new version. The sidebar says when an update is ready. Nothing installs by itself, and not while the race runs: all laptops must run the same version, so updating stays a deliberate step before the event. macOS (unsigned, so it cannot update itself) and development builds get a link to the installer instead, as does an install whose automatic download failed. Without internet the check stays quiet. `APOLLOON_UPDATE_CHECK=0` turns it off.

To try an update without publishing one, build two versions and serve the newer one's files:

```text
npx electron-builder --publish never --linux -c.extraMetadata.version=4.2.99   # copy the AppImage and latest-linux.yml to a folder
npx electron-builder --publish never --linux -c.extraMetadata.version=4.2.98
python3 -m http.server 8099 --directory <that folder>
APOLLOON_UPDATE_FEED=http://127.0.0.1:8099/ ./Apolloon-Telsysteem-4.2.98.AppImage
```

The same panel shows the version and data folder, opens the log folder, and copies a diagnosis (version, laptops, backups, the end of `server.log`) to paste into a message when asking for help.


## Exports

Analyse › Exporteren offers an Excel workbook for the teachers and plain files for scripts:

```text
/api/export/race.xlsx           Excel: laps and events, Dutch headers, local time, lap times as time values
/api/export/laps.csv
/api/export/laps.json
/api/export/events.csv
/api/export/events.json
/api/export/current-state.json
```

The CSV files use commas and UTC timestamps, which suits MATLAB and R; open the Excel workbook in Excel. All endpoints are local and work from any laptop on the event network.
