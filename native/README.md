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

`PORT` selects the Rust server port (default 5174). `APOLLOON_NATIVE_DATA` selects its SQLite file. Development defaults to `.native-data/app.db`. The packaged app uses its platform data folder. `APOLLOON_NATIVE_URL` makes the desktop UI attach to an existing server. Use a copy of a schema-17 database for migration checks.

Packaged Rust laptops enable linking by default. Set `CLUSTER_ENABLED=true` in a development checkout to test joining, replicated writes, and timing ownership. The Rust and Electron servers use different peer protocols and cannot share one group. A linked database refuses standalone writes when the cluster runtime is disabled.

The remaining race-day checks are tracked in [PARITY.md](PARITY.md). Use a separate database until physical LAN, display and installer checks pass.

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

The Rust server serves `native/web-dist` (override with `APOLLOON_WEB_DIR`) and listens on all network interfaces. The WASM library shares the Rune UI and uses asynchronous, same-origin browser requests. Rune's WebGL2 fallback is enabled; the HTML loader does not require WebGPU. `vendor/RUNE-PATCHES.md` records the local pinned upstream fix needed for compilation. `node native/scripts/check-web.mjs` passed locally: with WebGPU unavailable it renders, navigates to Timing, clicks the handoff control, and verifies the runner persisted in SQLite. It writes screenshots, server state and browser errors under `.tmp-native-evidence/webgl`. `node native/scripts/check-failover.mjs` starts three isolated Rust laptops and verifies that a public display moves to a surviving member without losing its theme or zoom. The same browser smoke test passed over a non-loopback IPv4 address without a secure context. Physical laptop and TV checks remain open.

Workbook validation compares every cell value and formula in all six sheets with the reference exporter (`scripts/compare-workbook.py`), ignoring ZIP metadata and cached formula results. The backup workflow includes manual and scheduled creation, retention, preview, and restore with a verified safety copy.

The Native packages workflow builds Windows, macOS, and Linux archives alongside a Windows setup executable and a macOS disk image. Windows setup adds the application’s inbound firewall rules, and uninstall removes its rules while keeping the SQLite database. It checks that each staged program can open SQLite and serve the browser client from outside the checkout, then uploads the archives and their checksums. A `native-v*` tag sets the version compiled into the desktop app and stages the checked assets on a draft release. Publishing that release copies its assets to the public feed without changing the Electron release selected by GitHub’s latest endpoint.
