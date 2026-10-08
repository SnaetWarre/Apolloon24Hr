# Analyse › Grafieken

The `Wedstrijd` tab in Analyse shows charts of the laps in the current label selection. When a chart has nothing to draw, it says why: `Geen rondes binnen deze selectie.` while at least one label is on, and `Zet minstens een ploeg aan om de grafiek te tonen.` only on `Rondes en tempo per uur` when every label is off.

## Sub-features

- `analysis-pace-empty` shows `Geen rondes binnen deze selectie.` in `Rondes en tempo per uur` before the first lap or when the labels that are on have no laps, and asks to turn a label on only after `Alles uit`.

## How to get to it (user POV)

- Sidebar `Analyse` (`/analysis`). The `Wedstrijd` tab is open by default; the charts sit below the eight stat tiles.
- The `Labels` panel on the left, with `Alles aan`, `Alles uit`, and one switch per label.

## Driving it with drive.mjs

Preconditions:

- A run with `--scenario=ready`, so every label is on and there are no laps yet.

- **Open the page.** `await page.goto(run.url('/analysis'))`, then wait for `page.locator('section.analysis-pace-panel').getByRole('heading', { name: 'Rondes en tempo per uur' })`.
- **Count the labels that are on.** The switches are buttons, not `role=switch`: `page.locator('.label-toggle-row')` and `.label-toggle-row[aria-pressed="true"]`. On a fresh page every one is on.
- **No laps, labels on.** The pace panel's text includes `Geen rondes binnen deze selectie.` and not `Zet minstens een ploeg aan…`.
- **Every label off.** `page.getByRole('button', { name: 'Alles uit', exact: true }).click()`. The pace panel then shows `Zet minstens een ploeg aan om de grafiek te tonen.`. `Alles aan` brings back `Geen rondes binnen deze selectie.`.
- **Proof.** `run.proof(page, 'analysis-pace-empty-…')` before and after each click.

## Gotchas

- The label filter lives in the page only. A reload turns every label back on.
- `Alles uit` hides unlabeled laps too, so in a `live` run every chart is empty after it.
