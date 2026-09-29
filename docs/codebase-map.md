# Codebase Map

This app has three runtime surfaces:

- `src/`: React/Vite client for event operators, displays, and exports.
- `server/`: local Express, tRPC, Socket.IO, and SQLite runtime.
- `electron/`: desktop wrapper that starts the compiled server and opens the app.

Shared contracts live in `shared/`. Anything imported by both client and server should go there instead of being duplicated in `src/` and `server/`.

## Client Shape

- `src/main.tsx`: React entrypoint and providers.
- `src/router.tsx`: route table. Wedstrijd routes load eagerly; Analyse, Kobe's
  tactiek, Beheer, and the displays are lazy routes preloaded on hover.
- `src/App.tsx`: app shell, loading/error states, and the connection and
  standby banners. `components/Sidebar.tsx` holds the navigation.
- `src/app/`: app-wide data layer.
  - `queryClient.ts`: TanStack Query configuration.
  - `snapshot.ts`: query keys; everything server-derived lives under `['app']`.
  - `useAppData.ts`: live-state query with selectors.
  - `useRaceHistory.ts`: full, recent, and per-runner race history.
  - `useRegistrations.ts`: registration answers, only for profile and Beheer.
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
  - `pressTiming.ts`: dates timing presses from their key events and measures
    laps on the monotonic clock.
  - `readiness.ts` and `systemStatus.ts`: the event readiness checklist and the
    one-line health status, from backup, standby, and clock state.
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
- `server/cluster.ts`: primary/standby roles, log pulling, joining, and promotion.
- `server/backups.ts` and `backup-verify-worker.ts`: scheduled, verified backups and retention.
- `server/app-state.ts`: live snapshot and lap history scopes.
- `server/http-json.ts`: gzip, ETags, and one serialization per data revision.
- `server/host.ts`: event LAN URL selection.
- `server/clock.ts`: the cluster clock shared by all laptops.
- `server/net-setup.ts`: pins the laptop's wired adapter to a static address (and back to DHCP) through the OS permission prompt; only callable from the laptop itself.

See `docs/backend-architecture.md` for the complete process, write,
replication, storage, and failure-handling model.
See `docs/reliability-model.md` for promotion (planned and emergency),
backup retention, and the event-day recovery runbook.

## Scripts And Data

- `scripts/seed-test-db.mjs`: deterministic and stress-test development data.
- `scripts/electron-build.mjs`: packaged Electron build wrapper.
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
```

New test files are picked up automatically; name integration tests
`*.e2e.test.ts` so they run in the slower suite. Unit tests are split by
module (`race-db`, `replication`, `schema-migration`, `ranking`, ...).

`npm run test:ui` seeds a fresh `ready` database per check, starts the built
server, and drives headless Chromium through Playwright. Run
`npx playwright install chromium` once. CI runs all of the above.

The design rationale lives in `docs/apolloon-redesign-brief.html`.

`npm run test:e2e` performs a production build and exercises the HTTP/runtime paths, including joining a standby, catch-up after a restart, planned and emergency promotion, a returning old primary, and version mismatches.
