# Kobe tactics deep-dive evidence

## Comparison setup

- Route: `/tactics`
- Desktop viewport: 1440 x 1000 at device scale 1
- Mobile viewport: 390 x 844 at device scale 1
- Reference data: bundled Quivr 2025 export, team 1 versus team 4
- Live data: the same local Apolloon API snapshot in both captures
- Before revision: `e399120`
- After revision: `bb6bae9`
- Browser: headless Chromium through the repository Playwright dependency

Both revisions were served from the same checkout and local development
server. Every after-state was checked for uncaught page errors, non-finite text,
and horizontal document overflow. No page errors or desktop overflow were
observed. The 390 px view also has no horizontal document overflow.

## Before and after

| State | Before | After |
| --- | --- | --- |
| Live tactics | [live-before.png](./live-before.png) | [live-after.png](./live-after.png) |
| Historical landing | [historical-before.png](./historical-before.png) | [historical-after.png](./historical-after.png) |

The historical after-state adds navigation to the five analysis groups, an
all-team ranking, a selectable raw lap timeline, and frequency distribution.
The live after-state adds uncertainty bounds, a recent-pace projection, a
quarter-hour trend, predicted VTK time gap, persistent target settings, and a
complete suspicious-lap review.

## Added analysis paths

- [Tempo A vs. B](./tempo-after.png)
- [Raceverloop](./race-after.png)
- [Diagnostiek](./diagnostics-after.png)
- [Volgeffect](./drafting-after.png)
- [Historical landing at 390 px](./historical-mobile-after.png)

These captures cover each new navigation path. Controls and charts use the
same source data and team selection, so differences between views are caused
by the selected analysis rather than a different fixture.
