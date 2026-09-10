# Operator interface refinement

## Brief and review

Apolloon supports volunteers running the Leuven 24 urenloop: checking runners in,
organising the exchange zone, recording laps and deciding race strategy. Review
the current application at `f22a6a5`, building on its existing task layouts.
The requested emphasis is the operator application, excluding buitenscherm.

Current rendered screens show three opportunities:

- Start fills more than a laptop viewport with seven large navigation cards.
- Runner names are only 13px while repeated row actions carry comparable emphasis.
- Long analysis and management pages scroll their filters and navigation out of
  view. Tactics uses a different, oversized section switch.

## Design plan

The direction is a clearly organised race desk. The current runner, next runner
and timing action carry the visual emphasis. Supporting research and setup use
quieter controls and stable navigation.

Core palette: canvas `#191919`, working surface `#222222`, divider `#363636`,
primary text `#eeeeee`, secondary text `#a6a6a6`, action blue `#286bd4`.
Retain the existing semantic warning, success and error colours.

Type: retain the platform sans-serif for familiar, offline rendering and the
Apolloon wordmark as the distinctive brand element. Use 15px runner names, 14px
controls, 12px supporting details, 28-34px page titles and the existing large,
tabular timer. Use weight and alignment before adding colour.

Layout: left-align names, headings and actions; keep numerical positions and
times aligned. Give the two queue lanes and timing station one surface each.
Keep information as rows within these surfaces. Use compact navigation rows for
secondary workspaces and an underlined section switch shared with analysis.

```text
Start                           Operator workspace
Apolloon  Elke ronde telt.       Apolloon   Wachtrij  Timing  Analyse ...
                                Page title              Current / next
[Wachtrij]       [Timing]        [Primary actions]             [Filter]
Analyse en beheer | Schermen     [Opwarming rows] [Ready-to-run rows]
  Analyse         | Binnen      [Completed runners, expandable]
  Kobe's tactiek  | Buiten
  Beheer
Event address and copy action
```

## Review against the brief

A generic dashboard would add coloured summary cards and more icons. This plan
instead keeps the existing race-specific two-lane workflow and timing station.
Surfaces delimit actual working areas; secondary destinations become compact
rows. Keep the current type family rather than adding a decorative font download
to an offline event tool. Preserve direct queue actions, race safeguards and the
existing chart library. Do not convert the binnenscherm into an operator page.

## Verification

- `npm test`: 58 passed.
- `npm run check`: client/server TypeScript, client production build and existing
  client bundle budget passed.
- `npm run test:e2e`: 23 runtime tests passed.
- Existing dialog and workflow browser scripts passed against a separate,
  ready-seeded database. Updated three obsolete timing-button locators in the
  workflow script to match the labels already present on main.
- Browser checks passed for native navigation links, current-page indication,
  filtered queue counts, persistent analysis filters, sticky navigation and
  sidebar access, pointer dragging, direct row actions, profile access, Space
  handoff, confirmed undo and visible keyboard focus with reduced motion.
- Reviewed the six operator routes at 1440px, 1280px and 390px. Main pages and
  management sections have no document-wide horizontal overflow; wide research
  tables retain their own horizontal scrolling. The label editor now stacks its
  fields on narrow screens.
- `git diff --check` passed. No dependency changes, deployment or public-display
  layout changes are included.

The implementation is on branch `design/operator-polish`.

## Screenshots

Before: `f22a6a5`. After: this branch. Headless Chromium, 1440 x 900 viewport,
full-page captures, default page selections, the same existing development
dataset with 60 runners and 35 completed laps. Live timers and derived race
projections advance between captures. These images document layout, not measured
reductions in volunteer task time. Real volunteer use and crowded event rosters
were not tested.

| Screen | Before | After |
| --- | --- | --- |
| Start | [Before](home-before.png) | [After](home-after.png) |
| Wachtrij | [Before](queue-before.png) | [After](queue-after.png) |
| Timing | [Before](timing-before.png) | [After](timing-after.png) |
| Analyse | [Before](analysis-before.png) | [After](analysis-after.png) |
| Kobe's tactiek | [Before](tactics-before.png) | [After](tactics-after.png) |
| Beheer | [Before](admin-before.png) | [After](admin-after.png) |

The narrow label-management state is captured at 390 x 800 before and after in
[admin-labels-mobile-before.png](admin-labels-mobile-before.png) and
[admin-labels-mobile-after.png](admin-labels-mobile-after.png).
