# Beheer › Rondes

Beheer › Rondes lists every lap run, newest first, so an operator can fix what went wrong at the track: a press that came too late or too early, a lap that went to the wrong runner, a missed press that made two laps into one, or a press too many. A click on a lap (the time in its row is the button, its hit area is the whole row) opens panel `Ronde verbeteren` beside the list with every fix for that lap; the rows have no buttons of their own. Laps far below or above the race's median lap (half, or 1.75 times) are marked with a reason, and so are both laps around a press that looks late or early. Each fix is a line in Beheer › Activiteit.

## Sub-features

- `laps-list` shows each lap with its time, runner, lap number and lap time, and a search on number and name that ignores accents, like Wachtrij's: `zoe` finds Zoë and `149 bram` finds Bram with number 149.
- `laps-flagged` marks laps far from the median (`Veel korter dan gewoonlijk (…). Eén keer te veel gedrukt?`, `Veel langer dan gewoonlijk (…). Wissel gemist?`); `Alleen opvallende rondes (N)` shows only those. With fewer than 5 laps nothing is marked.
- `laps-handoff` moves one press, as operators get asked: "Mitras −4, Wout +4". The panel's group `Welke wissel` names the press by its runners (`Van Mitras Peeters naar Wout Van Nuffelen`) when the lap has one on both ends. The buttons `−1 s`, `−0,1 s`, `+0,1 s`, `+1 s` change the lap before the press; the lap after it changes the other way, so the two add up as before and no other lap changes. For the press that started the runner on the track, that runner's start moves (`loopt nu`). A press moves at most 15 s and no lap gets under 20 s (unless it already was); the buttons that would pass that are disabled. `Wissel verschuiven` saves it, `Terugzetten` goes back to 0.
- `laps-handoff-hint` marks a press that looks late or early: the lap before it is at least 3 s off its runner's own usual lap (the median of their other measured laps, at least 2) and the lap after it is off the other way by about as much (within 1 s). The line between the two rows reads `Wissel 4 s te laat gedrukt?` with button `Bekijken`, both rows read `… s trager/sneller dan gewoonlijk`, and the panel offers `Wissel 4 s vroeger`. Two late presses in a row give two marks, not a third early one between them.
- `laps-move` gives a lap to another runner, with that runner's labels. The dialog's `Loper zoeken` box uses the same search, labels included, and has the cursor when the dialog opens. The split dialog's box has it too. Enter in that box works like Enter in Wachtrij's `Loper zoeken`: with exactly one runner found it takes that runner, otherwise it takes the selected one, and the hint `Enter: ronde naar #… …` (split: `Enter: tweede helft naar #… …`) says which. With several runners found and none selected, Enter does nothing.
- `laps-split` splits a lap in two halves; the first stays with its runner, the second goes to the runner picked (the same one by default). Both halves are a guess (`source: 'split'`), so neither flashes as a record on the Buitenscherm or counts as a record to beat. Split for the same runner, the second half keeps the labels the lap was recorded with, even after the runner's labels changed.
- `laps-delete` removes a lap after a confirmation.
- `laps-hold` keeps the rows in place while the mouse is on the table or a fix dialog is open: laps that finish later wait, and the toolbar reads `1 nieuwe ronde` or `N nieuwe rondes`. Halves of a split and moved laps still show. Once the mouse leaves, the waiting laps rise in on top with a fading wash.

## How to get to it (user POV)

- Beheer › Rondes: open `/admin?section=laps`.
- The marked laps usually come from Timing: two presses within 20 s, confirmed with `Toch afklokken` (see `timing.md`).

## Driving it with drive.mjs

Preconditions:

- A run with `--scenario=live` (a race with laps). For a marked lap, make a double press on `/timing` first: `Space`, wait for `Ronde opgeslagen.`, `Space` again, and click `Toch afklokken` in dialog `Toch afklokken?`.

- **Open.** `await page.goto(run.url('/admin?section=laps'))`. Heading `Rondes` is visible.
- **Marked laps.** Check `getByRole('checkbox', { name: /^Alleen opvallende rondes/ })`. The double press row reads `Eén keer te veel gedrukt?`.
- **Open a lap.** Click `.laps-table__open` in a row; `getByRole('complementary', { name: 'Ronde verbeteren' })` shows `Ronde N van #… …` and the fix buttons below.
- **Move a press.** In the panel click `−1 s` four times, then `Wissel verschuiven`. Text `Wissel van #… naar #… 4 s vroeger gezet.` appears; in `/api/history?scope=full` the lap is 4 000 ms shorter, the next lap starts 4 000 ms earlier and is 4 000 ms longer. For the newest lap with a runner on the track, `/api/state` `race.activeStartedAt` moves instead.
- **Hint.** No seeded scenario has a late press: seed one with `server/db.ts` (`performHandoff` at chosen times, every runner 3+ laps, one lap +4 000 ms and the next −4 000 ms) into the run's data folder before the server starts. Click `Bekijken` on the line between the two rows, then `Wissel 4 s vroeger` and `Wissel verschuiven`.
- **Delete.** Open the lap and click `Verwijderen`, then `Verwijderen` in dialog `Ronde verwijderen?`. Text `… is verwijderd.` appears; the lap is gone from `run.api('/api/history?scope=full')`.
- **Move.** Open the lap and click `Andere loper`. In dialog `Ronde naar andere loper` pick a runner (`getByRole('radio')`) and click `Verplaatsen`, or type a number that finds one runner with `page.keyboard.type` and press `Enter`. Text `… staat nu op …` appears; the lap's `runnerId` changed in `/api/history?scope=full`.
- **Split.** Open the lap and click `Splitsen`. Dialog `Ronde splitsen` starts with the same runner selected; click `Splitsen`. Text `… is gesplitst in twee rondes van …` appears; `/api/history?scope=full` holds two laps of that runner within the old lap's start and end, their times adding up to the old one.
- **Activiteit.** `/admin?section=activity` lists `Ronde N van #… (…): wissel 4 s vroeger gezet`, `Ronde N van #… verwijderd`, `… naar #… verplaatst` and `… gesplitst in twee rondes van …`. An undo on Timing after a move lists `Laatste wissel ongedaan gemaakt (Ronde N van #… verwijderd)` with the runner the lap was moved to; after a delete it has nothing to name and reads `Laatste wissel ongedaan gemaakt`.

## Gotchas

- Scope row locators to `.laps-table tbody tr`: the other Beheer tabs stay mounted while hidden, and their tables come first in the page.
- The list only loads while the Rondes tab is open.
- A lap recorded through `run.rpc()` while the mouse is on the table does not show until the mouse leaves it. Move the mouse off the table (`page.mouse.move(0, 0)`) before waiting for a new lap row.
- A lap moved or deleted changes the lap numbers of that runner's later laps. Read them again after each fix instead of reusing the ones from before.
