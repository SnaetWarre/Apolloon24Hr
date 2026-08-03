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
  - `useAppData.ts`: snapshot query and loading/error state.
  - `useAppActions.ts`: tRPC mutations plus snapshot refresh.
  - `useRealtimeBridge.ts`: Socket.IO events that patch the snapshot cache.
  - `snapshot.ts`: snapshot query key and cache helpers.
- `src/components/`: route-level screens and reusable UI pieces.
- `src/lib/`: browser-side helpers and app-specific utility functions.
- `src/types.ts`: client-facing re-export of shared schema types.

## Server Shape

- `server/index.ts`: HTTP, tRPC, Socket.IO, static frontend serving, and export endpoints.
- `server/router.ts`: tRPC procedures and request validation.
- `server/db.ts`: SQLite schema, reads, writes, and race-state transitions.
- `server/cluster.ts`: local-first UDP discovery, authenticated delta exchange, creator bootstrap, and peer health.
- `server/cluster-protocol.ts`: signed discovery envelopes and untrusted network payload validation.
- `server/backups.ts`: verified online snapshots, retention, scheduling, and download metadata.
- `server/app-state.ts`: full snapshot assembly.
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

`npm run test:e2e` performs a production build and exercises the HTTP/runtime paths, including one-to-five-node replication, reconnects, bootstrap replacement, concurrent edits, and timing conflicts.
