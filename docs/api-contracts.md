# API Contracts

Three transports, three jobs. New features must follow these ownership rules so the layers do not overlap further.

## tRPC (`/trpc`, `server/router.ts`)

Owns every validated write, plus queries that need input validation or should stay off the live snapshot.

- Runner, label, queue, timing, night-team, settings, backup, and laptop-linking commands.
- `runners.registrations`: registration answers with contact details. Screens read the same answers from `GET /api/registrations`, which can answer `304`.
- Payloads are validated with Zod. Every laptop accepts writes; the leader commits them once a majority stored them, and the other laptops pass them on to it.
- Timing commands carry the race state the operator saw.
- Client entrypoint: `src/api.ts` (`trpc`), actions composed in `src/app/useAppActions.ts`.

Rule: if the client sends data that changes state, it goes through tRPC. Do not add POST/PUT/DELETE under `/api` for application writes; the network setup is the deliberate exception because it changes the laptop, not event data.

## Plain HTTP JSON (`/api/*`, `server/index.ts`)

Owns cacheable reads, file transfers, and operational endpoints.

- State: `GET /api/state` (live, without lap history or contact details), `GET /api/history`, `GET /api/registrations` (contact details, for profile, Wachtrij and Beheer), `GET /api/time`, `GET /api/host-info`.
- `?since=<revision>` on `/api/state` and on the full `/api/history`: the revision the screen already holds. The answer is then only what changed (`shared/delta.ts`): changed fields, and lists as ranges of the screen's copy plus the new or changed items. When the server no longer keeps that revision (the last eight) or the changes are not smaller, it answers in full. Revisions start at the server's start time, so a restarted server never answers from a revision a screen holds from before.
- Health: `GET /api/health` (readiness and release id).
- Backups: `GET /api/backups/latest` (download).
- Laptop status: `GET /api/cluster/status` (screens use it only while their live connection is down).
- Network setup (`server/net-setup.ts`): `GET /api/net/profile`, and `POST /api/net/make-static` and `POST /api/net/revert-dhcp`, which only accept requests from the laptop itself.
- Exports (`server/exports.ts`): `GET /api/export/laps.csv|json`, `events.csv|json`, `current-state.json`.
- Large responses use `server/http-json.ts` (`sendJson`): gzip, ETags, and one serialization per data revision.

Rule: reads that benefit from HTTP caching, curl, or file download stay here. Do not add validated domain commands here.

## Live revision and laptop status (tRPC subscriptions over WebSocket, `/trpc`)

Owns server push only. Screens subscribe through `src/app/realtimeClient.ts`; queries and writes stay on HTTP.

- `live.revision`: the current data revision.
- `live.cluster`: the laptop status (`/api/cluster/status`) now and whenever it changes, checked once a second while a screen that shows it is open. Free disk space only counts as a change per 64 MB.

- The server sends it after every committed change, after a follower stores new entries, and when a night team starts or stops.
- A client whose snapshot has another revision refetches everything under the `['app']` query key, sending `since` where it can; unchanged responses come back as `304`.
- On (re)subscribe the server sends the current revision.
- Both sides ping: the client reconnects when the server stops answering, and the server drops screens that vanished.

Rule: do not push event data or add typed deltas; clients always refetch server state. The `since` answers are generic patches of the full response, not domain events: a screen ends up with exactly what a full fetch returns.

## Linked laptops (LAN only, `server/cluster.ts`)

Machine-to-machine endpoints between Electron laptops, refused with HTTP 426 when app or schema versions differ:

- `WebSocket /api/cluster/peer` (`server/peer-socket.ts`): one socket per other laptop, opened when first needed and closed after 30 s unused. Messages are JSON `{ id, type, body }`, answered with `{ id, body }` or `{ id, refused: { code, error } }`:
  - `append`: the leader sends log entries (or a heartbeat); the answer carries the follower's log position.
  - `vote`: a (pre-)vote request during an election.
  A request without an answer within `CLUSTER_REQUEST_TIMEOUT_MS` counts as unreachable; if nothing at all came back on the socket meanwhile, it is dropped and the next request opens a new one.
- `GET /api/cluster/snapshot`: a full database image for a joining or diverged laptop.
- `POST /api/cluster/members`: a laptop asks the leader to join the group, with its host id, address, and computer name (`name`, optional).
- `POST /api/cluster/invite`: Koppelen pressed on a laptop with more runners asks an empty laptop to join its group; the empty laptop joins, then asks the other laptops of its old group to follow. A laptop with runners refuses.
- UDP 45737 (`server/discovery.ts`): a JSON announcement broadcast every two seconds, used to find laptops; it never changes data.
- Forwarded writes are ordinary tRPC calls with `x-apolloon-forwarded: 1` and `x-apolloon-request-id`; the leader answers with `x-apolloon-log-seq`, the entry to wait for.
