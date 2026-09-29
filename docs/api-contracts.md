# API Contracts

Three transports, three jobs. New features must follow these ownership rules so the layers do not overlap further.

## tRPC (`/trpc`, `server/router.ts`)

Owns every validated write, plus queries that need input validation or should stay off the live snapshot.

- Runner, label, queue, timing, night-team, settings, backup, and laptop-linking commands.
- `runners.registrations`: registration answers with contact details, loaded only by profile and Beheer views.
- Payloads are validated with Zod. Every laptop accepts writes; the leader commits them once a majority stored them, and the other laptops pass them on to it.
- Timing commands carry the race state the operator saw.
- Client entrypoint: `src/api.ts` (`trpc`), actions composed in `src/app/useAppActions.ts`.

Rule: if the client sends data that changes state, it goes through tRPC. Do not add POST/PUT/DELETE under `/api` for application writes; the network setup is the deliberate exception because it changes the laptop, not event data.

## Plain HTTP JSON (`/api/*`, `server/index.ts`)

Owns cacheable reads, file transfers, and operational endpoints.

- State: `GET /api/state` (live, without lap history or contact details), `GET /api/history`, `GET /api/time`, `GET /api/host-info`.
- Health: `GET /api/health` (readiness and release id).
- Backups: `GET /api/backups/latest` (download).
- Laptop status: `GET /api/cluster/status`.
- Network setup (`server/net-setup.ts`): `GET /api/net/profile`, and `POST /api/net/make-static` and `POST /api/net/revert-dhcp`, which only accept requests from the laptop itself.
- Exports (`server/exports.ts`): `GET /api/export/laps.csv|json`, `events.csv|json`, `current-state.json`.
- Large responses use `server/http-json.ts` (`sendJson`): gzip, ETags, and one serialization per data revision.

Rule: reads that benefit from HTTP caching, curl, or file download stay here. Do not add validated domain commands here.

## Socket.IO (`server/index.ts`)

Owns server push only, and pushes one thing: `state:revision` with the current data revision.

- The server emits it after every committed change, after a follower stores new entries, and when a night team starts or stops.
- A client whose snapshot has another revision refetches everything under the `['app']` query key; unchanged responses come back as `304`.
- On connect the server emits the current revision.

Rule: do not add typed deltas or request/response flows on the socket; clients always refetch server state.

## Linked laptops (LAN only, `server/cluster.ts`)

Machine-to-machine endpoints between Electron laptops, refused with HTTP 426 when app or schema versions differ:

- `POST /api/cluster/append`: the leader sends log entries (or a heartbeat); the answer carries the follower's log position.
- `POST /api/cluster/vote`: a (pre-)vote request during an election.
- `GET /api/cluster/snapshot`: a full database image for a joining or diverged laptop.
- `POST /api/cluster/members`: a laptop asks the leader to join the group.
- UDP 45737 (`server/discovery.ts`): a JSON announcement broadcast every two seconds, used to find laptops; it never changes data.
- Forwarded writes are ordinary tRPC calls with `x-apolloon-forwarded: 1` and `x-apolloon-request-id`; the leader answers with `x-apolloon-log-seq`, the entry to wait for.
