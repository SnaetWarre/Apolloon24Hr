# Native replacement acceptance contract

The reference is the existing Electron application, including its server, browser/public displays, desktop integrations and packaged behavior. A renamed page or a summary in place of a feature does not count as implemented. The existing app remains the production runtime until all gates below pass.

## Appearance

Compare the same seeded data, viewport and theme in both applications. Preserve Geist, the Apolloon wordmark, icons, spacing, colors, tables, charts, dialogs, notices, keyboard focus and responsive layouts. Check light and dark at 1366×768 and 1920×1080. Public screens keep their distinct palettes and typography. Screenshot comparison must account for renderer font antialiasing without hiding layout differences.

## Workflow inventory

- Overzicht: empty welcome/import/linking; race KPIs; track and next runner; queue counts; recent laps; health; address copy.
- Wachtrij: search/check-in, autofocus, manual registration, profile/contact/availability, labels and search filters, drag ordering and all lane moves, hidden runners, optimistic actions and failure recovery.
- Timing: single timing-laptop ownership/takeover, Space/Enter without key-repeat or modal leakage, event-time timestamps and monotonic duration, short-lap confirmation, empty queue, undo, finish/resume, offline/takeover pending state.
- Analyse: all statistics/charts, ranges, ranking/filtering and six export routes including the Excel workbook with formulas and registration fields.
- Tactiek: live target/rival comparisons, historical file import/validation, every chart, goal and scenario field, hourly pace and drafting controls.
- Beheer: preparation/readiness, CSV/XLSX imports and repeat identity matching, runner CRUD/registration editing, lap correction/reassignment/split/delete/shift, labels/logos/membership, public settings/competitions, activity, system/network/recovery/update tools.
- Public: inside, outside and competition screens, all states/rotations/records, fonts/logos, fullscreen, shared timing, browser failover.
- Wrapped: workbook-to-card export and existing runner-card output behavior.
- Desktop: start/error/retry, local server supervision, single instance, window state and controls, keep-awake, close confirmation, crash recovery, logs/diagnostics, firewall and static-IP setup, version/update installation.
- Storage: schema-17 compatibility, older-schema migration strategy, durable transactions, FK checks, corruption handling, backups/retention/restore, undo compatibility and export fidelity.
- Networking: LAN discovery, stable identity, group merge/link from either side, majority durability, failover/catch-up, timing ownership, group clock continuity, lost-laptop replacement, explicit/automatic solo continuation, split reconciliation, browser reconnect.
- Distribution: native Windows/macOS/Linux packages, launch without Node/Electron, install/upgrade/rollback, smoke tests on each target platform.

The recipes in `.agents/skills/verify-apolloon/features/` are the minimum behavioral checks, not the complete inventory. Existing tests and implementation fill gaps in that map.

## Linking improvement authorized by the user

Before a race, linking must be possible from either laptop with minimal operator travel. Show discovered computer names and clear connection progress. Merge the same registration once, retain different people even if bibs match, and preserve labels. Resolve the destination identically on both sides, including simultaneous clicks. An active first lap is a running race even when the completed-lap count is zero. Do not silently erase a real race or reinterpret an isolated racing laptop as an empty setup laptop. If practice data is replaced, keep a verified backup and say which data is retained. The current ten-lap practice threshold is reference behavior to evaluate explicitly, not silently copy as proof of a stopped race.

## Browser target

The same Rune UI must compile to WASM and work when guests browse to a laptop by IP and port over HTTP. Enable WebGL2 fallback and verify with WebGPU unavailable. Browser fetch uses the page origin; native-only storage/server/process code stays outside the WASM library. The local headless Chromium check passes with WebGPU unavailable: Rune renders, navigates to Timing and starts a runner through a real Rust server into SQLite. Actual LAN-device and TV checks remain outstanding.

## Completion gates

- Every workflow above has a corresponding implementation and recorded native proof.
- Rust and reference backend return equivalent domain results for fixtures/actions; data survives restart and rollback.
- Native UI actions are exercised against real Rust servers, with persisted side effects checked separately.
- Three-laptop workflows and failure cases pass, including simultaneous linking, network partitions, restart and catch-up.
- Both themes and all public screens pass visual review against captured reference screenshots.
- Native platform packaging and desktop integrations are verified on their platforms.

The native desktop and WASM builds include the operator screens, public displays, CSV and Excel registration imports, lap corrections, backups and restore. The native suite exercises operator actions against a Rust HTTP server and checks the resulting SQLite state. The browser smoke test covers timing and registration import over HTTP with WebGPU disabled.

The Rust server can merge pre-race registrations in one transaction. It matches people by name, email and phone, preserves label memberships, and adds a runner without a number if their number is taken. It refuses to merge after the race starts, including during the first lap. With discovery enabled, Beheer shows nearby laptops and their race status. The join and replicated write paths still need to call the merge code. Existing linked databases remain protected against standalone writes.

Race state, lap history, registrations, activity, and the CSV and JSON exports were compared against schema-17 reference databases. The Excel export matches the six reference sheets by value and formula. The full acceptance gates remain open, including visual parity, the unfinished historical analysis views, physical LAN and display checks, linked operation and packaging.
