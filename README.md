# Leuven 24h Runner Tracker

Local-first telsysteem for the Apolloon 24 Urenloop setup. One host laptop runs the Electron app and local server. Every other laptop or TV screen connects to that host through a browser on the wired local network.

## Event Network

Only the host laptop needs a fixed IP address.

Recommended defaults:

```text
Router/gateway: 192.168.24.1
Host laptop:    192.168.24.10
Server port:    5173
Event URL:      http://192.168.24.10:5173
```

Client laptops and TV laptops can use automatic DHCP. Their IP addresses do not matter because they only connect to the host.

## Running The Event

1. Connect the host laptop to the local router/switch by Ethernet.
2. Set the host laptop Ethernet adapter to `192.168.24.10`.
3. Start the Electron app on the host laptop.
4. Allow the firewall prompt for port `5173` if Windows asks.
5. On every other laptop, open `http://192.168.24.10:5173`.
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

Default label categories:

- Speedteams: `Speedteam White`, `Speedteam Blue`
- Zusterverenigingen: `HILOK`, `Mesacosa`, `Kinesia`
- Andere: `1ste jaar`, `Anciens`, `Dames`

The zustervereniging labels use the logo files in `public/labels/`.

Expected CSV columns:

```text
runner_number,name,labels,target_laps,historical_avg,historical_best
```

Notes:

- `runner_number` and `name` are required.
- `labels` can contain comma, semicolon, or pipe separated labels.
- Existing runner numbers are updated instead of duplicated.
- Missing labels are created automatically.

## Timing Flow

Telsysteem 1 controls the waiting queue. Telsysteem 2 uses the spacebar:

- Opening the app does not start the race.
- The first spacebar press starts the race clock and starts the first runner in the waiting queue.
- If no runner is active, spacebar starts the first runner in the waiting queue.
- If a runner is active, spacebar saves that runner's lap and immediately starts the next queued runner.
- Undo Last Handoff restores the previous active/next state and removes the last recorded lap.

There is no automatic 24-hour cutoff in the software.

## Test Seed Data

Create a safe seeded test database in `.test-data/`:

```text
npm run seed:test
npm run dev:seeded
```

`seed:test` creates a ready-to-start race: runners are loaded and queued, but the race has not started yet. Use this to test the first spacebar press.

For a mid-race test database with active runner, queue, lap history, displays, and analysis data:

```text
npm run seed:test:live
npm run dev:seeded
```

These scripts do not overwrite the normal app database.

## Exports

The analysis page links to:

```text
/api/export/laps.csv
/api/export/laps.json
/api/export/current-state.json
```

These endpoints are local and can be opened from MATLAB, RStudio, or another laptop on the event LAN.
