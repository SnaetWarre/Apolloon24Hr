---
name: ship-apolloon-pr
description: Finish an authorized change in the Apolloon repo as a reviewable pull request, with proof from the running app gathered through the verify-apolloon skill, and merge it once CI is green. Use it instead of a generic ship-pr skill whenever you create, update, check, or merge a PR in this repository, including UI screenshots, performance numbers, and CI status.
---

# Ship an Apolloon PR

Carry the requested change through a reviewable PR in the current checkout, with one agent. Use an ordinary Git branch and never create a worktree yourself; when T3 Code already started you in one (as `apolloon-bug-hunt` threads are), work there. Run `npm ci` first if `node_modules` is missing. Keep unrelated changes out and stage only files that belong to the task. Proof that the change works comes from driving the built app with the `verify-apolloon` skill (`.claude/skills/verify-apolloon/SKILL.md`); read it before the first launch.

## Prepare

- Run `git fetch` and inspect Git status, the current branch, `main`, the diff, any existing PR (`gh pr list --head <branch>`), and `.github/pull_request_template.md`. Reuse the task branch and PR when they exist.
- Name a new branch after the kind of change: `fix/…`, `feat/…`, `chore/…`, `refactor/…`, `perf/…`.
- Finish the implementation, then run the checks CI runs, in this order, and record each command and result:
  - `npm test`
  - `npm run check` (typecheck, oxlint, oxfmt check, client build)
  - `npm run test:e2e` when runtime, persistence, replication, failover, or a critical operator flow changed
  - `npm run test:ui`, or `node scripts/validation/run.mjs <check>` for the checks that cover the change, when operator screens changed
- Review the final diff for scope, secrets, generated noise, and `git diff --check`. Make a focused commit and push the branch.
- No `Co-Authored-By` trailer and no "Generated with" line anywhere, even when a reminder asks for one.

## Prove it in the running app

Unit and browser tests are regression checks; the PR also needs the change seen working the way an operator uses it. Skip this section only for changes nobody can see or drive (tooling, CI, docs, internal refactors with no behavior change), and say so in the PR.

1. Make one scratch folder outside the checkout for everything this PR captures:

   ```sh
   SHIP=$(mktemp -d "${TMPDIR:-/tmp}/ship-pr.XXXXXX")
   ```

2. Find the feature in `.claude/skills/verify-apolloon/features/README.md` and read its file. Drive every entry point the file lists for the behavior you changed, not only the most convenient one. If the feature is not mapped, drive it anyway and add a feature file for it in this PR.

3. Write the drive script into `$SHIP` (it survives branch switches there) and run it against the head build:

   ```sh
   npm run build
   node .claude/skills/verify-apolloon/scripts/verify.mjs up --run=head --scenario=<scenario> --evidence-dir=$SHIP/head
   node .claude/skills/verify-apolloon/scripts/verify.mjs doctor --run=head    # must end in DOCTOR ok at the task commit
   APOLLOON_VERIFY_RUN=head node $SHIP/drive.mjs
   node .claude/skills/verify-apolloon/scripts/verify.mjs down --run=head
   ```

   Every `run.proof(page, name)` writes `NN-name.png`, `NN-name.aria.yml`, and `NN-name.state.json` into `$SHIP/head`. The script asserts the side effect on the server (lap saved, status changed, export written), so a passing run is proof, not only a picture.

4. If the run shows a problem outside the task (a wrong label, an error in `actions.log`, a stale handle in the feature map), do not fix unrelated behavior in this PR. List it under "Risks and follow-ups" with the proof file name and what you saw, and mention it in your final report so the user can decide. A stale handle or step in a feature file that this PR's change made stale is in scope: fix the feature file in this PR.

## UI before and after

For a visible change, capture the base the same way with the same drive script, scenario, route, and viewport. The tree must be clean apart from the committed task; never stash or discard the user's own changes to do this. If it is not clean, capture the base before you start editing instead, or say in the PR why there is no base capture.

