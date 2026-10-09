# Beheer › Lopers

Beheer › Lopers lists every runner with their status, registration hours, source, labels, and laps. The operator searches the list, filters it by an hour the runner can run, adds a runner by hand, opens a profile, and removes runners without laps.

## Sub-features

- `runners-search` filters the list with the `Lopers zoeken` textbox, on number, name, labels, the Dutch status and source shown in the table (`Ingeschreven`, `Manueel`, `verborgen`), and the hours, including each one-hour slot inside a form block (`13-14u` finds `12-14u (woensdag)`).
- `runners-hour-filter` keeps the runners free during one event hour, picked in the `Beschikbaar tijdens` select. A form block like `12-14u (woensdag)` counts for both `12-13u` and `13-14u`.
- `runners-show-more` lists the first 150 matching runners, with `· eerste 150 getoond` in the count line. The `Toon de volgende N lopers` button under the table adds the next 150 each time. A new search or hour filter goes back to the first 150.
- `runners-new` adds a runner with `Nieuwe loper`, including hours from the hours picker. It is the same dialog as in Wachtrij, so the cursor starts in `Lopersnummer` and follows each fold-out opened (see `queue-autofocus`).
- `runners-profile` opens a runner's profile with `Profiel`.
- `runners-delete` removes a runner without laps with `Verwijder` and `Definitief verwijderen`.

## How to get to it (user POV)

- Sidebar link `Beheer`, then the `Lopers` tab, or open `/admin?section=runners`.
- The `Nieuwe loper` button at the top of the panel.

## Driving it with drive.mjs

Preconditions:

- A run with `--scenario=ready`. Its runners have one-hour blocks, so the hour filter works without setup.
- For a two-hour block such as `12-14u (woensdag)`, import a form row in setup: `run.rpc().runners.importCsv.mutate({ csvText: 'Tijdstempel,E-mailadres,Naam,Ik ben volgende uren beschikbaar\n1/1/2026,blok@example.be,Blok Tester,12-14u (woensdag)\n' })`.

- **Open.** `await page.goto(run.url('/admin?section=runners'))`. The heading `Lopers beheren` is visible.
- **New runner.** Click `page.getByRole('button', { name: 'Nieuwe loper', exact: true })`. In `page.getByRole('dialog', { name: 'Nieuwe loper' })` fill `getByLabel('Naam')`, open `getByText('Contact en beschikbaarheid')`, and click hour buttons such as `getByRole('button', { name: '12-13u (woensdag)', exact: true })`. Click `Loper toevoegen`; the dialog closes and `Loper toegevoegd.` appears. The runner is in `/api/state` with `registrationSource: 'manual'` and `status: 'registered'`. Its hours are not in `/api/state`; read them in `/api/registrations[<id>].availableHours`.
- **Hour filter.** `page.getByRole('combobox', { name: 'Beschikbaar tijdens', exact: true }).selectOption('12-13u (woensdag)')`. Wait for `page.getByRole('status').filter({ hasText: 'voor 12-13u (woensdag)' })`, then read `page.getByRole('row').allInnerTexts()`.
- **Search.** Fill `page.getByRole('textbox', { name: 'Lopers zoeken' })`; only matching rows stay. `Manueel` keeps only runners added by hand; `Ingeschreven` makes the count line read `N lopers gevonden · Ingeschreven: N`.
- **Show more.** Import 180 runners in setup with free numbers (the `ready` runners use 101 to 140): `run.rpc().runners.importCsv.mutate({ csvText: 'runner_number,name\n1001,Bulk 1001\n…1180,Bulk 1180\n' })`. With the 40 seeded runners that makes 220, so the count line reads `220 lopers gevonden · eerste 150 getoond` and the button is `Toon de volgende 70 lopers` (the total minus 150). Click it: all 220 rows are listed and the count line no longer says `getoond`.
- **Profile.** In a row click `Profiel`; dialog `Lopersprofiel` opens. Wait until its `Naam` field holds the runner's name before pressing Escape (see `queue.md`, Gotchas).
- **Delete.** In the row of a runner without laps click `Verwijder`, then `Definitief verwijderen` in dialog `<naam> definitief verwijderen?`. The text `<naam> is definitief verwijderd.` appears and the runner is gone from `/api/state`.
- **Proof.** `run.proof(page, 'runners-…')` after each filter change.

## Gotchas

- The hour select lists one-hour slots in event order (Tuesday 20:00 onward), and only the slots some runner covers. It never offers the form's two-hour blocks.
- More than one element has role `status` (the count line and the `Loper toegevoegd.` notice). Filter by text.
