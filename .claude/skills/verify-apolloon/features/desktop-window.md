# Desktop window

The Electron app wraps the same pages in a desktop window. It adds a custom title bar on Windows and Linux, a preload bridge (`window.apolloonDesktop`) for the data folder, diagnostics, updates, and window controls, and a question before closing while the race runs.

## Sub-features

- `desktop-titlebar` shows the title bar above the app: the logo button `Apolloon, naar het overzicht` and the window buttons `Minimaliseren`, `Maximaliseren` (`Herstellen` when maximized), and `Sluiten`.
- `desktop-bridge` exposes `platform`, `pickImage`, `openDataFolder`, `getDiagnostics`, `update`, and `window` on `window.apolloonDesktop`. `window` has `minimize`, `toggleMaximize`, `close`, `getState`, and `onStateChange`; `update` has `getStatus`, `check`, `install`, `lastInstall`, `open`, and `onChange`.
- `desktop-fullscreen` toggles fullscreen with F11 and hides the title bar. There is no button and no bridge call for it.
- `desktop-about` shows the version, the data folder (which holds `server.log`), the update state, and the buttons `Logmap openen` and `Diagnose kopiëren` in Beheer › Systeem & herstel › Over deze installatie.

## How to get to it (user POV)

- Start the Apolloon Telsysteem app. Every page shows the title bar.
- Beheer › Systeem & herstel for the installation panel.

## Driving it with drive.mjs

Preconditions:

- Port 5173 is free (`ss -ltn 'sport = :5173'` lists nothing). If the user's dev server holds it, report this entry point as unreachable.
- `verify.mjs up --run=desk --port=5173`, `npm run electron:compile`, then `verify.mjs electron --run=desk`, which prints `ELECTRON run=desk … cdp=…`.

- **Attach.** `const page = await run.electronPage()`. `page.url()` is `http://127.0.0.1:5173/` and `await page.evaluate(() => Object.keys(window.apolloonDesktop))` lists the six bridge keys.
- **Title bar.** `page.locator('.titlebar').getByRole('button')` lists `Apolloon, naar het overzicht`, `Minimaliseren`, `Maximaliseren`, and `Sluiten`. `run.proof(page, 'desktop-titlebar')`; the screenshot shows the logo bar above the sidebar.
- **Fullscreen.** Not reachable from this helper. Only a real F11 key that reaches the window toggles it. `page.keyboard.press('F11')` and a raw CDP `Input.dispatchKeyEvent` both leave `window.apolloonDesktop.window.getState()` at `fullscreen: false`, and Electron has no CDP `Browser.setWindowBounds`. Report it as unreachable with that reason.
- **Installation panel.** `await page.goto('http://127.0.0.1:5173/admin?section=system')`. The panel `Over deze installatie` shows `Apolloon 0.0.0-dev` (a verify run sets no app version), the data folder inside `.tmp-verify/<run>/electron-profile`, and `Controleren op een nieuwere versie…` with a disabled `Bezig…` button, because the helper turns the update check off. Do not click `Logmap openen`: it opens a file manager on the user's screen.

## Gotchas

- Unpackaged Electron always loads port 5173 and never starts its own server; the run must own that port.
- The window runs with `--ozone-platform=headless`: nothing appears on screen, but screenshots work.
- Unpackaged Electron opens DevTools beside the page, so the screenshot can show a `1400px × 900px` size badge in the corner. It is not part of the app.
- `maximize()` never fires its event on this Hyprland desktop.
- With a race running the window ignores SIGTERM and shows a native question on the user's real screen. `verify.mjs down` uses SIGKILL for the window; do not close it any other way.
- For the packaged AppImage use `scripts/package-system-ui.mjs` or `scripts/package-smoke.mjs` after `npm run electron:build:linux`, prefixed with `env -u ELECTRON_RUN_AS_NODE`.
