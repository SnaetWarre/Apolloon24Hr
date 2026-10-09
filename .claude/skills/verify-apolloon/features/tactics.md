# Tactiek

Tactiek (`/tactics`) plans the race against a lap target. The `Live race & doelverloop` section takes a goal (`Rondes na 24 uur`), decides which laps count as valid (`Rondes voor huidig tempo`, `Kortste (s)`, `Langste (s)`), and lets the operator change the target pace for each race hour. `Analyse vorig jaar` compares two teams from last year's race. Every number field keeps what the operator types; a value outside the allowed range is corrected when the field loses focus or on Enter, and an empty field falls back to its last value.

## Sub-features

- `tactics-goal` sets `Rondes na 24 uur` (at least 1) and stores it in localStorage under `apolloon.kobe-tactics.scenario.v1` as `targetLaps`.
- `tactics-valid-laps` sets `Rondes voor huidig tempo` (5 to 100), `Kortste (s)` (10 to `Langste`), and `Langste (s)` (`Kortste` to 300).
- `tactics-hourly-pace` sets the target pace per race hour (30 to 300 s) under the `Doeltempo per uur aanpassen` fold-out, stored as `targetPaces`.
- `tactics-historical-charts` covers the two scatter charts in `Analyse vorig jaar` that draw a line over their dots. On `Alle teams`, the panel `Alle passages van <team>` shows a dark line for `Lopende mediaan (20)` that follows the blue dots. On `Volgeffect`, the panel `Rondetijd volgens positie tegenover de andere ploeg` shows two straight lines across the chart, `Trend Apolloon` in blue and `Trend VTK` in orange. A legend entry without its line is the bug.
- `tactics-historical-fields` covers the number fields in `Analyse vorig jaar`, such as `Trage ronde vanaf` (10 to 300) under `Diagnostiek` and the `Rondelengte` in meters under `Raceverloop`.

## How to get to it (user POV)

- Sidebar `Tactiek` (`/tactics`). The `Live race & doelverloop` section is open by default.
- The `Analyse vorig jaar` button in the `Tactiekonderdeel` navigation, then one of its sub-tabs (`Diagnostiek`, `Raceverloop`, and others). It uses the bundled `Quivr 2025` race unless a file was loaded.

## Driving it with drive.mjs

Preconditions:

- A run with `--scenario=live`. Without a running race the live section does not show its fields.

- **Open the page.** `await page.goto(run.url('/tactics'))`, then wait for `page.getByText('Geldige rondes')`.
- **Type a value.** Click the field (`page.getByLabel('Kortste (s)')`, `page.getByLabel('Langste (s)')`, `page.getByLabel('Rondes voor huidig tempo')`, `page.getByLabel(/^Rondes na 24 uur/)`), press `Control+A`, type with `page.keyboard.type('60', { delay: 80 })`, and press `Tab`. `field.inputValue()` is exactly what was typed.
- **Out of range.** Typing `5` into `Kortste (s)` and pressing `Tab` shows `10`; typing `400` into `Langste (s)` and pressing `Enter` shows `300`.
- **Clear a field.** `Control+A` then `Backspace` leaves the field empty while it has focus; `Tab` brings back the last value.
- **Hourly pace.** Click the text `Doeltempo per uur aanpassen`, then type into `page.locator('.tactics-hourly-grid input').first()`.
- **Stored scenario.** `JSON.parse(localStorage.getItem('apolloon.kobe-tactics.scenario.v1'))` has the typed `targetLaps` and `targetPaces[0]`.
- **Analyse vorig jaar.** `page.getByRole('button', { name: 'Analyse vorig jaar', exact: true })`, then `page.getByRole('button', { name: /^Diagnostiek/ })` for `page.getByLabel('Trage ronde vanaf')`, or `/^Raceverloop/` for `page.locator('.tactics-stat--control input')` (the lap length). After typing `400` there, the stat reads `400 meter per ronde`.
- **Chart lines.** Click `page.getByRole('button', { name: /^Alle teams/ })` or `/^Volgeffect/`, then find the chart with `page.locator('section.panel', { has: page.getByText(<panel title>) }).locator('canvas')`. Chart.js is bundled, so `Chart.getChart` is out of reach. Instead, wrap `CanvasRenderingContext2D.prototype.stroke` in `page.addInitScript` and record the `strokeStyle` of every stroke that gets a `Path2D` whose coordinates are all finite (see `scripts/validation/tactics-ui.mjs`). The median chart has one such color and the Volgeffect chart has two. Take an element screenshot of the panel to show the lines.
- **Proof.** `run.proof(page, 'tactics-…')` before and after typing. Nothing goes to the server, so `/api/state` does not change; the localStorage scenario is the side effect.

## Gotchas

- Type with the real keyboard. `fill()` sets the whole value at once and hides a field that changes the value on each key press.
- The sub-tab buttons in `Analyse vorig jaar` carry a second line of text, so match their names with a regular expression.
- `getByText('400 meter per ronde')` also matches a chart description; pass `exact: true`.
- In a `type: 'scatter'` chart, `showLine: true` with `tension` draws nothing: the scatter controller never computes the curve points, so every segment gets empty coordinates. A line dataset there needs `type: 'line'`. The stroke still happens, which is why the check above skips paths with missing coordinates.
- `scripts/validation/tactics-ui.mjs` (part of `npm run test:ui`) covers these fields and the chart lines.
