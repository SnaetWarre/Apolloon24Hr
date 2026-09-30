# Codebase Map

This app has three runtime surfaces:

- `src/`: React/Vite client for event operators, displays, and exports.
- `server/`: local Express, tRPC, Socket.IO, and SQLite runtime.
- `electron/`: desktop wrapper that starts the compiled server and opens the app; compiled to `dist-electron/`.

Shared contracts live in `shared/`. Anything imported by both client and server should go there instead of being duplicated in `src/` and `server/`.

## Client Shape

- `src/main.tsx`: React entrypoint and providers.
- `src/router.tsx`: route table. Wedstrijd routes load eagerly; Analyse, Kobe's
  tactiek, Beheer, and the displays are lazy routes preloaded on hover.
- `src/App.tsx`: app shell, loading/error states, and the connection and
  "too few laptops" banners. `components/Sidebar.tsx` holds the navigation.
- `src/app/`: app-wide data layer.
  - `queryClient.ts`: TanStack Query configuration.
  - `snapshot.ts`: query keys; everything server-derived lives under `['app']`.
  - `useAppData.ts`: live-state query with selectors.
  - `useRaceHistory.ts`: full, recent, and per-runner race history.
  - `useRegistrations.ts`: registration answers, for the profile, Beheer, and the
    "Nu beschikbaar" panel on Wachtrij.
  - `useAppActions.ts`: tRPC mutations that refresh this screen when they return.
  - `useRealtimeBridge.ts`: loads the realtime transport after the first state render.
  - `realtimeClient.ts`: refetches when the server announces a new revision,
    and keeps the server clock offset in sync.
  - `useFailover.ts`: browsers remember the other laptops and reopen the page
    on one of them when theirs disappears.
- `src/components/`: route-level screens and reusable UI pieces.
  - `AdminView.tsx`: Beheer tabs; each tab is a section component in
    `components/admin/` (`PreparationSection`, `RunnersSection`,
    `LabelsSection`, `PublicSection`, `SystemSection`). `AdminNotice.tsx` holds
    the shared busy/message hook.
  - `KobeTacticsView.tsx`: live API-backed tactics and the historical workspace shell.
  - `tactics/HistoricalDeepDive.tsx`: detailed historical charts, diagnostics, and drafting controls.
  - `ModalDialog.tsx`: native modal `<dialog>` wrapper; `isModalDialogOpen()`
    lets page-level shortcuts (timing Space/Enter) stay quiet under a dialog.
  - `ConfirmDialog.tsx`: `useConfirm()` returns an awaitable in-app confirmation.
    Use it instead of `window.confirm`, which freezes the live clocks.
- `src/lib/`: browser-side helpers and app-specific utility functions.
  - `tactics.ts`: historical race validation, live comparison, and target-scenario calculations for Kobe's tactiek.
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

- `server/index.ts`: HTTP, tRPC, and Socket.IO wiring, `/api` routes, startup and shutdown.
- `server/router.ts`: tRPC procedures and request validation.
- `server/runner-import.ts`: runner CSV and Google Form import.
- `server/exports.ts`: lap and event CSV/JSON exports.
- `server/static-files.ts`: packaged frontend serving.
- `server/db.ts`: facade over `server/db/` (SQLite schema, reads, writes, race-state transitions, replication log).
- `server/raft.ts`: leader election by majority (Raft), log replication, and majority commit, with storage, network, clock, and timers passed in.
- `server/consensus.ts`: runs `raft.ts` on this laptop's SQLite log, HTTP, and real timers.
- `server/cluster.ts`: endpoints between laptops, joining, passing writes to the leader, and the group status.
- `server/peers.ts`: requests between laptops and their addresses.
- `server/discovery.ts`: UDP announcements so laptops find each other on the LAN.
- `server/backups.ts` and `backup-verify-worker.ts`: scheduled, verified backups and retention.
- `server/app-state.ts`: live snapshot and lap history scopes.
- `server/http-json.ts`: gzip, ETags, and one serialization per data revision.
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
- `scripts/validation/`: Playwright browser checks; `run.mjs` runs each against its own seeded server.
- `public/event-network/`: static-address scripts, downloadable from Beheer for manual use.
- `docs/beschrijving.txt` and `docs/notes.txt`: the original requirements and design notes.
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

The design rationale lives in `docs/apolloon-redesign-brief.html`.

`tests/raft-sim.test.ts` runs the real `server/raft.ts` for hundreds of seeds on a fake clock and network with crashes, sleeping laptops, one-way and full partitions, lost, late and duplicated messages, and clock jumps, and checks after every step: one leader per term, terms never go back, one vote per term, no committed entry lost, no lap counted twice. It then heals everything and checks the group recovers by itself. A failure prints its seed; `RAFT_SIM_SEED=<seed> npm run test:sim` replays it exactly with the whole trace, and `RAFT_SIM_SEEDS=10000` searches further. The simulated log uses the same append rules as SQLite (`server/db/append-rules.ts`).

`npm run rehearse` starts three real servers with production timings, pulls power, cables, and lids at random while a bot presses Space and re-queues runners, then heals everything and checks that every laptop holds the same laps, every confirmed lap exactly once, with no overlapping laps. `--minutes`, `--seed` (same fault schedule), and `--keep` (keep `.rehearse/` with the server logs).

`npm run test:e2e` performs a production build and exercises the HTTP/runtime paths, including three laptops forming a group, the leader dying during a timed lap, catch-up after a restart, a laptop cut off from the others, continuing alone, finding each other after every address changed, exactly-once repeats, and version mismatches.
