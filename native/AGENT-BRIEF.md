# Shared brief for native port agents

Goal: the Rust + Rune port in `native/` must match the React app (`src/`) pixel- and flow-exact: every button, label,
spacing, order, dialog and click flow in the same spot. React source is the spec; reference screenshots are the check.

## Where things are
- React spec: `src/components/**` (e.g. `AnalysisView.tsx`, `analysis/`, `TacticsView.tsx`, `tactics/`, `admin/*Section.tsx`),
  styles in `src/styles/`.
- Reference screenshots at 1366x768: `.tmp-verify-evidence/native-reference/NN-reference-{light,dark}-<name>.png`
  (+ `.aria.yml` with exact texts/roles). Light = 01..15, dark = 16..30. Names: overview, queue, timing, analysis,
  tactics, admin-preparation, admin-runners, admin-laps, admin-labels, admin-public, admin-activity, admin-system,
  inside, competitions, outside.
- Native capture of the same data: `cargo build --manifest-path native/Cargo.toml --bin apolloon-native && native/scripts/build-web.sh`
  then `node native/scripts/capture-native.mjs <outDir> <name...>` -> `<outDir>/native-{dark,light}-<name>.png`.
  Compare side by side (python PIL is available; make a pair image and Read it).
- Native UI: `native/src/ui.rs` (State, view dispatch, admin() tab bar), per-page modules in `native/src/ui/`.
  Good examples of finished, matching pages: `ui/queue_page.rs`, `ui/timing_page.rs`, `ui/laps_panel.rs`, `ui/overview.rs`.
  Shell header hooks per page: `ui/shell.rs` `header_meta` / `header_actions` (match on `s.page`).
- Rune UI lib is vendored at `native/vendor/rune` (read its API there; e.g. no `.clip()`, use `.clip_rounded(0.0)`).
- Server actions: `native/src/server.rs` (`/api/action/{method}`); add missing arms there if the React flow needs one.

## Rules
- Put your work in your own new module file(s) under `native/src/ui/`. Changes to shared files (`ui.rs`, `shell.rs`,
  `server.rs`) must be minimal: add `mod x;` and change only your dispatch arm. Other agents edit these files at the same
  time: always re-Read the exact region right before each Edit, never rewrite large chunks, never run `cargo fmt` on
  shared files (rustfmt only your own files: `rustfmt --edition 2021 native/src/ui/yourfile.rs`).
- Shared target dir: never `cargo clean`, never set a different CARGO_TARGET_DIR. Machine is small (8 cores, 9 GB RAM).
- No git commits, no pushes.
- Add native UI tests in ui.rs's tests module style (in-memory Db + `crate::server::start` + `Runtime`, `click`/`update`
  helpers) for the main flows (button -> action -> SQLite result). `cargo test --manifest-path native/Cargo.toml` must pass
  (53+ tests). If another agent's in-progress code breaks the build briefly, wait a minute and retry; don't fix their files.
- Dutch (nl-BE) texts exactly as in React.
- Finish with a short report: what matches now, what still differs (be honest), files touched.
