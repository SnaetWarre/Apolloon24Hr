# Registration import

An operator imports the registration form's file (Excel `.xlsx` from Google Sheets, or CSV) in Beheer › Voorbereiding. New runners land in the database as `Ingeschreven`, existing ones are updated, and the answers appear in each runner's profile as typed.

## Sub-features

- `import-plain-csv` imports a plain runner list (`runner_number,name,labels,historical_avg,historical_best`).
- `import-form` imports the Google Form export, recognised by its e-mail column; row number becomes runner number.
- `import-xlsx` reads the first sheet of an `.xlsx` and imports it like a CSV.
- `import-repeat` updates instead of duplicating, and keeps live statuses such as warm-up.
- `import-repick` picks the same file again after it changed on disk and imports the new contents.
- `import-welcome` the welcome screen on a laptop without runners has an `Inschrijvingen importeren` button that opens the same panel.

## How to get to it (user POV)

- Beheer › Voorbereiding: open `/admin?section=preparation`, panel `Inschrijvingen importeren`.
- On a laptop without runners, Overzicht (`/`) shows the welcome screen (`Welkom bij Apolloon`). Its `Inschrijvingen importeren` button opens `/admin?section=preparation`.

## Driving it with drive.mjs

Preconditions:

- A run with `--scenario=empty` for a first import (or the welcome screen), or `--scenario=ready` for `import-repeat`.
- A file written by your drive script into the evidence folder, so the input is kept with the proof. For example `fs.writeFileSync(path.join(run.evidenceDir, 'runners.csv'), 'runner_number,name,labels\n901,Verify Runner,HILOK\n')`.

- **Open.** `await page.goto(run.url('/admin?section=preparation'))`. Heading `Inschrijvingen importeren` is visible and the file name reads `Geen bestand gekozen`.
- **Pick the file.** `await page.locator('input[type="file"]').setInputFiles(file)`. The file name appears next to `Bestand kiezen` and `Importeren` becomes enabled.
- **Import.** Click `page.getByRole('button', { name: 'Importeren', exact: true })`. A notice reads `<n> aangemaakt, <n> bijgewerkt, <n> overgeslagen`, followed by any row errors.
- **Side effect.** `/api/state` `runners` contains runner `901` with status `registered`; `/api/registrations` holds the form answers for a form export. Beheer › Activiteit lists `Inschrijvingen geïmporteerd: 1 nieuw, 0 bijgewerkt`. Wachtrij does not show the runner on the board until it is checked in (see `queue.md`).
- **Repeat.** Click `Importeren` again; the picked file stays loaded. The notice reads `0 aangemaakt, 1 bijgewerkt, 0 overgeslagen` and the runner count in `/api/state` is unchanged.
- **Re-pick after editing.** Rewrite the file under the same name with an extra row (`902,Tweede Loper`), pick it again through the file chooser (see Gotchas), and click `Importeren`. The notice reads `1 aangemaakt, 1 bijgewerkt, 0 overgeslagen` and `/api/state` has runner `902`. The browser fires no `change` for the same path unless the input was cleared, so `setInputFiles` on the input is not enough to test this.
- **Proof.** `run.proof(page, 'import-…')` after picking the file and after the notice appears.

## Gotchas

- The file input is hidden behind the `Bestand kiezen` label. Use `setInputFiles` on the input; clicking the label opens a native file chooser. For the re-pick step, use the chooser the way an operator does: `const chooser = page.waitForEvent('filechooser')`, click `label.file-picker`, then `(await chooser).setFiles(file)`.
- The `ready` scenario already has runners 101 to 140, all from the form. A plain-list row with one of those numbers only updates that runner when the name matches exactly. With another name it creates a new runner without a number, and the notice adds `Rij N: nummer … is al in gebruik, … kreeg geen nummer.` Use free numbers unless you are testing an update.
- In an `.xlsx` plain list, a lap time typed as `1:20` is a time cell (`h:mm`, 01:20:00). It imports as 1 min 20 s, the same as the CSV of that sheet: `historicalAvgMs` 80000 in `/api/state`. Build such a file with `write-excel-file` and `{ value: new Date(Date.UTC(1899, 11, 30, 1, 20)), format: 'h:mm' }`. A whole minute typed with seconds, `0:01:00` (`h:mm:ss`), stays 60000: only a whole-minute time longer than a lap can take (10 minutes) is read back as m:ss. The profile does not show historical times; read them in `/api/state` or the lap exports.
- Two rows of one plain list with the same number and different names are two people. The first keeps the number; the second is imported without one, and the notice adds `Rij N: nummer … staat ook op rij M, … kreeg geen nummer.` Importing `204 Anna Peeters`, `205 Bram Claes`, `205 Chloé Martens`, `206 Dries Wouters` into `empty` reads `4 aangemaakt, 0 bijgewerkt, 0 overgeslagen` and all four are in `/api/state`. A row that repeats both number and name updates that runner.
- Answers are stored as typed, including junk such as `///` in the e-mail field. Do not treat odd text in the profile as a bug.
- The `empty` scenario shows the welcome screen on Overzicht; it disappears once the laptop has runners.
