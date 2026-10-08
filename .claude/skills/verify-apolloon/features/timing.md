# Timing

Timing (Telsysteem 2) is the screen where one operator presses Space or Enter each time a runner hands off. The first press starts the race clock and the first runner in the queue; each later press saves the running lap and starts the next runner. Lap times come from the key events, not from when the server received them.

## Sub-features

- `timing-start` starts the race and the first waiting runner on the first press.
- `timing-handoff` saves the running lap and starts the next waiting runner.
- `timing-short-lap` asks `Toch afklokken?` when a press comes less than 20 s after the last one, and records nothing when cancelled.
- `timing-empty-queue` keeps the button disabled as `Geen loper klaar` when nobody is on the track and nobody is waiting. With a runner on the track and an empty queue the button still reads `Klok …`.
- `timing-undo` removes the last handoff after `Laatste wissel ongedaan maken` is confirmed.
- `timing-finish` stops the race through `Race beëindigen`, `Verder`, and `Race definitief beeindigen`. After that Space and Enter do nothing; only the button `Race hervatten met …` reopens the race, after the question `Race hervatten?`. Before the start `Race beëindigen` is disabled, and the server refuses `race.finish` with `De race is nog niet gestart.`

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
- **Finish.** Before the start `Race beëindigen` is disabled, and `run.rpc().race.finish.mutate({ activeRunnerId: null, activeStartedAt: null })` rejects with `De race is nog niet gestart.` Once the race runs, click `Race beëindigen`, then `Verder`, then `Race definitief beeindigen`. The button `getByRole('button', { name: /^Race hervatten met / })` appears and `race.raceFinishedAt` is set. Space now opens nothing and leaves `/api/state` `race` unchanged.
- **Resume.** Click `Race hervatten met …`, then `Race hervatten` in dialog `Race hervatten?`. The button becomes `Klok …` again and `race.raceFinishedAt` is `null`.
- **Empty queue.** On a run where nobody waits (use `run.rpc().runners.setStatus.mutate({ id, status: 'warming_up' })` for each waiting runner as setup), the button reads `Geen loper klaar` and is disabled, and Space changes nothing.
- **Proof.** `run.proof(page, 'timing-…')` before and after each press. The lap's `durationMs` in `/api/history?scope=full` is the side effect to quote.

## Gotchas

- Presses inside a dialog never count: Space in a confirmation dialog cancels it. Close every dialog before proving a handoff.
- The 20 s short-lap rule means a fast scripted second press always asks. Either confirm `Toch afklokken` or wait 20 s with `page.waitForTimeout(20_000)`; this is the one place a fixed wait is correct.
- Ctrl/Alt/Meta+Space and Ctrl+Enter are ignored on purpose. Use plain `Space`.
- Starting the race consumes the `ready` run. Start a fresh run for the next recipe.
- The yellow `Backup controleren` notice in the sidebar comes from the helper turning backups off. It is expected here.
