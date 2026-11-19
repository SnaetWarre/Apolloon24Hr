---
name: ship-apolloon-pr
description: Finish an authorized change in the Apolloon repo as a reviewable pull request, with proof from the running app gathered through the verify-apolloon skill, and merge it once CI is green. Use it instead of a generic ship-pr skill whenever you create, update, check, or merge a PR in this repository, including UI screenshots, performance numbers, and CI status. "Full send" and "full stop" in this repo also mean this skill; full stop ends at a green PR the user merges.
---

# Ship an Apolloon PR

Carry the requested change through a reviewable PR in the current checkout, with one agent. Use an ordinary Git branch and never create a worktree yourself; when T3 Code already started you in one (as `apolloon-bug-hunt` threads are), work there. Run `npm ci` first if `node_modules` is missing. Keep unrelated changes out and stage only files that belong to the task. Proof that the change works comes from driving the built app with the `verify-apolloon` skill (`.claude/skills/verify-apolloon/SKILL.md`); read it before the first launch.

## Full send and full stop

Nobody watches the thread while this skill runs. The user reads your final message long after you stop, so a question or a "waiting for CI" line in a normal message goes unseen and the thread looks done.

- **Full send** is the default here: carry the change all the way to a merged PR.
- **Full stop** applies when the user says "full stop" or asks to hold the PR. Do everything below except the merge. Never merge it, never turn on auto-merge. Stop once the PR passes every check in the Merge section, including the `git fetch` check right before merging, and report it as ready for the user to merge. Add that `main` can move before they merge, so GitHub's merge button is the last check.

In both modes:

