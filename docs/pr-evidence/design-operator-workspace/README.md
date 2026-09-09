# Laptop workspace redesign

The current review screenshots are in [layout/](layout/). They compare the first dark-theme revision (`c1a34be`) with the structural redesign, so the difference in layout is visible without the colour change obscuring it. The older images in this directory document the initial light-to-dark pass.

## Telsysteem 1

- Current and next runner sit beside the page title.
- Two independently scrolling working lists replace the three equal card columns: Opwarming and Klaar om te lopen.
- Runner rows expose profile access, a dedicated drag handle, elapsed time and direct status actions. Waiting rows also have a move-one-place-forward button. Queue positions reflect the full queue even when the board is filtered.
- Heeft gelopen is an expandable secondary list. Return-to-warmup, hiding and revealing runners remain available.
- Lookup searches every runner and shows their current status. Activation appears only for registered/completed runners. Enter activates only a single matching eligible runner after a nonempty search.
- New-runner entry prioritizes identification and labels. Targets, historical times and notes are in an expandable section; all existing fields remain available.

## Telsysteem 2

The current runner, large timer, next-action preview and handoff button form one timing station. The right side shows the next five runners and a compact, scrolling log of the latest ten laps. Race statistics sit below the action, and race termination remains separately placed with its original confirmations.

Space/Enter behaviour, exactly-once mutation handling, undo, controller ownership, takeover checks and conflict blocking are retained. The button now describes the action rather than using the term handoff.

## Analysis, tactics and administration

- Analyse has a persistent filter column, summary numbers first, and separate Wedstrijd, Lopers and Ploegen sections. Filters and page-level search/sort settings survive switching sections. Downloads are directly available in the filter column and explicitly describe their full-race scope.
- Live tactics puts the forecast beside the scenario inputs. The hourly editor and detailed trends/round checks are expandable. Historical research remains separate and its calculations are unchanged.
- Beheer has Voorbereiding, Lopers, Ploegen & labels, Publiek and Systeem & herstel sections. Hidden sections stay mounted to preserve unfinished forms. Labels use editing rows instead of surrounding cards. A system-attention shortcut remains visible outside the recovery section.
- Start remains a navigation page. Public display layouts remain unchanged. This iteration targets laptops, not phones.

## Evidence conditions

- Baseline: `c1a34be1ccd0ee58ffab334c8ba998d1d3f43031`, served from an archive of tracked source.
- Both versions use the same disposable `live` seed: 60 runners, 8 labels, 35 laps, Fien Goossens active and Tuur Hermans next.
- Headless Chromium, 1440 x 900 viewport, default filters, scroll position zero. `*-full.png` additionally shows content below the first viewport. Secondary-section captures show the named section selected. Runner dialogs are shown open.
- Live timers and backup ages can advance between captures. These are visual comparisons, not performance measurements.
- Queue and timing interactions were also checked at 1280 x 800. No mobile screenshots were added for this revision.

## Validation

- `npm test`: 58 passed.
- `npm run check`: TypeScript, production client build and existing bundle budget passed.
- `npm run test:e2e`: 23 passed.
- Headless browser: queue, timing, analysis, tactics and administration load without page errors or horizontal overflow at the captured desktop width.
- Functional browser checks at 1280 x 800: completed-list access in the viewport; lookup across states; ambiguous Enter leaves runner statuses unchanged; profile access independent of dragging; queue position under filtering; move-earlier action; direct status change; pointer drag between lists; completed-runner return; unfinished label fields retained across sections; shared analysis filters; hourly editor and expanded chart rendering; Space handoff; confirmed undo; finish-dialog cancellation.
- Additional arrival checks passed: Enter activates one eligible exact match, and the shorter new-runner form creates a runner directly in warming up.
- Browser checks use only a disposable local database. No production changes, new browser-test dependencies, or permanent test harness.

## Review limits

The screenshots and checks establish layout and functional behaviour, not a measured improvement in volunteer task times. Network-failure/takeover states and populated temporary-team management were not newly exercised in the browser; the existing runtime tests cover the underlying safeguards. Long names, large event rosters and real volunteer use can still warrant layout adjustments. The operator theme remains dark. No merge or deployment is included.
