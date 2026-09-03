# Kobe's tactiek

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
  timing export. Team 1 and team 4 are the defaults for Apolloon and VTK.

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
the remaining hours with the edited schedule.

Live laps outside the configurable realistic duration range are shown for
operator review but excluded from tactical calculations.
