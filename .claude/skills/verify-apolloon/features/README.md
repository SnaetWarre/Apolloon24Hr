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
- Pages that link laptops or behave differently on the desktop need `run.newPage({ electron: true })`; the feature file says when.
- Wait for a role or text to appear. Do not sleep, except for the app's own time rules (the 20 s short-lap question).

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
- [Registration import](./registration-import.md) covers importing the form's CSV or Excel file in Beheer › Voorbereiding.
- [Public displays](./public-displays.md) covers the Binnenscherm and Buitenscherm TV pages.
- [Linked laptops](./linked-laptops.md) covers linking three laptops and carrying on when one disappears.
- [Desktop window](./desktop-window.md) covers what only the Electron window adds: the title bar and the preload bridge.
- [Activiteit](./activity.md) covers the change log in Beheer › Activiteit and the lines a runner profile save adds.

Not mapped yet: Analyse (charts and the export links to `/api/export/*`), Tactiek, Beheer › Lopers, Ploegen & labels (night teams), Publiek, backup and restore in Systeem & herstel, the welcome screen on an `empty` laptop.
