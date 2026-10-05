# Codebase Map

This app has three runtime surfaces:

- `src/`: React/Vite client for event operators, displays, and exports.
- `server/`: local Express, tRPC, and SQLite runtime.
- `electron/`: desktop wrapper that starts the compiled server and opens the app; compiled to `dist-electron/`.
  `splash.ts` is the window shown while it starts, `startup-error.ts` says in Dutch why it could not,
  `update-check.ts` reads the latest release from the public releases repository, and `updates.ts`
  downloads and installs it from the app on Windows and from an AppImage (`electron-updater`).

Shared contracts live in `shared/`. Anything imported by both client and server should go there instead of being duplicated in `src/` and `server/`.

## Client Shape

- `src/main.tsx`: React entrypoint and providers.
- `src/router.tsx`: route table. Wedstrijd routes load eagerly; Analyse,
  Tactiek, Beheer, and the displays are lazy routes preloaded on hover.
- `src/App.tsx`: app shell, loading/error states, and the connection and
  "too few laptops" banners. `components/Sidebar.tsx` holds the navigation.
- `src/components/WelcomeView.tsx`: what Overzicht shows on a laptop without
  runners (import here, or link to a laptop found on the network); loaded lazily
  by `RolePicker.tsx`. `lib/welcome.ts` decides when.
- `src/app/`: app-wide data layer.
  - `queryClient.ts`: TanStack Query configuration.
  - `snapshot.ts`: query keys; everything server-derived lives under `['app']`.
  - `useAppData.ts`: live-state query with selectors.
  - `useRaceHistory.ts`: full, recent, and per-runner race history.
  - `useRegistrations.ts`: registration answers, for the profile, Beheer, and the
    "Nu beschikbaar" panel on Wachtrij.
  - `useAppActions.ts`: tRPC mutations that refresh this screen when they return.
    Queue changes (lane moves, reordering) show at once and reach the server in
    click order.
  - `optimistic.ts`: those unconfirmed queue changes, kept on top of every
    refetch until the server answers.
  - Route loaders in `router.tsx` prefetch each page's queries (on hover, and at
    most 300 ms on click), so pages open filled in instead of jumping.
  - `useRealtimeBridge.ts`: loads the realtime transport after the first state render.
  - `realtimeClient.ts`: refetches when the server announces a new revision,
    keeps the server clock offset in sync, and receives the laptop status while
    a screen shows it (`useClusterStatus.ts`).
  - `deltaFetch.ts`: asks for only the changes since the revision held
    (`/api/state`, full `/api/history`) and applies them (`shared/delta.ts`).
  - `useFailover.ts`: browsers remember the other laptops and reopen the page
    on one of them when theirs disappears and the others confirm it is gone.
- `src/components/`: route-level screens and reusable UI pieces.
  - `AdminView.tsx`: Beheer tabs; each tab is a section component in
    `components/admin/` (`PreparationSection`, `RunnersSection`,
    `LabelsSection`, `PublicSection`, `SystemSection`). `AdminNotice.tsx` holds
    the shared busy/message hook. The open tab is `?section=` in the address
    (`adminSections.ts`). `useJoinGroup.ts` links this laptop to another one,
    for Systeem and the welcome screen; `AboutPanel.tsx` shows the version,
    updates, the log folder, and the diagnosis (`lib/diagnostics.ts`).
  - `TacticsView.tsx`: live API-backed tactics and the historical workspace shell.
  - `tactics/HistoricalDeepDive.tsx`: detailed historical charts, diagnostics, and drafting controls.
  - `ModalDialog.tsx`: native modal `<dialog>` wrapper; `isModalDialogOpen()`
    lets page-level shortcuts (timing Space/Enter) stay quiet under a dialog.
  - `ConfirmDialog.tsx`: `useConfirm()` returns an awaitable in-app confirmation.
    Use it instead of `window.confirm`, which freezes the live clocks.
