---
name: verify-apolloon
description: Launch and drive the real Apolloon Telsysteem (the lap-counting web app for the 24-hour race, also shown inside the Electron desktop window) to prove a change works the way an operator would use it. Starts throwaway built servers (one laptop or a linked group of three) on free ports with seeded data, drives them with headless Playwright, and saves screenshots, ARIA snapshots, and server state as evidence. Use it to verify a fix or feature in Timing, Wachtrij, Beheer, the public screens, linked-laptop failover, or the desktop window, instead of trusting unit tests alone.
---

# Verify Apolloon

Apolloon is a React app served by its own Express server. Operators use it inside the Electron desktop app on three linked laptops; TVs open the same pages in a browser. Every page an operator sees is the web UI served by `dist-server/server/index.js`, so the main way to verify is a headless browser against that built server. The Electron window only adds the desktop title bar, the close-during-race question, and the preload bridge (`window.apolloonDesktop`); there is a headless route for those too.

All commands below run from the repo root. The UI text is Dutch; the handles in the feature map are the exact strings.

## Rules that come from past mistakes

- Never put a window on the user's screen. They use this laptop while you work. Playwright runs headless; Electron runs with `--ozone-platform=headless` (the helper does both).
- The agent shell exports `ELECTRON_RUN_AS_NODE=1`. Any Electron launch you do by hand needs `env -u ELECTRON_RUN_AS_NODE`, or it fails with "does not provide an export named BrowserWindow". `verify.mjs electron` already strips it.
- Never use `pkill -f` or `pgrep -f`. The pattern matches your own shell command and kills it (exit 144). Stop processes by the PID the helper recorded, which `verify.mjs down` does.
- Do not touch the user's own data: `data/app.db`, `.dev-data/`, and anything on ports 3000, 5173 (their `npm run dev`), or 9333. The helper uses free ports and `.tmp-verify/<run>/` for data.
- `git fetch` first when hunting a bug: local `main` often lags merged PRs.
- After a click that opens text fields, type with `page.keyboard.type` instead of `fill()`. Every such button must put the cursor in its first field, and `fill()` hides it when one stops doing that (see Autofocus in `features/README.md`).

## Launch

1. Build. The helper refuses to start a build that is older than the source. It takes about 3 s.

   ```sh
   npm run build
   ```

2. Start a run. Each run gets free ports, its own seeded data folder, and its own evidence folder. Several runs can live side by side.

   ```sh
   node .claude/skills/verify-apolloon/scripts/verify.mjs up --run=my-check                      # one laptop, scenario "ready"
   node .claude/skills/verify-apolloon/scripts/verify.mjs up --run=race --scenario=live          # a race in progress
   node .claude/skills/verify-apolloon/scripts/verify.mjs up --run=group --laptops=3              # three laptops, not yet linked
   node .claude/skills/verify-apolloon/scripts/verify.mjs up --run=auto --laptops=3 --auto-link  # empty laptops link by themselves
   ```

   Scenarios (from `scripts/seed-test-db.mjs`): `empty` (labels only, shows the welcome screen), `ready` (40 runners spread over Ingeschreven, Opwarming, and Klaar; race not started), `live` (60 runners, race running, lap history), `large` (120 runners, about 250 laps).

   It is ready when it prints `UP run=<name>` with one `laptop-N http://127.0.0.1:<port> pid=<pid>` line per laptop. It waits for `/api/host-info` to answer before printing. If a laptop does not start, the message names its log file in `.tmp-verify/<run>/laptop-N.log`.

   The servers run as `NODE_ENV=production` with automatic backups and the update check off. In a group, only laptop 0 is seeded (`--seeded=2` seeds laptops 0 and 1); laptops 1 and 2 are empty until you link them (see `features/linked-laptops.md`). Linking by itself (`CLUSTER_AUTO_LINK`) is off unless you pass `--auto-link`, so the empty laptops wait for `Koppelen`. Each run announces itself on loopback on its own discovery port, so two groups never find each other.

3. Only for the desktop window (title bar, `window.apolloonDesktop`, close question): unpackaged Electron always loads `http://127.0.0.1:5173`, so start the run on that port, compile Electron, and start the headless window:

   ```sh
   ss -ltn 'sport = :5173'    # must list nothing; if the user's dev server is there, skip this route and say so
   node .claude/skills/verify-apolloon/scripts/verify.mjs up --run=desk --port=5173
   npm run electron:compile
   node .claude/skills/verify-apolloon/scripts/verify.mjs electron --run=desk
   ```

   Ready when it prints `ELECTRON run=desk pid=<pid> cdp=http://127.0.0.1:<port>`. The window uses its own profile in `.tmp-verify/desk/electron-profile`, never the user's.

## Doctor

Run this first, and again whenever something looks off. It only reads.

```sh
node .claude/skills/verify-apolloon/scripts/verify.mjs doctor [--run=NAME]
```

It checks that the build is newer than `src/`, `server/`, `shared/`, `public/`, and `index.html`; that the run was started at the current `HEAD`; that each server PID is alive, still runs `dist-server/server/index.js`, and owns its port; that `/api/health` answers ok; and for a desktop run, that the Electron window shows the app over CDP. Each laptop line also shows the runner count, whether the race started or finished, and in a group the `cluster=` state (`solo` before linking, `healthy` once all three are linked). It ends with `DOCTOR ok` (exit 0) or `DOCTOR found problems` (exit 1). On a stale build or old commit: `down`, `npm run build`, `up` again.

`verify.mjs list` shows every run and how many of its laptops are up.

## Drive

Write a small drive script and import the helper library by absolute path. `openRun()` picks the only live run, or the one in `APOLLOON_VERIFY_RUN`.

