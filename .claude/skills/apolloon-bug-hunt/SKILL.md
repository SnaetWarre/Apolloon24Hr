---
name: apolloon-bug-hunt
description: Hunt for real, major bugs in the Apolloon repo, prove each one in the running app with the verify-apolloon skill before it counts, and fix each verified bug in its own T3 Code thread that ships and merges a PR through the ship-apolloon-pr skill. Use it instead of a generic bug-hunt skill in this repository. Arguments - a number sets the minimum bug count; any other text is a focus area.
---

# Apolloon bug hunt

The user's request, as they wrote it:

> Find as many major issues in this codebase as possible: backend, frontend, middleware, anything. Once you find one and know a really good and easy fix, start a new thread inside T3 Code to fix it, and ship it in a PR using my ship-pr skill. If all CI passes, get it merged; I don't read the code anyway. Go for at least 7. They should be real issues, not hallucinations, so double-check by running pieces of code, Playwright, or whatever computer-use tool works best.

In this repo "my ship-pr skill" means `ship-apolloon-pr` (`.claude/skills/ship-apolloon-pr/SKILL.md`), and "double-check" means the `verify-apolloon` skill (`.claude/skills/verify-apolloon/SKILL.md`). Read both before you start. Arguments: a number sets the minimum bug count (default 7); any other text is a focus area.

## 1. Hunt (do this yourself, don't spawn search agents)

- Run `git fetch` and `git pull --ff-only` on `main` first: the local checkout often lags merged PRs. Then look at open PRs (`gh pr list`) and remote `fix/*` branches, so you do not report a bug that already has a fix on the way.
- Read `README.md`, `docs/codebase-map.md`, `docs/reliability-model.md`, and `git log` since the last bug hunt, so recently changed code gets the most attention.
- Start with the paths that hurt most if they break: data writes, the race and timing flow, undo, startup and migrations, replication and failover, imports and exports. Then cover the UI.
- Prefer untested paths. Run `npm test` and the browser checks (`npm run build`, then `npm run test:ui`) early. A green suite tells you where the bugs are not.
- Use the verify map as a checklist: `.claude/skills/verify-apolloon/features/` lists every way an operator reaches each feature and what should happen. Drive the less common entry points and the "Not mapped yet" features; that is where nobody looked.
- Good bug sources: concurrent or stale screens (two laptops, queued clicks), restart and startup code that runs outside the replicated write path, undo after unusual sequences, ties in ordering where client and server sort differently, quick double presses, real-world input files (Excel ANSI CSVs, short rows, accented names), and exports opened in Excel.
- Skip style nits, speculative security issues without a realistic attacker, and anything that is deliberate according to the docs, code comments, or the verify map. Two examples of deliberate choices: registration answers are stored exactly as typed, and there are no lap goals per team.

## 2. Verify every bug before it counts

A suspicion counts as a bug only after you reproduced it against code at `origin/main`. Keep the exact repro and its output; the fix thread gets both.

Make one scratch folder outside the checkout for all repros:

```sh
HUNT=$(mktemp -d "${TMPDIR:-/tmp}/bug-hunt.XXXXXX")
```

Pick the narrowest route that shows the bug the way a user meets it:

- **What an operator sees or does (UI, timing, queue, displays, Beheer, linked laptops).** Use `verify-apolloon`. Run `npm run build`, then `node .claude/skills/verify-apolloon/scripts/verify.mjs up --run=<slug> --scenario=<scenario> --evidence-dir=$HUNT/<slug>`. Add `--laptops=3` for anything between laptops. Run `doctor` and require `DOCTOR ok`. Write `$HUNT/<slug>.mjs` with `openRun` from `scripts/drive.mjs`, following the matching feature file. Drive the real user path: clicks and key presses, with `run.rpc()` only for setup. Call `run.proof` at each step and assert the expected result, so the run fails exactly where the bug is. The failing assertion message is the "actual vs expected" for the report.
- **HTTP behavior (exports, `/api/*`, tRPC).** Start a run the same way and `curl` the URL that `up` prints. Save the request and the response body in `$HUNT/<slug>/`.
- **Pure database or server logic with no screen.** Write a small `$HUNT/<slug>.mts` that imports `server/db.ts` by absolute path, with a temporary `DATA_PATH` and `NODE_ENV=test`, and run it with `node --import tsx` from the repo root.

Then decide whether it is really a bug:

- The repro fails against the current `origin/main` build. `doctor` prints the commit each run started at; check it.
- It fails twice in a row, not once under load. Timing and failover need real milliseconds, so do not judge them while a build or another 3-laptop run is busy.
- The behavior contradicts the README, the docs, a code comment, or the verify map's stated end state. If those sources say it is deliberate, drop it.
- When the repro passes, the suspicion was wrong. Drop it and say so in your notes; do not count it.

Stop every run with `verify.mjs down --run=<slug>` (it kills by recorded PID and keeps the evidence). Never use `pkill -f` or `pgrep -f`. Nothing may open a window on the user's screen: Playwright is headless, and the desktop window runs through `verify.mjs electron`. Only one run at a time can own port 5173 for the desktop route.

## 3. Fix: one T3 thread per bug

For each verified bug that has a good, easy fix, call `t3_thread_launch` with:

- `workspaceStrategy: {"type":"worktree","baseRef":"main","branch":"fix/<slug>","startFromOrigin":true}`
- a self-contained `message` with: what the bug is in plain words; the verified repro (paste the drive script or `.mts` and its output, or give the `$HUNT` paths, which the thread can read); actual vs expected; the intended fix and its scope; the regression test to add; and the rules below.

Rules to put in every thread prompt (the thread runs in another worktree and does not see this project's memory):

- You are already in your own worktree on `fix/<slug>`; do not create another one. Run `npm ci` if `node_modules` is missing.
- Ship with the repo's `ship-apolloon-pr` skill (`.claude/skills/ship-apolloon-pr/SKILL.md`) and the repo PR template. Prove the fix with `verify-apolloon`: run the same repro against your branch and show that it now passes, with base and head screenshots for anything visible.
- Write the PR title, body, commits, and your final report with the user's `unslop` skill (`/unslop`, installed in the user's Claude Code at `~/.claude/skills/unslop/SKILL.md`). Load it before writing. If your agent does not list it, read that file and follow it.
- Lint and format with oxlint and oxfmt (`npm run lint`, `npm run format`), never ESLint or Prettier. Run `npm test` and `npm run check`, plus `npm run test:e2e` for critical flows.
- No attribution in commits or PRs. User-facing text is Dutch. No left accent borders.
- Headless GUI only; `unset ELECTRON_RUN_AS_NODE` before launching Electron by hand; never `pkill -f`.
- Call `link_pull_request` after creating the PR.
- You are authorized to merge: once the `Required CI` check succeeds (it appears only after `build-windows` finishes) and `mergeStateStatus` is `CLEAN`, run `gh pr merge --squash --delete-branch`. On conflicts, rebase on `origin/main`, re-run the checks, and wait for CI again.

When two fixes touch the same file, say so in both prompts so each keeps its diff focused.

## 4. Report

Give the user a short list. For each bug, give what is wrong, how you verified it (route, scenario, the failing assertion), and its thread. Then give the PR and merge state as the threads finish. List suspicions you dropped because the repro passed or the behavior is deliberate, in one line each. Say plainly which threads are still running or failed. Never claim a merge you did not see. Remove `$HUNT` once every thread has its repro.
