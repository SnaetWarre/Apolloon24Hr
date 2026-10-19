# Beheer › Systeem & herstel › backups

Herstelbackups and Backup terugzetten in Beheer › Systeem & herstel make a checked copy of this laptop's database and put every linked laptop back to one of this laptop's backups. A laptop whose `data/app.db` a power cut or disk error damaged still starts: the server puts the file aside as `data/app.damaged-<time>.sqlite`, unchanged, starts empty, and the welcome screen and Herstelbackups name the file. The `backups/` folder stays as it was, so the list still shows every backup.

## Sub-features

- `backup-create` makes a checked manual backup with `Nu backup maken`; the panel says `Backup gecontroleerd en opgeslagen om <tijd>.` and the table under Backup terugzetten gets a `Handmatig` row.
- `backup-restore` puts the data back to a backup with `Terugzetten` next to it and `Terugzetten` in the dialog; the panel says `Teruggezet naar <moment>: <n> lopers, <n> rondes.` and adds a `Vóór terugzetten` row. In a linked group every laptop goes back, and that row goes to the laptop that leads, which the message names (`De toestand van daarvoor staat op laptop LAPTOP-x …`).
- `clear-practice-race` is the rehearsal's last step in `docs/reliability-model.md`: `Race wissen` under Race wissen na een testrun, then `Race wissen` in the danger dialog (which adds `De race loopt nu.` while it runs). The panel says `Race gewist: <n> rondes weg. De toestand van daarvoor staat op laptop LAPTOP-x …`, and the leader's backup list gets a `Vóór race wissen` row. On every laptop the race fields are `null`, there are no laps or race events, every runner is `registered` with no `queueIndex`, and runners and labels stay. Overzicht says `Race nog niet gestart`, Timing `Wacht op de eerste loper`, and Beheer › Activiteit lists `Race gewist na de testrun (<n> rondes)`. Restoring the `Vóór race wissen` backup brings the race back.
- `clear-everything` is `Alles wissen` next to `Race wissen`: dialog `Alles wissen?`, then `Alles wissen`. It does what Race wissen does and also removes every runner with their registration. The panel says `Alles gewist: <n> lopers en <m> rondes weg. …`, the backup row is `Vóór race wissen` as well, labels stay, and Beheer › Activiteit lists `Alles gewist: race en lopers (<m> rondes, <n> lopers)`.
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
- **Practice race.** Start with `--laptops=3 --scenario=live --auto-link` and poll `/api/cluster/status` on laptop 0 until `state` is `healthy` and laptop 2 has the laps. On laptop 1's Systeem tab, in `section.panel` with heading `Race wissen na een testrun`, click `Race wissen`, then `Race wissen` in the dialog, and wait for `Race gewist:`. For laptops 0, 1, and 2, poll `/api/state` and `/api/history?scope=full` until there are no laps and `raceStartedAt` and `activeRunnerId` are `null`; all 60 runners are `registered`. Then check `/` and `/timing` on laptop 2, and on the leader's Systeem tab restore the `Vóór race wissen` row: laptop 2 has its laps again.

## Gotchas

- The panels sit below the fold at 1366x768. The page scrolls inside the app shell, so call `scrollIntoView` on the `Herstelbackups` heading before `run.proof`.
- `run.proof` notes `animations still running after 3 s` on this tab; the screenshot is still settled.
- Never use `pkill -f` to stop the laptop; use the `pid` from `state.json`.
- In a linked group, laptop 1 also lists a `Vóór koppelen` backup from linking, made in the same minute as the manual one. Pick the row by `Handmatig` and the time.
- In a linked group the `Vóór terugzetten` row is on the laptop that leads (laptop 0 in a fresh run), so waiting for it on laptop 1 times out.
