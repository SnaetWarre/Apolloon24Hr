---
name: apolloon-ui-hunt
description: Walk the Apolloon screens the way a tired teacher or a spectator meets them, find real UI, UX, and motion problems (clipped or overlapping text, lost focus, extra clicks, missing feedback, animations that replay, jump, or hide what changed, TV pages that are hard to read), prove each one with screenshots, measurements, or a filmed frame strip through the verify-apolloon skill, and fix each one in its own T3 Code thread that ships and merges a PR through the ship-apolloon-pr skill. Built to run again and again; a ledger keeps rounds from repeating each other. Use it instead of apolloon-bug-hunt when the focus is the frontend. Arguments - a number sets the minimum finding count; any other text is a focus area (a screen, a flow, "motion", "TV").
---

# Apolloon UI hunt

The user's requests, as they wrote them:

> Find as many major issues in this codebase as possible: backend, frontend, middleware, anything. Once you find one and know a really good and easy fix, start a new thread inside T3 Code to fix it, and ship it in a PR using my ship-pr skill. If all CI passes, get it merged; I don't read the code anyway. Go for at least 7. They should be real issues, not hallucinations, so double-check by running pieces of code, Playwright, or whatever computer-use tool works best.

> but then for UI fixes? Or motion design things? or even UX? basically frontend bugs etc? [...] so I can just spin up an agent [...] and let it solve ui/ux flows on repeat

This skill is `apolloon-bug-hunt` with a different lens. It finds what an operator or a spectator sees and does wrong, not what the server stores wrong. Read `.claude/skills/apolloon-bug-hunt/SKILL.md` once; the rules about fetching first, deduplicating, and the thread rules apply here too unless this file says otherwise. "My ship-pr skill" means `ship-apolloon-pr`, and proof means `verify-apolloon`. Read both before you start.

Arguments: a number sets the minimum count (default 5); any other text is a focus area. A round ends when you reach the count or have walked every flow in the focus area.

## Who uses these screens

Judge every screen against the people and hardware it is for. A problem that does not hurt one of them does not count.

- Operators are teachers, not developers. They work on 1366x768 laptops in the Electron window, through a 24-hour race, at 3 in the morning, often with one hand on the space bar. Timing runs from the keyboard. They do not read long text and they do not know what a "leader" or "sync" is.
- Spectators look at `/display/inside` (Binnenscherm) and `/display/outside` (Buitenscherm) on giant TVs from several metres away, at 1920x1080. Nobody touches those pages.
- Phones do not matter. Do not report or fix anything below 1366 wide.
- The app has a light and a dark theme; both are used.

House rules that are deliberate and must not be "fixed":

- Motion answers an action (a press, an opening, a runner arriving) or marks something live. Nothing moves on its own to decorate. Durations and easings live in `src/styles/tokens.css`, keyframes in `src/styles/motion.css`, and `base.css` turns every duration to nothing under `prefers-reduced-motion`.
- The Buitenscherm flash stays loud: the blue and night pulse, the frame, and the yellow slab. Never turn it into a flat yellow screen or tone it down.
- No left accent borders anywhere. The user sees them as a sign of generated UI.
- User-facing text is Dutch. Registration answers show exactly as the runner typed them. There are no lap goals per team.
- Every button or fold-out that opens text fields puts the cursor in the first field (see Autofocus in `.claude/skills/verify-apolloon/features/README.md`), except the cases listed there.

## 0. Start of every round

```sh
git fetch && git switch main && git pull --ff-only
LEDGER=~/.cache/apolloon-ui-hunt/ledger.md
HUNT=~/.cache/apolloon-ui-hunt/$(date +%Y%m%d-%H%M)
mkdir -p "$HUNT"; touch "$LEDGER"
```

`/tmp` is wiped on reboot, so everything lives under `~/.cache`. The repo is public, so the ledger stays outside it.