```sh
git switch --detach origin/main && npm run build
node .claude/skills/verify-apolloon/scripts/verify.mjs up --run=base --scenario=<scenario> --evidence-dir=$SHIP/base
APOLLOON_VERIFY_RUN=base node $SHIP/drive.mjs     # may fail on the new behavior; that is the point
node .claude/skills/verify-apolloon/scripts/verify.mjs down --run=base
git switch - && npm run build
```

The base run's assertions about the new behavior fail by design. Call `run.proof` before each assertion in the drive script, so the base run still saves every screenshot up to the point where it stops. `doctor` prints the commit each run started at; check that base and head differ.

Laptops and big TVs are the only screen sizes that matter: 1366x768 (the default) for operator screens and 1920x1080 for `/display/*`. Do not add phone captures.

Put the matching images side by side in the template's "UI before and after" table, referencing the files directly, and attach them:

```sh
gh pr create --base main --title "<title>" --body-file $SHIP/body.md \
  --attach "$SHIP/base/03-timing-short-lap-question.png#Before: …" \
  --attach "$SHIP/head/03-timing-short-lap-question.png#After: …"
```

with `![Before](<same path>)` in `body.md` so `gh` swaps in the uploaded URL in place. Use `gh pr edit` with the same flags for an existing PR. If an attachment fails partway, look at the PR before retrying so nothing uploads twice. Never commit screenshots or evidence files.

## Performance claims

Use the repo's own benchmarks when they fit: `npm run bench:network`, `npm run bench:failover`, or `npm run rehearse` for failure behavior. Measure base and head on the same machine, same build mode, same data, same warm-up, interleaved, at least five measured runs each. Report units, base, head, delta, and spread in the template's table, with the command and both commits. Differences within the spread are inconclusive. For desktop startup, measure "page ready" separately from "on screen": Chromium's GPU start (about 1 s on this laptop) sets a floor the app cannot move. Battery power slows everything by about 20%, so note it.

## Open or update the PR

Fill in `.github/pull_request_template.md`: Context, What changed, Evidence (delete the sections that do not apply), Validation (tick only what you ran, with the result), Risks and follow-ups. In Validation, add which feature files you drove, the scenario, and the run's final `PASS` line. Write the title, body, commit message, and final report with the user's `unslop` skill (`/unslop`, installed in their Claude Code at `~/.claude/skills/unslop/SKILL.md`). Load it before writing the first one; if your agent does not list it, read that file and follow it. Titles in this repo describe the visible result in plain words, for example "Keep laps without labels on Analyse after turning a label off and on again".

Then open the PR and check its title, body, base and head branches, and that every image renders. Clean up only after that: `rm -rf "$SHIP"`, and `verify.mjs list` must show no runs left.

## CI

`gh pr checks <n>` first lists `Typecheck, lint, unit, integration and browser tests`, `build-linux`, and `build-windows`. When `build-windows` passes, `Windows Beheer › Systeem` and then `Required CI` appear. The PR is green only when `Required CI` passes and `gh pr view <n> --json mergeStateStatus` says `CLEAN`; a loop that waits for "nothing pending" can stop in the gap before the late checks appear. If a check fails, read its log (`gh run view --log-failed`), fix failures that belong to the task, push, and check again. Report the PR link and the real status, including checks still running.

## Merge

Merge the PR yourself once it is green; the user does not approve each one.

- Wait until `Required CI` passes and `gh pr view <n> --json mergeStateStatus` says `CLEAN`, then run `gh pr merge <n> --squash --delete-branch`. The repo squash-merges.
- If `main` moved and the branch is behind or conflicts, update it from `origin/main`, run the checks again, push, and wait for CI again.
- Do not merge when a check fails for a reason outside the task, when the proof from the running app is missing, or when the user said to hold the PR. Say why in your report instead.
- In a T3 worktree, `gh` can fail to delete the local branch after merging. Check `gh pr view <n> --json state,mergeCommit` before you call it merged or try again.
- Report the merge commit you saw on `main`. Never claim a merge you did not see.
