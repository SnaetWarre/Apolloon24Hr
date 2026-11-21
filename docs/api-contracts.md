# Application endpoints

The browser uses same-origin HTTP calls to the Rust server. The desktop window uses the same endpoints on its local server.

- `GET /api/health` reports server startup and whether the race is active.
- `GET /api/state` returns live state. `GET /api/history` loads laps and events separately, with a full, recent, or per-runner scope.
- `POST /api/action/<method>` applies an operator action. The linked-laptop runtime orders writes and acknowledges a saved action after replication to a majority.
- `GET /api/registrations` returns registration details. `GET /api/export/<file>` serves CSV, JSON, and workbook downloads.
- `GET /api/cluster/status` supplies current peer and group status. The public browser uses it to reopen its current screen on another laptop after an outage.
- The other `/api/cluster/*` routes are for laptops of the same group and need the `x-apolloon-group` signature (see the reliability model); `POST /api/cluster/members` and `POST /api/cluster/invite` also answer a laptop that is linking.

The concrete payloads and routes are defined in `native/src/server.rs`, `native/src/cluster/routes.rs`, and the action handlers.