- Read the ledger. It lists every flow walked in earlier rounds with its date, every finding with its thread and PR, and every suspicion dropped with the reason. Do not report a dropped suspicion again unless the code behind it changed.
- Run `gh pr list --state all --limit 60` and `git branch -r --list 'origin/fix/*'`. Skip anything that already has a PR or a branch.
- If 5 or more `fix/ui-*` PRs are still open, do not start new threads. Check on the running threads (`t3_thread_list`, `t3_thread_read`), report their state, and end the round.
- Pick this round's flows: the focus area if one was given, otherwise flows the ledger has never walked, then the ones walked longest ago, then the screens changed most since the last round (`git log --since=<last round> -- src/`).

## 1. Hunt

Walk flows, not pages. A flow is a task with a start and an end, done the way an operator or spectator does it. Examples:

- Check in a runner who just arrived, then move them to Klaar om te lopen (Wachtrij).
- Clock 10 handoffs in a row with the space bar, undo the last one, answer the short-lap question (Timing).
- Fix a lap given to the wrong runner (Beheer › Rondes), then find that runner's lap on Overzicht.
- Import the registration file, then find a runner with an accented name.
- Watch the Buitenscherm for a full minute while laps come in from another page.
- Take a laptop out of the group and read what Timing tells the operator.

The feature files in `.claude/skills/verify-apolloon/features/` list every way into each feature. Screens: `/` (Overzicht), `/queue`, `/timing`, `/analysis`, `/tactics`, `/admin?section=preparation|runners|laps|labels|public|activity|system`, `/display/inside`, `/display/outside`.

Look at each step of a flow through these lenses:

- **Layout.** Text that is cut off, overflows its box, or overlaps another element. Lists that break with 120 runners (`--scenario=large`) or with long or accented names. Empty states with 0 runners or 0 laps (`--scenario=empty`). Scrollbars inside a TV page. Both themes, 1366x768 for operator screens, 1920x1080 for TVs.
- **Interaction.** The cursor lost after an action, so the next key press goes nowhere. A keyboard path that stops working (Tab order, Enter, Escape, the space bar on Timing). More clicks than the task needs. A destructive button next to a common one. A button that does nothing visible. Disabled controls that do not say why.
- **Feedback and state.** An action with no visible result, or a result shown somewhere the operator is not looking. A screen that shows stale data after an action. Errors in English, in jargon, or without what to do next. A busy state that lets the operator press twice.
- **Motion.** An entrance animation that replays on every poll or re-render, so rows keep flickering. Layout shift that moves a button under the cursor between hover and click. Animations that block clicks or keys while they run. A flash of the wrong theme or of empty content on load. An important change (a new lap, a runner on the track) with no motion, so it is easy to miss. Motion that ignores reduced motion or does not end in the element's normal state.
- **TV readability.** Text too small to read from a few metres, low contrast, numbers that jump in width as they change, and updates that flicker the whole page.

Good places to look: screens changed in the last few PRs, components with no check in `scripts/validation/*-ui.mjs`, states that only happen mid-race (`--scenario=live`), dialogs opened from inside other dialogs, and anything that updates while the operator is typing.

Skip: taste ("I would use another blue"), new features, rewording text that is already clear, anything below 1366 wide, and anything the house rules above or the docs call deliberate.

## 2. Verify every finding before it counts

A finding counts only when you can show it on the current `origin/main` build and say who it hurts in which flow. Use `verify-apolloon`: `npm run build`, then `verify.mjs up --run=<slug> --scenario=<scenario> --evidence-dir=$HUNT/<slug>`, `doctor`, and a drive script `$HUNT/<slug>.mjs` that drives the real flow with clicks and keys and calls `run.proof` at each step.

Back every finding with at least one of these, and assert on it so the script fails where the problem is:

