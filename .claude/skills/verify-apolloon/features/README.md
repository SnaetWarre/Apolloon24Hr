# Apolloon verification map

This folder is the maintained source for verifying what operators and spectators see in Apolloon. Read this index before driving the app, then use the matching feature file as the recipe. The launch, doctor, and cleanup steps are in `../SKILL.md`.

## Baseline preconditions

- `npm run build` ran after the last source change, and `verify.mjs doctor` ends with `DOCTOR ok`.
- The run was started by you with `verify.mjs up` for this check. Never drive the user's dev server on 3000/5173 or anything you did not start.
- The scenario matches the recipe: most recipes start from `--scenario=ready` (40 runners, race not started). A recipe that needs something else says so under `Preconditions:`.
- A recipe that changes data (starts the race, imports, links laptops) consumes the run. Start a fresh run for the next recipe instead of undoing by hand.

## Driving conventions

- Drive scripts import `openRun` from `scripts/drive.mjs` and run with `APOLLOON_VERIFY_RUN=<run>`.
- Use `getByRole` with the exact Dutch accessible name. Fall back to the CSS classes named here only where the app has no accessible name (queue rows, display bands).
- `run.rpc()` is for setup only. The action under test is a click or key press on the page.
- Only failover behaves differently for the desktop app: a page that should stay on its own laptop needs `run.newPage({ electron: true })`. Linking works from any page.
- Wait for a role or text to appear. Do not sleep, except for the app's own time rules (the 20 s short-lap question).
- `/api/state` can show a change about 250 ms after the screen does. Poll it until the change shows, and let the last request finish before `run.close()`.

## Autofocus

Every button or fold-out that opens text fields puts the cursor in the first field, so the operator clicks once and types. Treat a missing cursor as a bug, not a test detail.

- When a feature opens text fields, type with `page.keyboard.type(...)` right after the click, without clicking or filling the field first. Then read the field's value. `fill()` hides a lost cursor because it focuses the field itself.
- A fold-out (`<details>`) moves the cursor on its toggle event, one task after the click. Wait for `document.activeElement` to be the field before typing.
- Inside a dialog, React's `autoFocus` runs before the dialog opens and silently loses the cursor to the first button. Dialogs take `initialFocusRef` on `ModalDialog` instead.
- `scripts/validation/autofocus-ui.mjs` (part of `npm run test:ui`, so CI runs it) lists every place that must do this. When a change adds a button or fold-out with text fields, add it there and to the feature file.
- Left out on purpose: the runner profile (opened to read), tabs that show a page with a search box, fields that already hold a number (typing would add to it), and the fold-out that undoes the fixed network address (its extra step is deliberate).

## Proof and skip reporting

- Call `run.proof(page, name)` before and after each action. It saves a screenshot, an ARIA snapshot, and `/api/state`.
- Check the side effect on the server too (`run.api(...)`), and for linked laptops read it on a different laptop than the one you acted on.
- Name the feature ID (for example `timing-handoff`) and the entry point in each proof name or `run.note` line.
- If an entry point cannot be reached (for example port 5173 is taken, so no desktop window), report the command you tried and the precondition that failed. Do not report it as verified through another path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then has exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with drive.mjs` starts with `Preconditions:` and pairs each user action with the exact call and the observable result.
4. `Gotchas` lists traps that waste or invalidate a run.

## Features

- [Timing](./timing.md) covers the spacebar handoff, the short-lap question, undo, and ending and resuming the race.
- [Wachtrij](./queue.md) covers checking runners in, adding a new runner, moving runners between Opwarming and Klaar om te lopen, and the board filter.
- [Beheer › Lopers](./runners-admin.md) covers the runner list, its search and hour filter, and adding a runner by hand.
- [Registration import](./registration-import.md) covers importing the form's CSV or Excel file in Beheer › Voorbereiding.
- [Public displays](./public-displays.md) covers the Binnenscherm and Buitenscherm TV pages.
- [Linked laptops](./linked-laptops.md) covers linking three laptops and carrying on when one disappears.
- [Desktop window](./desktop-window.md) covers what only the Electron window adds: the title bar and the preload bridge.
- [Beheer › Rondes](./laps-admin.md) covers fixing laps after the fact: moving one to another runner, splitting one, deleting one, and the marked laps.
- [Activiteit](./activity.md) covers the change log in Beheer › Activiteit and the lines a runner profile save adds.
- [Analyse › Exporteren](./analysis-export.md) covers the six export downloads in Analyse and checking them without a save dialog in the desktop window.
- [Analyse › Grafieken](./analysis-charts.md) covers what the Analyse charts say when they have no laps to draw.
- [Beheer › Vast netwerkadres](./network-setup.md) covers pinning the laptop's address in Systeem & herstel, with the network's own prefix length.
- [Beheer › Systeem & herstel › backups](./system-recovery.md) covers making a backup, restoring one, and a laptop that starts on a damaged database.
- [Tijdelijke nachtploegen](./night-teams.md) covers creating night teams, editing their members and times, and switching them on by hand.
- [Tactiek](./tactics.md) covers the goal, valid-lap, and hourly pace fields in the live section and the number fields in Analyse vorig jaar.

Not mapped yet: the rest of the Analyse charts, the charts in Tactiek, the rest of Ploegen & labels.
