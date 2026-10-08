# Wachtrij

Wachtrij (Telsysteem 1) is the queue desk. Imported runners stay `Ingeschreven` until the desk checks them in to warm-up; from the board the desk moves them between `Opwarming` and `Klaar om te lopen`, and Timing starts the first runner of `Klaar om te lopen`.

## Sub-features

- `queue-checkin` finds an imported runner with `Loper zoeken` and moves them to Opwarming.
- `queue-checkin-many` keeps the search open for several check-ins with `Meerdere lopers aanmelden`.
- `queue-new-runner` creates a runner on the spot with `Nieuwe loper`, straight into Opwarming.
- `queue-move` moves a runner with `Naar wachtrij` (to Klaar om te lopen) and `Opwarmen` (back).
- `queue-filter` filters the board with `Filter dit bord` and clears it with `Filter wissen`.
- `queue-profile` opens a runner's profile by clicking their name on the board.
- `queue-scroll` scrolls the page with the mouse wheel over a lane once that lane is at the end of its list, down to `Nu beschikbaar, nog niet opgeroepen`.

## How to get to it (user POV)

- Sidebar link `Wachtrij`, or open `/queue`.
- The buttons `Loper zoeken` and `Nieuwe loper` in the page header.
- The `Naar Wachtrij` link on Overzicht's `Wisselzone` panel.

## Driving it with drive.mjs

Preconditions:

- A fresh run with `--scenario=ready` (12 in Opwarming, 12 in Klaar om te lopen, the rest Ingeschreven).
- For `queue-checkin`, pick a runner whose `status` in `/api/state` is `registered` and note their `runnerNumber` and `name`.

- **Open.** `await page.goto(run.url('/queue'))`. Regions `page.getByRole('region', { name: 'Opwarming' })` and `page.getByRole('region', { name: 'Klaar om te lopen' })` are visible.
- **Check in.** Click `page.getByRole('button', { name: 'Loper zoeken', exact: true })`, fill `page.getByRole('textbox', { name: 'Zoek op nummer, naam of label', exact: true })` with the runner number, press Enter. The dialog closes and the runner's `status` in `/api/state` is `warming_up`. Enter only checks in when the search has exactly one match, so type the number rather than a name.
- **Check in several.** Before pressing Enter, check `page.getByRole('checkbox', { name: 'Meerdere lopers aanmelden' })`. After Enter the text `<name> staat bij opwarming.` appears, and the search box is empty and keeps focus for the next number. Escape closes the dialog.
- **New runner.** Click `Nieuwe loper`. In `page.getByRole('dialog', { name: 'Nieuwe loper' })` fill textboxes `Lopersnummer` and `Naam`, then click `Toevoegen aan opwarmen`. The runner appears in the Opwarming region and in `/api/state` with status `warming_up`.
- **Move to the queue.** Find the row: `page.locator('.queue-runner').filter({ has: page.locator('button.queue-identity').filter({ hasText: name }) })`. Click its `Naar wachtrij` button. The row appears in `Klaar om te lopen` and the status becomes `waiting`. Its `Opwarmen` button moves it back.
- **Filter.** Fill `page.getByRole('searchbox', { name: 'Filter dit bord' })` with part of a name; only matching rows stay. Click `Filter wissen`; the searchbox is empty.
- **Profile.** Click `button.queue-identity` with the runner's name. Dialog `Lopersprofiel` shows textboxes `Naam` and `Notities` and a `Opslaan` button.
- **Scroll.** Move the mouse to the middle of a lane's region and call `page.mouse.wheel(0, 400)` about 20 times with a short `waitForTimeout(120)` between them, so each turn is a new gesture. `window.scrollY` grows past 0 and the summary `.available-now > summary` comes on screen. Do it over both lanes.
- **Proof.** `run.proof(page, 'queue-…')` before and after each move, and quote the runner's `status` from `/api/state`.

## Gotchas

- Queue moves show at once and reach the server in click order. The board is not proof; wait until `/api/state` shows the new status.
- Each runner row is a drag button named `Verplaats <name>`. To reach the buttons inside a row, scope with `.queue-runner` and `button.queue-identity` as above.
- Escape closes the search dialog; the check-in still counts.
- The `Nu beschikbaar` panel depends on the Brussels clock and the runners' registration hours, so its contents change with the time of day.
