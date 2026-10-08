# Public displays

Binnenscherm (inside) and Buitenscherm (outside) are full-screen pages for the TVs at the event. They follow the race live: the runner on the track, the next runner, recent laps, rankings, and on the outside screen a large flash for a new fastest lap or a `Burgie gepakt` moment.

## Sub-features

- `display-inside-now` shows the runner on the track and the next one (`Nu op de piste`, `Volgende <nr> <naam>`).
- `display-inside-recent` lists the last six runners in a table (`Laatste 6 lopers`), newest on top with a `Net binnen` badge. The runner on the track has no live timer here: the inside screen shows the laps that are done. The columns are `Binnen om`, `Loper`, `Deze ronde`, `Snelste ronde`, and `Gem. ronde`. `Snelste ronde` and `Gem. ronde`, like the ranking averages, use only laps from 20 s to 10 minutes: a double press counted with `Toch afklokken` shows in `Deze ronde` and counts as a lap, but is not a lap time. A runner without such a lap shows `—`.
- `display-inside-ranking` ranks runners and compares label groups (`Ranking`, `Competities`).
- `display-outside-bands` shows the current runner (`Nu op de piste`) and the next one (`Volgende loper`) in large bands.
- `display-outside-flash` shows a new fastest lap large for 8 seconds, titled by the `Recordflits` setting in Beheer › Publiek (`Nieuw dagrecord` by default; `Uit` turns it off). A lap under 20 s (a double press counted with `Toch afklokken`) never flashes, and the next real lap only has to beat the laps of 20 s or more.
- `display-look` sets the look of one screen. `Licht` and `Donker` on the Binnenscherm write `?thema=licht|donker` into the address (and this browser's storage), so the look survives a move to another laptop. A `?thema=` already in the address wins over the stored choice, which wins over the default (dark inside, light outside).
- `display-outside-burgie` shows `Burgie gepakt` and `ZINGEN` with the runner on the track for 8 seconds after `Burgie gepakt` is pressed in Beheer › Publiek.

## How to get to it (user POV)

- Sidebar links `Binnenscherm` and `Buitenscherm`, or open `/display/inside` and `/display/outside`.
- Beheer › Publiek (`/admin?section=public`, panel `Publieke momenten`): the `Binnenscherm openen` and `Buitenscherm openen` buttons, the `Burgie gepakt` button, and the `Recordflits` choice.
- On a TV, the laptop's Event URL followed by the display path.

## Driving it with drive.mjs

Preconditions:

- A run with `--scenario=live` (race running, lap history), or a `ready` run that you advance through Timing.
- A large viewport, since these are TV pages: `run.newPage({ viewport: { width: 1920, height: 1080 } })`.

- **Inside.** `await page.goto(run.url('/display/inside'))`. Wait for `page.getByRole('region', { name: 'Nu op de piste' })`. The runner name in it matches `race.activeRunnerId` in `/api/state`.
- **Live update.** Open `/timing` in a second page and press Space (see `timing.md`). Without reloading, `.inside-now__runner` on the display changes to the new runner and `Laatste 6 lopers` gains a row at the top.
- **Double press in Laatste 6 lopers.** On `/timing` press Space, wait for `Ronde opgeslagen. Volgende loper gestart.`, press Space again, and click `Toch afklokken` in dialog `Toch afklokken?`. The top `.recent-lap-row` shows the short time under `Deze ronde`, but `Snelste ronde` and `Gem. ronde` are that runner's real laps from `/api/history?scope=full` (or `—`). Analyse's `Snelste` tile and `Snelste rondes` panel skip it too.
- **Outside.** `await page.goto(run.url('/display/outside'))`. The bands `.outside-band--current` and `.outside-band--next` show the active and next runner.
- **Fastest-lap flash.** Make a handoff whose lap is faster than every earlier lap. The `live` laps are all over a minute, so a press 20 to 60 s after the last handoff is a record and gets no short-lap question. `.outside-record-flash` appears with `Nieuw dagrecord`, the lap time and the runner, and is gone about 8 s later. Laps already there when the page loaded never flash. A double press counted with `Toch afklokken` (under 20 s) must not flash either, and a 25 s lap right after it still flashes `Nieuw dagrecord`.
- **Burgie.** On `/admin?section=public` click `Burgie gepakt`. On the outside page `.outside-record-flash` shows `Burgie gepakt`, `ZINGEN`, and the runner on the track.
- **Look survives failover.** In a linked group of three, open `/display/inside` on laptop 0 and click `Licht`. The address gains `?thema=licht` and `document.documentElement.dataset.displayTone` is `light`. Freeze laptop 0 (`process.kill(pid, 'SIGSTOP')`) and wait for the page URL to move to another laptop. The tone must still be `light`.
- **Proof.** Take `run.proof(page, 'display-…')` on the display page itself, before and after the action on Timing.

## Gotchas

- The flash is meant to stay loud (blue and night pulse, a frame, a yellow slab). A flat yellow screen is a regression, not a style choice.
- Only laptops and very large TVs matter. Phone-sized layouts are out of scope.
- Display pages hide the sidebar. Use the region names and classes above, not navigation links.
- In a linked group a browser display moves to another laptop when its own laptop disappears; see `linked-laptops.md`.
