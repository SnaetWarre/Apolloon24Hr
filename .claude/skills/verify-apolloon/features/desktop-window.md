# Desktop window

The Electron app wraps the same pages in a desktop window. It adds a custom title bar on Windows and Linux, a preload bridge (`window.apolloonDesktop`) for the data folder, diagnostics, updates, and window controls, and a question before closing while the race runs.

## Sub-features

- `desktop-titlebar` shows the Apolloon title bar with window buttons above the app.
- `desktop-bridge` exposes `platform`, `pickImage`, `openDataFolder`, `getDiagnostics`, `update`, and `window` on `window.apolloonDesktop`.
- `desktop-fullscreen` toggles fullscreen from the title bar.
- `desktop-about` shows version, update state, and the log folder in Beheer › Systeem & herstel › Over deze installatie.

## How to get to it (user POV)

- Start the Apolloon Telsysteem app. Every page shows the title bar.
- Beheer › Systeem & herstel for the installation panel.

## Driving it with drive.mjs

Preconditions:

- Port 5173 is free (`ss -ltn 'sport = :5173'` lists nothing). If the user's dev server holds it, report this entry point as unreachable.
- `verify.mjs up --run=desk --port=5173`, `npm run electron:compile`, then `verify.mjs electron --run=desk`, which prints `ELECTRON run=desk … cdp=…`.

- **Attach.** `const page = await run.electronPage()`. `page.url()` is `http://127.0.0.1:5173/` and `await page.evaluate(() => Object.keys(window.apolloonDesktop))` lists the six bridge keys.
- **Title bar.** `run.proof(page, 'desktop-titlebar')`. The screenshot shows the `Apolloon` title bar above the sidebar.
- **Fullscreen.** Call `page.evaluate(() => window.apolloonDesktop.window.…)` for the fullscreen toggle, or click the title bar's button, and read the window state back the same way.
- **Installation panel.** `await page.goto('http://127.0.0.1:5173/admin?section=system')`; the panel `Over deze installatie` shows the version from `package.json`.

## Gotchas

- Unpackaged Electron always loads port 5173 and never starts its own server; the run must own that port.
- The window runs with `--ozone-platform=headless`: nothing appears on screen, but screenshots work.
- Unpackaged Electron opens DevTools beside the page, so the screenshot can show a `1400px × 900px` size badge in the corner. It is not part of the app.
- `maximize()` never fires its event on this Hyprland desktop. Fullscreen works.
- With a race running the window ignores SIGTERM and shows a native question on the user's real screen. `verify.mjs down` uses SIGKILL for the window; do not close it any other way.
- For the packaged AppImage use `scripts/package-system-ui.mjs` or `scripts/package-smoke.mjs` after `npm run electron:build:linux`, prefixed with `env -u ELECTRON_RUN_AS_NODE`.