- `src/lib/`: browser-side helpers and app-specific utility functions.
  - `tactics.ts`: historical race validation, live comparison, and target-scenario calculations for Tactiek.
  - `tacticsDeepDive.ts`: detailed historical statistics, race-gap models, live uncertainty, and drafting tests.
  - `availability.ts`: matches the form's hour blocks (`20-21u (dinsdag)`) to the
    Brussels clock, for `AvailableNowPanel.tsx` on Wachtrij: who can run this
    hour but is not warming up or waiting, with their phone number.
  - `pressTiming.ts`: dates timing presses from their key events and measures
    laps on the monotonic clock.
  - `readiness.ts` and `systemStatus.ts`: the event readiness checklist and the
    one-line health status, from backup and linked-laptop state.
- `src/types.ts`: client-facing re-export of shared schema types.
- `src/styles/`: the design system, imported once via `index.css` (Geist, neutral light and charcoal dark).
  - `tokens.css`: semantic colour, type, spacing and radius tokens for the light
    (day) and dark (night) operator themes. Components use only these names.
  - `base.css`, `primitives.css`: reset, focus, buttons, fields, labels, bibs,
    messages, tables and dialogs.
  - `shell.css`: sidebar, thin page header (`PageHeader.tsx`) and overview.
  - `queue.css`, `timing.css`, `analysis.css`, `tactics.css`, `admin.css`:
    one file per operator surface.
  - `displays.css`: Binnen- and Buitenscherm with their own fixed palettes.
- `src/app/theme.ts`: per-browser Licht/Donker choice
  (`localStorage["apolloon.theme"]`; without a stored choice the first load follows
  the OS once). `index.html` applies it before first paint; display routes ignore
  it and accept `?thema=licht|donker` instead.
- `src/lib/chartPalette.ts`: Chart.js colours read from the theme tokens;
  `useChartTheme()` in a chart effect redraws it after a theme switch.

## Server Shape

- `server/index.ts`: HTTP, tRPC, and WebSocket wiring, `/api` routes, startup and shutdown.
- `server/router.ts`: tRPC procedures and request validation.
- `server/runner-import.ts`: runner CSV and Google Form import.
- `server/exports.ts`: lap and event CSV/JSON exports and the Excel download route.
- `server/excel-export.ts`: the Excel workbook (laps and events, local time, lap times as time values).
- `server/static-files.ts`: packaged frontend serving.
- `server/db.ts`: facade over `server/db/` (SQLite schema, reads, writes, race-state transitions, replication log).
- `server/raft.ts`: leader election by majority (Raft), log replication, and majority commit, with storage, network, clock, and timers passed in.
- `server/consensus.ts`: runs `raft.ts` on this laptop's SQLite log, the peer sockets, and real timers.
- `server/cluster.ts`: endpoints between laptops, joining, passing writes to the leader, and the group status.
- `server/peers.ts`: requests between laptops and their addresses.
- `server/peer-socket.ts`: one WebSocket per other laptop carrying appends and votes, so a heartbeat costs its JSON and no HTTP headers.
- `server/discovery.ts`: UDP announcements so laptops find each other on the LAN.
- `server/backups.ts` and `backup-verify-worker.ts`: scheduled, verified backups and retention.
- `server/app-state.ts`: live snapshot and lap history scopes.
- `server/http-json.ts`: gzip, ETags, and one serialization per data revision.
- `server/deltas.ts`: the last revisions of the snapshot and lap history, to answer `?since=` with only the changes.
- `server/cluster-feed.ts`: pushes the laptop status to screens when it changes.
- `server/host.ts`: event LAN URL selection.
- `server/clock.ts`: the group clock shared by all laptops.
- `server/net-setup.ts`: pins the laptop's wired adapter to a static address (and back to DHCP) through the OS permission prompt; only callable from the laptop itself.

See `docs/backend-architecture.md` for the complete process, write,
replication, storage, and failure-handling model.
See `docs/reliability-model.md` for promotion (planned and emergency),
backup retention, and the event-day recovery runbook.

## Scripts And Data

- `scripts/seed-test-db.mjs`: deterministic and stress-test development data.
- `scripts/ensure-lan-dev-firewall.mjs`: development firewall helper.
- `scripts/rehearse.mjs` (`npm run rehearse`) and `scripts/rehearse-hardware.mjs`: the chaos
  rehearsal, on this machine or on the three event laptops over SSH (`docs/rehearse-hardware.md`).
