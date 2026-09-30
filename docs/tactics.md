# Tactiek

`/tactics` is the strategy workspace inspired by
[`koberypens/TacticalAnalysis`](https://github.com/koberypens/TacticalAnalysis).
It is implemented in the Apolloon client so the event build needs no Python
runtime, separate Streamlit process, internet connection, or manual live-data
export.

## Two sections

- **Live race & doelverloop** reads the full race history through
  `useRaceHistory({ scope: 'full' })`. Socket.IO patches that query whenever a
  lap is added, deleted, or corrected, so every projection uses the same live
  data as the timing screens.
- **Analyse vorig jaar** compares two teams from the official historical
  timing export. Team 1 and team 4 are the defaults for Apolloon and VTK. It
  includes an all-team ranking, raw lap timelines, pace and distribution
  comparisons, race-lead analysis, diagnostics, break-even scenarios, and the
  statistical drafting analysis from the source project.

The live section derives the race start from Apolloon's race state. It never
asks for `laps.json` and does not maintain a second copy of the current race.

## Historical reference data

The bundled `public/reference/quivr-2025-lap-times.json` export is the default
reference and is included automatically in Vite and Electron builds. A future
edition can be selected in the interface without changing the application.

The organiser export is expected to contain cumulative lap completion times in
milliseconds since the race start:

```json
[
  { "teamId": 1, "lapTimes": [104000, 208500, 313200] },
  { "teamId": 4, "lapTimes": [106000, 212700, 319100] }
]
```

An optional `teamName` per entry is shown in place of the number; entries
without one appear as "Team <id>". The organiser export only contains numbers,
so the bundled 2025 file has the names added from the official 24urenloop.be
ranking. Quivr reuses team numbers between editions, but not always for the
same team (number 20 was Project Unseen in 2025 and Auxilium in 2026), so a new
edition's names belong in its own file.

An object with the list under a `teams` property is accepted as well. The file
is validated before use and stored in browser-local storage after the first
selection. A replacement therefore survives application restarts on that
laptop and is automatically shared by both tactics sections. Resetting it falls
back to the bundled Quivr 2025 data. The current race always remains
server-owned and realtime.

The Quivr export can also contain `correctionTimes`; those metadata do not
replace completed laps and are ignored, matching the source analysis. Exact
duplicate lap timestamps are collapsed before pace calculations.

## Scenario model

The operator selects a 24-hour lap target and one of three starting profiles:

- a constant pace;
- Apolloon's hourly median pace shape from the historical reference;
- VTK's hourly median pace shape from the historical reference.

A historical profile is scaled to the selected total while retaining its
hour-by-hour shape. Every hourly pace remains editable. The page then compares
completed laps with the target count at the current race moment and projects
the remaining hours with the edited schedule. The selected target, profile,
and all 24 hourly paces are saved locally and restored after an application
restart. The projection also shows an optimistic and pessimistic range based
on the spread of the most recent valid laps.

Live laps outside the configurable realistic duration range are shown for
operator review but excluded from tactical calculations.

## Source parity and native replacements

The React implementation keeps the decision-making capabilities from the
Streamlit project, but does not embed or run its Python UI. The historical
workspace contains these five groups:

- **Alle teams**: ranking and dispersion for all teams, a selectable raw lap
  timeline with a rolling 20-lap median, and a selected-team frequency chart.
- **Tempo A vs. B**: quarter-hour pace, smoothed trend, half-hour difference,
  configurable-window frequency and outliers, hourly P10/P90 consistency,
  standard deviation, and configurable night penalty.
- **Raceverloop**: estimated time gap, same-lap-index gap, hourly gains,
  cumulative laps, leader changes, and distance difference.
- **Diagnostiek**: slow laps, sudden pace changes, their exact race moments,
  a break-even calculation, and sensitivity projection.
- **Volgeffect**: passage scatter and trend, proximity bins, chasing/leading
  comparisons, and a tie-corrected Wilcoxon rank-sum significance test.

Some presentation and input mechanisms are intentionally native:

- The original live `laps.json` upload and manual start-time field are replaced
  by Apolloon's full-history API, race state, and Socket.IO cache patches.
- The historical Quivr export is bundled and can still be replaced through the
  file picker. It is shared by historical and live comparisons.
- A CSV schedule import is replaced by the editable 24-hour schedule with
  automatic local persistence. This avoids a second file workflow during the
  event while preserving custom targets between restarts.
- The original 21 simultaneous small plots are represented by the all-team
  table plus a selectable detailed timeline. This retains every team while
  keeping the Electron page responsive on the race laptop.
- Quarter trends use robust medians rather than mean/SEM bands so an invalid
  timing passage cannot pull a short interval as strongly. Suspicious live laps
  are also visible separately instead of silently disappearing.
