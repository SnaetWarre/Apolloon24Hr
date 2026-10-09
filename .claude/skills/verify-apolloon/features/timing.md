# Timing

Timing (Telsysteem 2) is the screen where one operator presses Space or Enter each time a runner hands off. The first press starts the race clock and the first runner in the queue; each later press saves the running lap and starts the next runner. Lap times come from the key events, not from when the server received them.

## Sub-features

- `timing-start` starts the race and the first waiting runner on the first press.
- `timing-handoff` saves the running lap and starts the next waiting runner.
- `timing-short-lap` asks `Toch afklokken?` when a press comes less than 20 s after the last one, and records nothing when cancelled.
- `timing-empty-queue` keeps the button disabled as `Geen loper klaar` when nobody is on the track and nobody is waiting. With a runner on the track and an empty queue the button still reads `Klok …`; that press saves the lap with `Ronde opgeslagen. Niemand actief; de wachtrij is leeg.`
- `timing-undo` removes the last handoff after `Laatste wissel ongedaan maken` is confirmed.
- `timing-finish` stops the race through `Race beëindigen`, `Verder`, and `Race definitief beëindigen`. The runner on the track is taken off it. After that Space and Enter do nothing. Two buttons reopen the race. `Race hervatten met …`, after the question `Race hervatten?`, starts the next waiting runner as a new lap (`Loper gestart.`). `Laatste wissel ongedaan maken`, after the question `Race beëindigen ongedaan maken?` and `Race heropenen`, takes back the finish itself: the same runner runs on with the same start time (`Race heropend. Beëindigen ongedaan gemaakt.`). Before the start `Race beëindigen` is disabled, and the server refuses `race.finish` with `De race is nog niet gestart.`

## How to get to it (user POV)

- Sidebar link `Timing`, or open `/timing`.
- Press Space or Enter anywhere on the page while no dialog is open.
- Click the big blue button (`Start …` before anyone runs, `Klok …` while someone runs).
- From Overzicht, the `Naar Timing` link on the `Op de piste` panel.

## Driving it with drive.mjs

Preconditions:

- A fresh run with `--scenario=ready`. The race has not started and 12 runners wait in `Klaar om te lopen`.
- `scripts/examples/timing-handoff.mjs` already drives `timing-start`, `timing-short-lap` (confirm path), and `timing-handoff`. Run it, or copy it.

- **Open.** `await page.goto(run.url('/timing'))`, then wait for `page.getByRole('button', { name: /^Start / })`. The button names the first waiting runner.
- **Start.** `await page.keyboard.press('Space')`. The text `Loper gestart.` appears, the button becomes `Klok …`, and `/api/state` has `race.raceStartedAt` and `race.activeRunnerId` set.
- **Short lap, cancel.** Press Space again within 20 s. `page.getByRole('dialog', { name: 'Toch afklokken?', exact: true })` opens. Press Space again: the dialog closes and `/api/state` `race` is unchanged.
- **Short lap, confirm.** Press Space, then click the dialog's `Toch afklokken` button. `Ronde opgeslagen. Volgende loper gestart.` appears and `/api/history?scope=full` has one lap for the runner who was on the track.
- **Handoff.** After 20 s or more, press Space. No question appears; the lap is saved directly and the table `Laatste 10 rondes` gains a row.
- **Undo.** Click `Laatste wissel ongedaan maken`, then `Ongedaan maken` in the dialog `Laatste wissel ongedaan maken?`. `Laatste wissel ongedaan gemaakt.` appears; the previous runner is active again and their last lap is gone from `/api/history?scope=full`. Enter clocks right after an undo, confirmed or cancelled, and after a cancelled `Race beëindigen`: the closed dialog leaves no button focused, so the next Enter records a lap instead of reopening the question.
- **Finish.** Before the start `Race beëindigen` is disabled, and `run.rpc().race.finish.mutate({ activeRunnerId: null, activeStartedAt: null })` rejects with `De race is nog niet gestart.` Once the race runs, click `Race beëindigen`, then `Verder` in dialog `Race afsluiten`, then `Race definitief beëindigen`. The button `getByRole('button', { name: /^Race hervatten met / })` appears and `race.raceFinishedAt` is set. Space now opens nothing and leaves `/api/state` `race` unchanged.
- **Reopen with undo.** After the finish, click `Laatste wissel ongedaan maken`, then `Race heropenen` in dialog `Race beëindigen ongedaan maken?`. `race.raceFinishedAt` is `null` and `race.activeRunnerId` is the runner who was on the track before the finish.
- **Resume.** Finish again, click `Race hervatten met …`, then `Race hervatten` in dialog `Race hervatten?`. The button becomes `Klok …` again and, once `/api/state` catches up, `race.raceFinishedAt` is `null` and the next waiting runner is on the track.
- **Empty queue.** Move every waiting runner to Opwarming in setup (`run.rpc().runners.setStatus.mutate({ id, status: 'warming_up' })`). The button still reads `Klok …`; press Space and wait for `Ronde opgeslagen. Niemand actief; de wachtrij is leeg.` The button then reads `Geen loper klaar` and is disabled, and Space changes nothing.
- **Proof.** `run.proof(page, 'timing-…')` before and after each press. The lap's `durationMs` in `/api/history?scope=full` is the side effect to quote.

## Gotchas

- Presses inside a dialog never count: Space in a confirmation dialog cancels it. Close every dialog before proving a handoff.
- The 20 s short-lap rule means a fast scripted second press always asks. Either confirm `Toch afklokken` or wait 20 s with `page.waitForTimeout(20_000)`; this is the one place a fixed wait is correct.
- Ctrl/Alt/Meta+Space and Ctrl+Enter are ignored on purpose. Use plain `Space`.
- Enter clocks even when a clicked button or link still has focus, such as `Donker` in the sidebar theme switch. Enter only presses a button or link that was reached with the keyboard (Tab or arrow keys). Chromium marks every focused control `:focus-visible` once a key is pressed, so Timing decides this when focus arrives, not when Enter is pressed. To prove the keyboard case, reach the control with `page.keyboard.press('Tab')` or `Shift+Tab`, not with `locator.focus()`.
- `Race definitief beëindigen` stays disabled for 500 ms after `Verder`, so the second click of a double click on `Verder` lands on a disabled button. Playwright's `click()` waits for it; a raw `page.mouse.click` within 500 ms does nothing.
- Starting the race consumes the `ready` run. Start a fresh run for the next recipe.
- An undo takes back the last step, whatever it was. After `Race hervatten` that step is the resume, so the next undo finishes the race again.
- The yellow `Backup controleren` notice in the sidebar comes from the helper turning backups off. It is expected here.
