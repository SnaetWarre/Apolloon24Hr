# Rune desktop and browser

`cargo run --manifest-path native/Cargo.toml` opens the native window and supervises its Rust server. Use `-- --server` to run only the server. For a server build without desktop libraries, pass `--no-default-features` to Cargo.

| Setting | Purpose |
| --- | --- |
| `PORT` | Override the listening port. Packaged desktop apps use 5173. |
| `APOLLOON_NATIVE_DATA` | SQLite file. Development uses `.native-data/app.db`. |
| `APOLLOON_WEB_DIR` | Compiled browser assets. The default is `web-dist` beside the packaged executable or `native/web-dist` in development. |
| `APOLLOON_NATIVE_URL` | Attach a desktop window to a separately started server. |
| `CLUSTER_ENABLED` | Enable laptop groups in a development run. Packaged desktop apps enable groups by default. |
| `CLUSTER_DISCOVERY` and `CLUSTER_AUTO_LINK` | Set either to `false` to exercise manual pairing in a rehearsal. |

The server reads schema 17, migrates schemas 13–16 after verifying a copy, and archives databases from before Apolloon 4.0. It preserves registrations, queue position, and laps during migration. The earlier desktop release and native release use different peer protocols. Switch every laptop in the group before linking.

Run the build and test commands in the [project README](../README.md). The [acceptance checklist](PARITY.md) records the comparison with the previous app. `scripts/capture-native.mjs` captures the browser screens in both themes from a copy of a supplied database. `--snap /tmp/apolloon.png` and `--tree` can inspect the desktop renderer with a fixture.

The Rune revision and patches are recorded in [vendor/RUNE-PATCHES.md](vendor/RUNE-PATCHES.md). The shared browser bundle uses WebGL2 or CPU rendering when WebGPU is unavailable. The server serves the gzip-compressed WASM when the browser accepts it.
