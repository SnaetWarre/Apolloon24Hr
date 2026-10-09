# Beheer › Systeem & herstel › backups

Herstelbackups and Backup terugzetten in Beheer › Systeem & herstel make a checked copy of this laptop's database and put every linked laptop back to one of this laptop's backups. A laptop whose `data/app.db` a power cut or disk error damaged still starts: the server puts the file aside as `data/app.damaged-<time>.sqlite`, unchanged, starts empty, and the welcome screen and Herstelbackups name the file. The `backups/` folder stays as it was, so the list still shows every backup.

## Sub-features

- `backup-create` makes a checked manual backup with `Nu backup maken`; the panel says `Backup gecontroleerd en opgeslagen om <tijd>.` and the table under Backup terugzetten gets a `Handmatig` row.
- `backup-restore` puts the data back to a backup with `Terugzetten` next to it and `Terugzetten` in the dialog; the panel says `Teruggezet naar <moment>: <n> lopers, <n> rondes.` and adds a `Vóór terugzetten` row.
- `damaged-database` starts a laptop whose `app.db` SQLite cannot read: the welcome screen shows `De databank op deze laptop was beschadigd. Apolloon zette ze opzij als <bestand> en startte leeg.` with a `Naar Systeem & herstel` button, and Herstelbackups shows `Bij het opstarten om <tijd> was de databank beschadigd.`

## How to get to it (user POV)

- Beheer › Systeem & herstel: open `/admin?section=system`. Herstelbackups and Backup terugzetten come after Vast netwerkadres (and after Laptops koppelen when linking is on).
- After a damaged database: the welcome screen on Overzicht (`/`), button `Naar Systeem & herstel`.

## Driving it with drive.mjs

Preconditions:

- `--scenario=ready` (40 runners). Automatic backups are off in verify runs, so make one with `Nu backup maken` first.
- For `damaged-database`, the server has to start again on a damaged file. `verify.mjs` has no restart command: read `.tmp-verify/<run>/state.json`, stop the laptop's recorded `pid` with SIGTERM, overwrite `<dataPath>/data/app.db` with random bytes, start `dist-server/server/index.js` again with the same env `verify.mjs up` uses (`DATA_PATH`, `PORT`, `NODE_ENV=production`, `BACKUP_ENABLED=false`, ...), detached and logging to `laptop-0.log`, and write the new `pid` into `state.json` so `verify.mjs down` stops it. Run the steps after the restart in a new `openRun()`.

- **Make a backup.** `await page.goto(run.url('/admin?section=system'))`, click `getByRole('button', { name: 'Nu backup maken', exact: true })`, wait for `getByText(/Backup gecontroleerd en opgeslagen om/)`. `<dataPath>/backups/` holds one `apolloon-*-manual-*.sqlite`.
- **Damaged database.** After the restart, `page.goto(run.url('/'))` shows heading `Welkom bij Apolloon` and the note naming `app.damaged-…sqlite`; `/api/state` has no runners. The laptop log says `Put aside a damaged database (file is not a database) as app.damaged-….sqlite; starting empty.` Check that the file is byte for byte the bytes you wrote and that `backups/` is unchanged.
- **Restore.** Click `Naar Systeem & herstel`, then in the `Handmatig` row (`getByRole('row').filter({ hasText: 'Handmatig' })`) click `Terugzetten`, and `Terugzetten` again in the dialog. Wait for `getByText(/Teruggezet naar .*: 40 lopers/)`; poll `/api/state` until it has 40 runners.

## Gotchas

- The panels sit below the fold at 1366x768. The page scrolls inside the app shell, so call `scrollIntoView` on the `Herstelbackups` heading before `run.proof`.
- `run.proof` notes `animations still running after 3 s` on this tab; the screenshot is still settled.
- Never use `pkill -f` to stop the laptop; use the `pid` from `state.json`.