- `scripts/validation/`: Playwright browser checks; `run.mjs` runs each against its own seeded server.
- `scripts/package-system-ui.mjs`: after an Electron build, starts the packaged app as the leader of
  two laptops, opens Beheer › Systeem in its window over the DevTools protocol, and checks that the
  network panel fills in while `/api/health` and the heartbeats keep going. CI runs it on Windows,
  where the panel reads the profile through PowerShell.
- `scripts/bench-network.mjs` (`npm run bench:network`): network traffic and update latency of seven
  browser screens behind a shared slow link, their first load and main-thread
  time on a slowed-down CPU (`--cpu=4`), and the idle traffic between three
  laptops (`npm run build` first).
- `scripts/bench-failover.mjs` (`npm run bench:failover`): how long a TV and a
  browser operator take to reopen on another laptop when theirs crashes or
  freezes, and whether short freezes move them (`npm run build` first).
- `public/event-network/`: static-address scripts, downloadable from Beheer for manual use.
- `docs/beschrijving.txt`: the original requirements.
- `.dev-data/` and `.test-data/` are disposable local databases.
- `data/app.db` is the normal local app database. Local databases are git-ignored;
  seed a fresh one with `npm run db:dev:seed` instead of committing one.
- `backups/` contains verified point-in-time recovery snapshots outside releases.

## Quality Gates

Use these before handing off changes:

```text
npm run typecheck      # client, server, and tests (tsconfig.tests.json)
npm run lint           # oxlint
npm run format:check   # oxfmt (npm run format fixes)
npm test               # every tests/*.test.{ts,mjs} except *.e2e.test.ts
npm run test:e2e       # builds, then every tests/*.e2e.test.ts
npm run test:ui        # browser checks against the build
npm run test:sim       # the consensus simulation alone (part of npm test)
npm run rehearse       # three real servers under random failures (not in CI)
```

New test files are picked up automatically; name integration tests
`*.e2e.test.ts` so they run in the slower suite. Unit tests are split by
module (`race-db`, `replication`, `schema-migration`, `ranking`, ...).

`npm run test:ui` seeds a fresh `ready` database per check, starts the built
server, and drives headless Chromium through Playwright. Run
`npx playwright install chromium` once. CI runs all of the above.

`race-day-ui` is the race-day walkthrough on three laptops: a Timing press
reaching the Binnenscherm on another laptop, queue moves, a new runner with
labels, Beheer › Systeem, the leader killed mid-lap, a TV switching laptops, and
the dead laptop rejoining. Every step has a time budget and fails when it gets
slower; the times print at the end and land in the CI job summary.


`tests/raft-sim.test.ts` runs the real `server/raft.ts` for hundreds of seeds on a fake clock and network with crashes, sleeping laptops, one-way and full partitions, lost, late and duplicated messages, and clock jumps, and checks after every step: one leader per term, terms never go back, one vote per term, no committed entry lost, no lap counted twice. It then heals everything and checks the group recovers by itself. A failure prints its seed; `RAFT_SIM_SEED=<seed> npm run test:sim` replays it exactly with the whole trace, and `RAFT_SIM_SEEDS=10000` searches further. The simulated log uses the same append rules as SQLite (`server/db/append-rules.ts`).

`npm run rehearse` starts three real servers with production timings, pulls power, cables, and lids at random while a bot presses Space and re-queues runners, then heals everything and checks that every laptop holds the same laps, every confirmed lap exactly once, with no overlapping laps. `--minutes`, `--seed` (same fault schedule), and `--keep` (keep `.rehearse/` with the server logs). `--hardware` runs it against the installed app on the three event laptops listed in `rehearse-laptops.json`: SSH tunnels to each laptop's own 127.0.0.1 stand in for its screen, nft or Windows Firewall rules cut the app's traffic between laptops (all others, or one for a partial split), killing the app cuts power, and a backup from before is restored after a passing run; `--hands` adds prompts for real cables, lids and power buttons. The runbook is `docs/rehearse-hardware.md`.

`npm run test:e2e` performs a production build and exercises the HTTP/runtime paths, including three laptops forming a group, the leader dying during a timed lap, catch-up after a restart, a laptop cut off from the others, continuing alone, finding each other after every address changed, exactly-once repeats, and version mismatches.
