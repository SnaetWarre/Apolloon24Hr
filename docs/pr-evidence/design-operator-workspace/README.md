# Operator workspace refresh

The operator screens now use a charcoal canvas, layered neutral surfaces and Apolloon blue for actions. Navigation names the job (Wachtrij, Timing, Beheer), and the start page gives the two race operator roles priority. Kobe's tactiek is also reachable directly from the start page.

The board filter has a persistent, accessible label. Runner activation and creation sit together, with backup/replication status in its own row. Timing retains its current/next runner pairing and wide handoff control. Mobile timing cards shed their desktop minimum height so controls follow the runner information sooner. Focus rings, a skip link, and announced timing action feedback support keyboard and assistive technology use.

## Workflow review

These are design proposals for discussion, not implemented workflow changes. No operator observation or task completion benchmark was performed, so the benefits below are hypotheses based on the code and rendered screens.

| Priority | Current friction | Proposed follow-up | Decision needed |
|---|---|---|---|
| 1 | Admin mixes readiness, recovery, import, labels and the runner database on one long page. The readiness checklist reports problems but doesn't guide the full preparation sequence. | A pre-race preparation view ordered around import, labels, verified backup, replica and timing ownership. Keep recovery tools directly reachable during the race. | Should preparation be an optional checklist or gate entry into timing? I favour an optional checklist initially. |
| 2 | The board filter only sees board runners, while Loper zoeken opens runners outside the active queue/warmup flow. A volunteer needs to know which search to use. | One runner lookup with explicit current status and contextual actions, while keeping a local board filter. | Agree exactly which actions appear for registered, warming, waiting, running and completed runners; prevent accidental duplicate activation. This PR only clarifies the filter label. |
| 3 | A long warming-up column precedes the waiting column on mobile. Reaching the next waiting runner requires considerable scrolling. | Mobile column tabs with counts and an always-visible current/next summary. Desktop keeps all columns visible. | Is mobile primarily for lookup or active queue management? Tabs trade simultaneous visibility for reachability. |
| 4 | Timing uses a dedicated Space/Enter shortcut, undo confirmation, two-step finish confirmation and controller ownership checks. These carry race-safety meaning. | Observe a volunteer handoff session before changing the interaction. Consider clearer ownership context near the handoff control. | Keep shortcut behaviour and safety confirmations unless event operators explicitly agree to a change. |

## Capture conditions

- Baseline: `b317ade`, rendered from an archive of tracked source files.
- Updated version: the source changes in this PR.
- Both versions use the same disposable local API and `live` seed: 60 runners, 8 labels, 35 laps, Fien Goossens active and Tuur Hermans next. No production database is involved.
- Chromium headless, 1440 x 1000 desktop and 390 x 844 mobile; full-page captures begin at scroll position zero. Search is the open activation dialog. Historical tactics uses the bundled default comparison.
- Race records and filters match. Live clocks and backup ages can differ because the app synchronizes its clock against the server; screenshots are not timing measurements.
- Public display routes retain their light palette. No chart calculations, queue mutations, shortcuts, timing ownership, persistence or replication logic changed.

## Validation

- `npm test`: 58 passed.
- `npm run check`: TypeScript, production client build and existing client budget passed.
- `npm run test:e2e`: 23 passed, including the existing cluster/runtime tests.
- Headless browser: all six operator routes and five mobile routes loaded without page errors or page-level horizontal overflow.
- Interaction checks passed: filter board to one runner and clear it; keyboard focus and computed hover styling; open/close runner lookup with Escape; navigate to tactics from the start page; open historical analysis; dismiss race-finish confirmation with Escape; follow the skip link to main content; verify both public displays still inherit the light palette.
- No new testing dependencies or permanent browser harness. No performance improvement is claimed.

## Limits

This is a fixed dark operator theme. A light/daylight alternative would be a separate product choice. The visual review covers the routes and dialog shown here, not every possible administrative modal, network-failure state, or historical analysis tab. Existing recovery safeguards remain in place. No deployment or merge is included.
