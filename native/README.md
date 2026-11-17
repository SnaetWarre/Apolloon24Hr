# Apolloon native migration

Work in progress: Rune operator UI and Rust/Axum/SQLite server. This is not yet a replacement for the race-day app. The original application remains the production entrypoint.

Requires Rust 1.99.1, a C compiler, pkg-config and the platform's windowing development libraries. Linux: `build-essential pkg-config libxkbcommon-dev libwayland-dev`; headless rendering also needs a Vulkan driver such as Mesa lavapipe.

```sh
# Rust server, independent of Node/Electron; disposable separate database by default
cargo run --manifest-path native/Cargo.toml --no-default-features -- --server
# Rune desktop app (starts and stops its own Rust server)
cargo run --manifest-path native/Cargo.toml
# Domain regression tests
cargo test --manifest-path native/Cargo.toml --no-default-features
# Native renderer snapshot
cargo run --manifest-path native/Cargo.toml -- --snap /tmp/apolloon.png
```

`PORT` selects the Rust server port (default 5174). `APOLLOON_NATIVE_DATA` selects its SQLite file (default `.native-data/app.db`, relative to the working directory). `APOLLOON_NATIVE_URL` selects the UI's server (default `http://127.0.0.1:5174`). Use a **copy** of an existing schema-17 database for migration checks. Older/newer schemas are refused. Databases containing cluster members refuse mutations until the replicated runtime is ported.

Implemented so far: schema-17 live/full/recent/per-runner history and registration reads; runner creation, contact/availability editing and deletion; queue moves/reordering/hiding; timing handoff/start, stale-press checks, measured lap durations, finish/resume and transactional undo; labels and lap correction storage actions; five CSV/JSON download endpoints and the six-sheet Excel workbook with prize formulas; manual backup creation/list/preview; initial Rune overview, queue, timing, runner entry and lap ranking screens. The desktop owns its Rust server lifetime. Activity reads are compatible; mutation summaries still need the existing Dutch descriptions.

Still required before replacement: replicated writes/election/discovery/linking and clock sync; registration import and full editing; complete label correction UI, backups/restore and the Excel workbook UI; full tactics and public displays; desktop lifecycle/network setup/updating; packaging; UI and multi-laptop verification. The initial Tactiek/public screens currently show race summaries only. Do not deploy this migration as the event runtime yet.

Rune and its required platform/text patches are pinned to one upstream revision in `Cargo.toml`; `Cargo.lock` records transitive versions.

The full acceptance checklist is in [PARITY.md](PARITY.md). Current executable verification:

```sh
cargo test --manifest-path native/Cargo.toml
# Includes native pointer clicks → real HTTP server → SQLite → confirmation/undo.

# Disposable reference run only, after npm run build:
node .agents/skills/verify-apolloon/scripts/verify.mjs up --run=native-reference --scenario=live
APOLLOON_VERIFY_RUN=native-reference node native/scripts/capture-reference.mjs
APOLLOON_VERIFY_RUN=native-reference node native/scripts/compare-reference.mjs
node .agents/skills/verify-apolloon/scripts/verify.mjs down --run=native-reference
```

The reference comparison copies SQLite through the online backup API before starting an isolated Rust server on a free loopback port. It checks live state, full/recent/per-runner history, registrations, activity queries and all five CSV/JSON exports. The ready-to-start and live-race scenarios both passed. It excludes only process-local host/revision fields. It does not establish parity for unimplemented writes or replication.

`capture-reference.mjs` stores 30 screenshots/ARIA/state proofs in the verification evidence directory. `compare-reference.mjs` also writes a renderer fixture; `APOLLOON_NATIVE_FIXTURE=/absolute/path/fixture.json APOLLOON_NATIVE_THEME=light` can render it deterministically with Rune's `--snap`/`--tree` flags. Fixture mode blocks writes.

Geist and Big Shoulders font assets are losslessly unpacked from `public/fonts` using `scripts/convert-fonts.py` (python3-fonttools and python3-brotli). Their original licenses are in `public/fonts`. `scripts/export-icons.ts` copies the existing React icon geometry to SVG for Rune; it does not change the icon family.

Browser work in progress:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
PATH="$HOME/.cargo/bin:$PATH" native/scripts/build-web.sh
cargo run --manifest-path native/Cargo.toml -- --server
```

The Rust server serves `native/web-dist` (override with `APOLLOON_WEB_DIR`) and listens on all network interfaces. The WASM library shares the Rune UI and uses asynchronous, same-origin browser requests. Rune's WebGL2 fallback is enabled; the HTML loader does not require WebGPU. `vendor/RUNE-PATCHES.md` records the local pinned upstream fix needed for compilation. `node native/scripts/check-web.mjs` passed locally: with WebGPU unavailable it renders, navigates to Timing, clicks the handoff control, and verifies the runner persisted in SQLite. It writes screenshots, server state and browser errors under `.tmp-native-evidence/webgl`. Actual guest laptops, phones and TV hardware still need compatibility checks.

Workbook validation compares every cell value and formula in all six sheets with the reference exporter (`scripts/compare-workbook.py`), ignoring ZIP metadata and cached formula results. Backup work currently includes only manual creation, listing and preview; restore, automatic scheduling, retention and operator screens remain open.
