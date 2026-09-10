# Core workflow audit, 10 September 2026

Reviewed the queue-to-timing flow, timing keyboard handling, race closure,
runner profile editing, and recent-history presentation against the current
queue redesign.

## Confirmed issues fixed

| Issue | Operator impact | Change |
| --- | --- | --- |
| Space/Enter could resume an already finished race | An accidental timing key could start another queued runner after definitive closure | Finished races ignore global timing shortcuts; the resume button requires confirmation |
| Handoff feedback assumed a next runner started | Clocking the last queued runner falsely reported that another runner was active | Feedback uses the server's actual lap and started-runner result |
| Start action remained enabled with nobody ready | An impossible action produced the backend `empty_queue` error | Disable the empty-queue start action and label it clearly |
| Previous lap was searched only in the latest 250 race laps | Returning runners incorrectly appeared to have no previous lap | Query the active runner's history separately from the latest ten race laps |
| Remote profile updates reset all open form inputs | Another laptop could silently erase unsaved typing | Track the draft's baseline, preserve dirty drafts, and block saving a known stale profile until the operator explicitly reloads it; clean drafts still refresh |
| History failure appeared as an empty race | An unavailable history request looked like no laps had been recorded | Distinguish loading, failure, and empty history; provide a retry action |
| Modified Enter/Space triggered global timing | Keyboard combinations intended for another purpose could record a handoff | Ignore modified, composing, and already-consumed keyboard events |

## Validation

- `npm test`: 58 passed.
- `npm run test:e2e`: 23 passed, including production build and cluster/runtime checks.
- `npm run check`: client/server type checking and production client build.
- `scripts/validation/workflow-ui.mjs`: headless Chromium against a disposable ready-seeded server. Covers empty-queue controls, modified shortcuts, final-runner feedback, closure and confirmed resumption, remote edits with dirty/clean drafts, a previous lap older than 250 intervening laps, and HTTP 503 history failures.

To repeat the browser checks, seed a disposable path using
`scripts/seed-test-db.mjs --scenario=ready --data-path=.test-data/workflow-audit`,
build, and start the compiled server with that `DATA_PATH`, `CLUSTER_ENABLED=false`,
and a dedicated port. Set `APOLLOON_TEST_URL` to that localhost server and supply
`PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE` if Playwright is not installed normally.
The script changes that server's runners and race, and requires a fresh seed.

## Boundaries

These are client workflow fixes. The profile conflict check protects drafts
against updates already observed by the client; it is not server-side optimistic
concurrency control for simultaneous saves. The resume confirmation applies to
the updated timing screen, not older clients or direct API callers. Production
was not changed. This pass does not establish that every administration,
import, accessibility, or recovery workflow is issue-free.

## Check-in workflow follow-up

- Exact bib numbers take priority over partial number, name, and label matches.
  For example, entering `10` selects bib 10 even when bibs 101 through 109 exist.
  If several runners have that exact number, Enter still refuses an ambiguous selection.
- Optional `Meerdere lopers aanmelden` keeps the search open after activation,
  announces the runner added, clears the query, and restores input focus.
  The default single-runner flow still closes after activation.
- Successful activation or creation clears the board filter so the newly warming
  runner is visible. Cancelling the form leaves the filter intact. A visible
  `Filter wissen` button also clears the filter manually.
- Browser regression coverage now includes exact-number disambiguation, two
  consecutive keyboard check-ins, focus restoration, and automatic/manual
  filter clearing.