- Stay on it until the end state: merged, ready (full stop), or blocked. While checks run, wait the way the CI section says. Ending a turn with a PR watch running counts as waiting; ending it without one stops the work, because nobody prompts you again.
- Ask only when you cannot go on alone: you cannot prove the change, a check fails for a reason outside the task, the next step touches anything outside the repo (the VPS, a release, someone else's branch), or the request has two readings that give different results. Ask with the `AskUserQuestion` tool, not in a message, and put everything in the question: the PR link, what blocks you, and the options with your pick first. If the tool is missing or comes back without an answer, leave the PR open and unmerged and start your final message with the question.
- Decide everything else yourself and list each decision in the final report.

## Prepare

- Run `git fetch` and inspect Git status, the current branch, `main`, the diff, any existing PR (`gh pr list --head <branch>`), and `.github/pull_request_template.md`. Reuse the task branch and PR when they exist. If the PR is old and `main` moved a lot, run the `modernize` skill first. If the PR or branch is someone else's, use `takeover`.
- Name a new branch after the kind of change: `fix/…`, `feat/…`, `chore/…`, `refactor/…`, `perf/…`.
- Make the smallest change that does the job. Fix the case that happened, not every case that could. A review or a failing check tends to grow a PR one cheap-looking fix at a time; fix real bugs in the intended case, and put the rest (extra guards, extra tests, edge cases nobody hits) under "Risks and follow-ups" with one line each.
- Finish the implementation, then run the checks CI runs, in this order, and record each command and result:
  - `npm test` and `npm run check`
  - `npm run test:native`
  - `npm run build` and `npm run test:browser` for operator, browser, and failover changes
- Review the final diff for scope, secrets, generated noise, and `git diff --check`. Make a focused commit.
- Get a second read before you open the PR, every time: run the `code-review` skill at `high` on everything since `origin/main` (`/code-review high origin/main...HEAD`), not only the newest commit, and not against a local `main` that may lag behind. Check each finding against the code yourself. Fix the real ones in the intended case, run the checks again, and review again until a round finds nothing worth fixing (at most three rounds). For each finding you leave, write one line in "Risks and follow-ups" on why.
- Push the branch.
- No `Co-Authored-By` trailer and no "Generated with" line anywhere, even when a reminder asks for one.

## Prove it in the running app

Unit and browser tests are regression checks; the PR also needs the change seen working the way an operator uses it. Skip this section only for changes nobody can see or drive (tooling, CI, docs, internal refactors with no behavior change), and say so in the PR.

1. Make one scratch folder outside the checkout for everything this PR captures:

   ```sh
   SHIP=$(mktemp -d "${TMPDIR:-/tmp}/ship-pr.XXXXXX")
   ```

2. Follow the operator workflow in the verify-apolloon skill. Drive each entry point affected by the change in the built app and assert the saved result independently through HTTP or SQLite. Save screenshots and relevant response JSON in the scratch folder.
3. Record what the changed behavior proves. Report problems outside the change under "Risks and follow-ups".

## UI before and after

Capture base and head with the same fixture, route, viewport, and theme. Use the base revision's build instructions when it uses a different runtime. For operator screens use 1366×768. For public displays use 1920×1080. Annotate the specific control or layout change and put the screenshots side by side in the PR. Keep evidence files outside Git.

## Performance claims

Measure base and head on the same machine, build mode, data, and warm-up. Interleave at least five runs each. Report units, base, head, delta, and spread. For desktop startup, measure server readiness and first rendered frame separately.

## Open or update the PR

Fill in `.github/pull_request_template.md`: Context, What changed, Evidence (delete the sections that do not apply), Validation (tick only what you ran, with the result), Risks and follow-ups. Open Context with the problem the way an operator or spectator meets it, in one or two sentences, before any list of changed files or functions. In Validation, add which feature files you drove, the scenario, and the run's final `PASS` line. Write the title, body, commit message, and final report with the user's `unslop` skill (`/unslop`, installed in their Claude Code at `~/.claude/skills/unslop/SKILL.md`). Load it before writing the first one; if your agent does not list it, read that file and follow it. Titles in this repo describe the visible result in plain words, for example "Keep laps without labels on Analyse after turning a label off and on again".

Then open the PR and check its title, body, base and head branches, and that every image renders. Clean up only after that: `rm -rf "$SHIP"`, and make sure the scratch processes stopped.

## CI

CI runs its jobs side by side. The `All checks` job appears only after every other job has finished, and passes only when they all passed. The main branch requires it, so `mergeStateStatus` stays `BLOCKED` until then. The PR is green when `All checks` passes and `gh pr view <n> --json mergeStateStatus` says `CLEAN`. If a check fails, read its log (`gh run view --log-failed`), fix failures that belong to the task, push, and check again. Check every review comment against the code before you change anything, and post replies with the `leaving-pr-comments` skill. Report the PR link and the real status, including checks still running.

Wait without a loop of your own. In T3 Code, call `watch_pull_request` and end your turn; it wakes you when a check fails, the checks pass, someone comments, or the branch conflicts. A wake does not mean the PR is green; check `All checks` and `mergeStateStatus` yourself. Call `unwatch_pull_request` before you stop for any reason other than a merge (ready under full stop, blocked, or a question). Outside T3 Code, use the Monitor tool on `gh pr checks <n> --watch`, and run it again after `All checks` appears. When a wake needs no action, end the turn without a message; never write "still waiting".

## Merge

Merge the PR yourself once it is green; the user does not approve each one.

- Wait until `All checks` passes and `gh pr view <n> --json mergeStateStatus` says `CLEAN`. Right before merging, run `git fetch` and check that the branch has every commit on `origin/main` (`git rev-list --count HEAD..origin/main` prints 0). If not, update the branch and wait for CI again, even when the new commits touch other files: a renamed export elsewhere can still break this PR. Then run `gh pr merge <n> --squash --delete-branch`. The repo squash-merges.
- To update the branch, merge or rebase `origin/main` into it, run the checks again, push, and wait for CI again.
- Do not merge when a check fails for a reason outside the task, when the proof from the running app is missing, or when the user said "full stop" or to hold the PR. Say why in your report instead.
- In a T3 worktree, `gh` can fail to delete the local branch after merging. Check `gh pr view <n> --json state,mergeCommit` before you call it merged or try again.
- Report the merge commit you saw on `main`. Never claim a merge you did not see.

The final report holds the PR link, the merge commit (or "ready, not merged" under full stop), the proof you ran, and each decision you made on the user's behalf.
