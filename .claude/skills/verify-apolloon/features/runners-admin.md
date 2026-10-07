# Beheer › Lopers

Beheer › Lopers lists every runner with their status, registration hours, source, labels, and laps. The operator searches the list, filters it by an hour the runner can run, adds a runner by hand, opens a profile, and removes runners without laps.

## Sub-features

- `runners-search` filters the list with the `Lopers zoeken` textbox.
- `runners-hour-filter` keeps the runners free during one event hour, picked in the `Beschikbaar tijdens` select. A form block like `12-14u (woensdag)` counts for both `12-13u` and `13-14u`.
- `runners-new` adds a runner with `Nieuwe loper`, including hours from the hours picker.
- `runners-profile` opens a runner's profile with `Profiel`.

## How to get to it (user POV)

- Sidebar link `Beheer`, then the `Lopers` tab, or open `/admin?section=runners`.
- The `Nieuwe loper` button at the top of the panel.

## Driving it with drive.mjs

Preconditions:

- `--scenario=empty` for the hour filter, with runners imported in setup through `run.rpc().runners.importCsv.mutate({ csvText })`. The CSV needs the columns `Tijdstempel`, `E-mailadres`, `Naam`, and `Ik ben volgende uren beschikbaar`.

- **Open.** `await page.goto(run.url('/admin?section=runners'))`. The heading `Lopers beheren` is visible.
- **New runner.** Click `page.getByRole('button', { name: 'Nieuwe loper', exact: true })`. In `page.getByRole('dialog', { name: 'Nieuwe loper' })` fill `getByLabel('Naam')`, open `getByText('Contact en beschikbaarheid')`, and click hour buttons such as `getByRole('button', { name: '12-13u (woensdag)', exact: true })`. Click `Loper toevoegen`; the dialog closes and `Loper toegevoegd.` appears. The runner is in `/api/state`.
- **Hour filter.** `page.getByRole('combobox', { name: 'Beschikbaar tijdens', exact: true }).selectOption('12-13u (woensdag)')`. Wait for `page.getByRole('status').filter({ hasText: 'voor 12-13u (woensdag)' })`, then read `page.getByRole('row').allInnerTexts()`.
- **Search.** Fill `page.getByRole('textbox', { name: 'Lopers zoeken' })`; only matching rows stay.
- **Proof.** `run.proof(page, 'runners-…')` after each filter change.

## Gotchas

- The hour select lists one-hour slots in event order (Tuesday 20:00 onward), and only the slots some runner covers. It never offers the form's two-hour blocks.
- More than one element has role `status` (the count line and the `Loper toegevoegd.` notice). Filter by text.
