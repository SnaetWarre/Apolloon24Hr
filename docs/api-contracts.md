# API Contracts

Three transports, three jobs. New features must follow these ownership rules so the layers do not overlap further.

## tRPC (`/trpc`, `server/router.ts`)

Owns every validated write and every query that needs input validation.

- Runner, label, queue, timing, team, settings, and replication-admin commands.
- All payloads validated with Zod, plus `_commandId` / `_clientId` for exactly-once writes.
- Queue and timing preconditions enforced before commit.
- Client entrypoint: `src/api.ts` (`trpc`), actions composed in `src/app/useAppActions.ts`.

Rule: if the client sends data that changes state, it goes through tRPC. Do not add POST/PUT/DELETE under `/api` for application writes (backups and compaction are the deliberate exceptions below).

## Plain HTTP JSON (`/api/*`, `server/index.ts`)

Owns cacheable reads, file transfers, and operational endpoints.

- State: `GET /api/state`, `GET /api/history`, `GET /api/time`, `GET /api/host-info`.
- Health and deployment: `GET /api/health` (readiness verified per release).
- Backups: `GET /api/backups/status`, `POST /api/backups`, `GET /api/backups/latest`, manifest download.
- Maintenance: `POST /api/database/compact` (guarded, never during an active race).
- Exports: `GET /api/export/laps.csv|json`, `events.csv|json`, `current-state.json`.
- Responses use `server/http-json.ts` (`sendJson`) with ETag and gzip.

Rule: reads that benefit from HTTP caching, curl, or file download stay here. Do not add validated domain commands here.

## Socket.IO (`server/realtime.ts`)

Owns server-push deltas only. The client never writes through the socket.

- Event types defined in `server/realtime.ts` (`RealtimeEvent`).
- Server emits small deltas after successful local writes (`emitRealtime`).
- On connect the server emits the current `state:revision`; the client refetches via `/api/state` or history when its revision is stale.
- Client wiring: `src/app/realtimeClient.ts`, `src/app/useRealtimeBridge.ts`.

Rule: new realtime updates add a typed event in `server/realtime.ts` and emit it from the tRPC mutation that performed the write. Do not add request/response flows on the socket.

## Cluster sync (LAN only)

Peer lifecycle and delta exchange live in `server/cluster.ts` with signed UDP discovery (`server/cluster-protocol.ts`). It reuses the same operation log as local writes, not the UI transports above.
