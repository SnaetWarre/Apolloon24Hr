# Codebase

- `native/src/ui` contains the Rune operator and public screens used by desktop and WASM.
- `native/src/desktop` starts the window and server, manages updates, and monitors the window during a race.
- `native/src/server.rs` serves the browser, state, actions, and exports. `native/src/db.rs` and `native/src/schema.sql` hold race storage. `native/src/startup` migrates and repairs legacy databases.
- `native/src/cluster` owns linked-laptop writes, peer discovery, handoff ownership, and failover.
- `native/scripts` drives the browser, packaged server, and renderer recovery. `native/packaging` contains the Windows installer and macOS disk image build.
- `scripts/wrapped` is a separate operator tool for creating cards and sending email. Its card renderer runs in the same Rust server as the app.
