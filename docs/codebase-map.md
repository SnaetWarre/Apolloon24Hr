# Codebase Map

This app has three runtime surfaces:

- `src/`: React/Vite client for event operators, displays, and exports.
- `server/`: local Express, tRPC, Socket.IO, and SQLite runtime.
- `electron/`: desktop wrapper that starts the compiled server and opens the app.

Shared contracts live in `shared/`. Anything imported by both client and server should go there instead of being duplicated in `src/` and `server/`.

## Client Shape

- `src/main.tsx`: React entrypoint and providers.
- `src/router.tsx`: route table.
- `src/App.tsx`: route shell and top-level page wrappers.
- `src/app/`: app-wide data layer.
  - `queryClient.ts`: TanStack Query configuration.
  - `useAppData.ts`: compact live-state query and loading/error state.
  - `useRaceHistory.ts`: lazy full, recent, and per-runner race history.
  - `useAppActions.ts`: tRPC mutations plus snapshot refresh.
  - `useRealtimeBridge.ts`: loads the realtime transport after the first state render.
  - `realtimeClient.ts`: Socket.IO events that patch the snapshot cache.
  - `snapshot.ts`: snapshot query key and cache helpers.
- `src/components/`: route-level screens and reusable UI pieces.
  - `KobeTacticsView.tsx`: live API-backed tactics and the historical workspace shell.
  - `tactics/HistoricalDeepDive.tsx`: detailed historical charts, diagnostics, and drafting controls.
- `src/lib/`: browser-side helpers and app-specific utility functions.
  - `tactics.ts`: historical race validation, live comparison, and target-scenario calculations for Kobe's tactiek.
  - `tacticsDeepDive.ts`: detailed historical statistics, race-gap models, live uncertainty, and drafting tests.
  - `readiness.ts`: derives the operator-facing event readiness checklist from
    backup, replication, clock, conflict, and timing state.
- `src/types.ts`: client-facing re-export of shared schema types.
- `src/styles/`: the "Piste" design system, imported once via `index.css`.
  - `tokens.css`: semantic colour, type, spacing and radius tokens for the light
    (day) and dark (night) operator themes. Components use only these names.
  - `base.css`, `primitives.css`: reset, focus, buttons, fields, labels, bibs,
    messages, tables and dialogs.
  - `shell.css`, `queue.css`, `timing.css`, `analysis.css`, `tactics.css`,
    `admin.css`: one file per operator surface.
  - `displays.css`: Binnen- and Buitenscherm with their own fixed palettes.
- `src/app/theme.ts`: per-browser Licht/Donker/Systeem preference
  (`localStorage["apolloon.theme"]`). `index.html` applies it before first paint;
  display routes ignore it and accept `?thema=licht|donker` instead.
- `src/lib/chartPalette.ts`: Chart.js colours read from the theme tokens;
  `useChartTheme()` in a chart effect redraws it after a theme switch.

## Server Shape

- `server/index.ts`: HTTP, tRPC, Socket.IO, static frontend serving, and export endpoints.
- `server/router.ts`: tRPC procedures and request validation.
- `server/db.ts`: SQLite schema, reads, writes, and race-state transitions.
- `server/cluster.ts`: local-first UDP discovery, authenticated delta exchange, creator bootstrap, and peer health.
- `server/cluster-protocol.ts`: signed discovery envelopes and untrusted network payload validation.
- `server/backups.ts`: verified online snapshots, serialized scheduling, disk warnings, retention, and download manifests.
- `server/app-state.ts`: separate live-state and full replication snapshots.
- `server/app-history.ts`: cached history scopes for analysis, displays, and profiles.
- `server/http-json.ts`: fast gzip and ETag handling for large JSON transfers.
- `server/host.ts`: event LAN URL/port discovery.
- `server/realtime.ts`: typed realtime event bridge.

See `docs/backend-architecture.md` for the complete process, write,
replication, storage, and failure-handling model.
See `docs/reliability-model.md` for timing transfer, emergency takeover,
backup retention, and the event-day recovery runbook.

## Scripts And Data

- `scripts/seed-test-db.mjs`: deterministic and stress-test development data.
- `scripts/electron-build.mjs`: packaged Electron build wrapper.
- `scripts/ensure-lan-dev-firewall.mjs`: development firewall helper.
- `.dev-data/` and `.test-data/` are disposable local databases.
- `data/app.db` is the normal local app database.
- `backups/` contains verified point-in-time recovery snapshots outside releases.

## Quality Gates

Use these before handing off changes:

```text
npm run typecheck
npm test
npm run test:e2e
```

Browser checks in `scripts/validation/` (`workflow-ui`, `dialog-ui`, `theme-ui`)
run against a disposable ready-seeded server; see `docs/workflow-audit.md`.
The design rationale lives in `docs/apolloon-redesign-brief.html`.

`npm run test:e2e` performs a production build and exercises the HTTP/runtime paths, including one-to-five-node replication, reconnects, bootstrap replacement, concurrent edits, and timing conflicts.