```js
import { openRun } from '/home/warre/Documents/apolloon/.claude/skills/verify-apolloon/scripts/drive.mjs';

const run = await openRun();
try {
  const page = await run.newPage();                   // headless Chromium, 1366x768, browser user agent
  await page.goto(run.url('/queue'));                 // run.url(route, laptopIndex)
  await page.getByRole('button', { name: 'Loper zoeken', exact: true }).click();
  await run.proof(page, 'search-open');               // evidence, see below
  const state = await run.api('/api/state');          // read-only server state for side effects
} finally {
  await run.close();
}
```

```sh
APOLLOON_VERIFY_RUN=my-check node /path/to/your-drive.mjs
```

What the library gives you:

- `run.newPage({ laptop, electron, viewport })` opens a page. Pass `electron: true` to send the Electron user agent. Only failover reads it: a browser moves to another laptop, the Electron app stays on its own. Desktop-only panels need the real bridge from `run.electronPage()`, not the user agent.
- `run.electronPage()` returns the page inside the real desktop window started by `verify.mjs electron`. `window.apolloonDesktop.window.*` can be called through `page.evaluate`. `maximize()` never fires its event on this Hyprland desktop, and fullscreen only follows a real F11 key, which the headless window never gets (see `features/desktop-window.md`).
- `run.api(route, laptop)` reads `/api/state`, `/api/history?scope=full`, `/api/cluster/status`, `/api/health`, `/api/registrations`, or `/api/export/*`. It returns JSON, the text of a `.csv`, and a `Buffer` for `race.xlsx`. `/api/state` can lag the screen by about 250 ms, so poll it until the change shows instead of reading it once.
- `run.rpc(laptop)` is a tRPC client. Use it only to put the app into the state a check needs (for example moving runners to `waiting`), never for the action you are proving.
- `run.note(text)` appends a line to the evidence folder's `actions.log`.

Handles: prefer `getByRole` with the Dutch accessible name and `exact: true`, as `scripts/validation/*.mjs` do. Main ones: sidebar links `Overzicht`, `Wachtrij`, `Timing`, `Analyse`, `Tactiek`, `Binnenscherm`, `Buitenscherm`, `Beheer` inside navigation `Hoofdnavigatie`; Beheer tabs open directly with `/admin?section=preparation|runners|laps|labels|public|activity|system`. Wait for a role or text, never a fixed sleep, except where the app itself measures time (the 20 s short-lap question in Timing).

A complete, working example lives in `scripts/examples/timing-handoff.mjs`. Copy it as a starting point:

```sh
node .claude/skills/verify-apolloon/scripts/verify.mjs up --run=timing
APOLLOON_VERIFY_RUN=timing node .claude/skills/verify-apolloon/scripts/examples/timing-handoff.mjs
```

The repo's own browser checks (`npm run test:ui`, or `node scripts/validation/run.mjs workflow-ui` for one) start their own servers and delete their data afterwards. They are regression tests, not evidence; run them too when you change behavior they cover.

The feature map in `features/README.md` lists each feature, every way a user reaches it, and the observable end state that proves it. Read the matching file before driving. A proof that drives one entry point is incomplete when the map lists others.

## Evidence

Evidence for a run goes to `.tmp-verify-evidence/<run>/` (gitignored by `/.tmp-*/`), or to the folder given with `up --evidence-dir=DIR`. The `ship-pr` skill uses that option to keep PR evidence outside the checkout. `run.proof(page, name)` writes three numbered files there:

- `NN-name.png`, the screenshot.
- `NN-name.aria.yml`, the page's ARIA tree with its URL on the first line.
- `NN-name.state.json`, `/api/state` from the server at that moment.

`actions.log` records what was done and when, including uncaught page errors.

Proof standards:

- Drive the real user path: clicks and key presses on the page, in the order an operator would do them. Setup through `run.rpc` is fine; the action under test is not.
- Capture before and after the action, not only the final screen.
- Check side effects next to what is visible: the lap in `/api/history?scope=full`, the runner's `status` in `/api/state`, the file from `/api/export/*`, or the row in Beheer › Activiteit.
- For linked laptops, read the result on a different laptop than the one you acted on.
- Mocks only where the app already has a boundary: `page.route` to fail `/api/state` or `/api/history` is how the repo tests connection errors. Never mock the server's answer to the action you are proving.
- A screenshot of the outside or inside display is proof of what a TV shows; the same page in `/timing` is not.

## Cleanup

```sh
node .claude/skills/verify-apolloon/scripts/verify.mjs down --run=NAME    # or without --run: every run
```

It stops only the processes the run started (by recorded PID, after checking the PID still runs the server), continues a laptop you froze with `SIGSTOP` so it can exit, kills the desktop window (it ignores SIGTERM while a race runs), and removes `.tmp-verify/<run>/`. It never deletes the run's evidence folder; it prints how many evidence files remain there. Run `down` after every failed attempt too, so no server or port is left behind. Delete old evidence folders only when the user no longer needs them.

## Helpers

- `scripts/verify.mjs up|doctor|electron|down|list` starts, checks, and stops runs, as shown above.
- `scripts/drive.mjs` is the Playwright library for drive scripts.
- `scripts/examples/timing-handoff.mjs` proves the Timing spacebar flow end to end and shows the proof pattern.

Other ways to see the app, for cases this skill does not cover: `npm run rehearse` (three servers under random failures), `scripts/package-smoke.mjs` and `scripts/package-system-ui.mjs` (the packaged AppImage, after `npm run electron:build:linux`; prefix with `env -u ELECTRON_RUN_AS_NODE`). If a screen recording of a visible window is needed, use a Hyprland headless output on workspace 10 (`hyprctl output create headless BENCH`), never the user's monitor.
