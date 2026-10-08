# Beheer › Rondes

Beheer › Rondes lists every lap run, newest first, so an operator can fix what went wrong at the track: a lap that went to the wrong runner, a missed press that made two laps into one, or a press too many. Laps far below or above the race's median lap (half, or 1.75 times) are marked with a reason. Each fix is a line in Beheer › Activiteit.

## Sub-features

- `laps-list` shows each lap with its time, runner, lap number and lap time, and a search on number or name.
- `laps-flagged` marks laps far from the median (`Veel korter dan gewoonlijk (…). Eén keer te veel gedrukt?`, `Veel langer dan gewoonlijk (…). Wissel gemist?`); `Alleen opvallende rondes (N)` shows only those. With fewer than 5 laps nothing is marked.
- `laps-move` gives a lap to another runner, with that runner's labels at the lap's start.
- `laps-split` splits a lap in two halves; the first stays with its runner, the second goes to the runner picked (the same one by default).
- `laps-delete` removes a lap after a confirmation.

## How to get to it (user POV)

- Beheer › Rondes: open `/admin?section=laps`.
- The marked laps usually come from Timing: two presses within 20 s, confirmed with `Toch afklokken` (see `timing.md`).

## Driving it with drive.mjs

Preconditions:

- A run with `--scenario=live` (a race with laps). For a marked lap, make a double press on `/timing` first: `Space`, wait for `Ronde opgeslagen.`, `Space` again, and click `Toch afklokken` in dialog `Toch afklokken?`.

- **Open.** `await page.goto(run.url('/admin?section=laps'))`. Heading `Rondes` is visible.
- **Marked laps.** Check `getByRole('checkbox', { name: /^Alleen opvallende rondes/ })`. The double press row reads `Eén keer te veel gedrukt?`.
- **Delete.** In that row click `Verwijderen`, then `Verwijderen` in dialog `Ronde verwijderen?`. Text `… is verwijderd.` appears; the lap is gone from `run.api('/api/history?scope=full')`.
- **Move.** In a row click `Andere loper`. In dialog `Ronde naar andere loper` pick a runner (`getByRole('radio')`) and click `Verplaatsen`. Text `… staat nu op …` appears; the lap's `runnerId` changed in `/api/history?scope=full`.
- **Split.** In a row click `Splitsen`. Dialog `Ronde splitsen` starts with the same runner selected; click `Splitsen`. Text `… is gesplitst in twee rondes van …` appears; `/api/history?scope=full` holds two laps of that runner within the old lap's start and end, their times adding up to the old one.
- **Activiteit.** `/admin?section=activity` lists `Ronde N van #… verwijderd`, `… naar #… verplaatst` and `… gesplitst in twee rondes van …`.

## Gotchas

- Scope row locators to `.laps-table tbody tr`: the other Beheer tabs stay mounted while hidden, and their tables come first in the page.
- The list only loads while the Rondes tab is open.
- A lap moved or deleted changes the lap numbers of that runner's later laps. Read them again after each fix instead of reusing the ones from before.