- **A measurement.** Cut-off text: `el.scrollWidth > el.clientWidth`. Overlap: compare `locator.boundingBox()` of the two elements. Lost cursor: `document.activeElement` after the action. Layout shift: collect `layout-shift` entries with a `PerformanceObserver` (`buffered: true`) around the action, and the button's `boundingBox()` before and after. Replaying animation: count `document.getAnimations()` started by one poll with nothing changed. Contrast: compute it from `getComputedStyle` colours (draw them on a canvas to get sRGB, as `scripts/validation/theme-ui.mjs` does) and compare with 4.5:1 for body text and 3:1 for large text. Clicks: count them for the task, before and after.
- **A screenshot** that anyone would call broken, from `run.proof`. Take it in both themes with `run.newPage({ colorScheme: 'dark' })` when colour matters, and at 1920x1080 for TVs (`viewport: { width: 1920, height: 1080 }`).
- **A frame strip** for motion. Open the page with `run.newPage({ video: true })`, slow animations with `Animation.setPlaybackRate`, take `const from = Date.now()` before the action, and call `run.film(page, name, { from, clip })`. Then look at `NN-name.strip.png` yourself. The verify skill shows the exact calls. Compare with `reducedMotion: 'reduce'` when the problem is about reduced motion.

Then decide:

- It shows twice in a row on `origin/main` (`doctor` prints the commit), not once while another build was busy.
- You can name the operator or spectator, the flow, and what goes wrong for them: a wrong key press, a missed lap, a second click, text they cannot read. If you cannot, drop it.
- When the measurement passes or the strip looks fine, the suspicion was wrong. Drop it and write it in the ledger.

Stop every run with `verify.mjs down --run=<slug>`. Never `pkill -f` or `pgrep -f`. Nothing opens a window on the user's screen.

## 3. Fix: one T3 thread per finding

For each verified finding with a small, clear fix, call `t3_thread_launch` with:

- `workspaceStrategy: {"type":"worktree","baseRef":"main","branch":"fix/ui-<slug>","startFromOrigin":true}`
- a self-contained `message` with: the problem in plain words, who it hurts and in which flow; the drive script and its failing assertion (give the `$HUNT` paths, which the thread can read, including screenshots and strips); actual vs expected; the intended fix and its scope; the check to add; and the rules below.

Rules to put in every thread prompt (the thread runs in another worktree and does not see this project's memory):

- Everything listed under "Rules to put in every thread prompt" in `.claude/skills/apolloon-bug-hunt/SKILL.md` applies; copy those lines in.
- Follow the house rules from the "Who uses these screens" section of `.claude/skills/apolloon-ui-hunt/SKILL.md`; paste them in too.
- Before touching styles, load the user's `good-css` skill, and for anything that changes how a screen looks, the `frontend-design` skill (both installed in the user's Claude Code under `~/.claude/skills/`). If your agent does not list them, read their `SKILL.md` files and follow them.
- Fix it with the existing tokens in `src/styles/tokens.css` and the keyframes in `src/styles/motion.css`. Add a new token or keyframe only when none fits. Keep the change to the screen and the problem named; no restyling around it.
- Add a check to the matching `scripts/validation/*-ui.mjs` that fails on `main` and passes on your branch, using the same measurement as the repro, so `npm run test:ui` catches it next time. Skip the check only when the problem cannot be measured (pure motion), and say so in the PR.
- In the PR, show base and head screenshots side by side in both themes when colour matters, at 1366x768 for operator screens and 1920x1080 for TVs. For motion, attach the base and head frame strips from `run.film`.

When two fixes touch the same file or the same component, say so in both prompts so each keeps its diff focused.

## 4. Report and update the ledger

Append to `$LEDGER` for this round: the date, each flow walked (screen, scenario, theme, viewport), each finding with its thread and PR, and each dropped suspicion with its reason in one line.

Then give the user a short list. For each finding: what is wrong and for whom, how you showed it (the measurement or the strip), and its thread. Then the PR and merge state as the threads finish. List dropped suspicions in one line each. Say plainly which threads are still running or failed. Never claim a merge you did not see. Keep `$HUNT` until every thread has read its repro; delete earlier rounds' folders once their PRs merged.

## Running it on repeat

`/loop /apolloon-ui-hunt` runs a round, waits, and starts the next one; `/loop 3h /apolloon-ui-hunt` fixes the gap. The ledger makes each round walk different flows, and the open-PR limit in step 0 stops rounds from piling up threads faster than CI merges them. A round with a focus area (`/apolloon-ui-hunt Buitenscherm`) still writes to the same ledger.
