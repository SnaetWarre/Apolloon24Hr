# Linked laptops

At the event three laptops run the app as one group. Each holds the full database; a change counts once two laptops have it, and when one laptop disappears the other two carry on by themselves. A new laptop finds the others on the network and links in one click.

## Sub-features

- `group-link` lists the other laptops under Beheer › Systeem & herstel and links with `Koppelen`, whichever side it is pressed on; the side with fewer runners takes the other's data.
- `group-status` shows `Alles veilig` when all three are linked and `Eén laptop onbereikbaar` when one is gone.
- `group-write-anywhere` saves a change made on any laptop's screen, and shows it on the others.
- `group-failover` keeps saving with two laptops after the third freezes.
- `group-browser-moves` moves a browser display to another laptop when its own one disappears; the Electron app stays.

## How to get to it (user POV)

- Beheer › Systeem & herstel (`/admin?section=system`) on any laptop: the others are listed, with a `Koppelen` button where pressing it there goes the right way. `Laptop niet in de lijst? Vul het adres in` links by typed address under the same rule.
- The welcome screen (`/`) of an empty laptop lists the laptops that hold runners, each with `Koppelen`.
- Beheer › Voorbereiding shows whether all laptops are reachable.
- The system notice at the bottom of the sidebar on every screen.

## Driving it with drive.mjs

Preconditions:

- A fresh run with `--laptops=3`. Laptop 0 is seeded; 1 and 2 are empty. `verify.mjs doctor` shows `cluster=solo` on all three.
- Pages that link must be `run.newPage({ laptop, electron: true })`: the `Koppelen` button only shows in the desktop app.

- **Link.** For laptop 1 and then 2: `await page.goto(run.url('/admin?section=system', i))`. In `page.locator('.cluster-peer-row', { hasText: new URL(run.url('/', 0)).host })` click `Koppelen` (allow 15 s for discovery), then click `Koppelen` in the dialog. Text `Gekoppeld.` appears. Afterwards `run.api('/api/cluster/status', 0)` has `state: 'healthy'` and `doctor` shows `cluster=healthy` and `runners=40` on all three.
- **Status.** On laptop 1's Systeem tab, `.cluster-state` reads `Alles veilig`.
- **Write anywhere.** Make a change through laptop 2's UI (for example check a runner in on `/queue`, see `queue.md`). Read `/api/state` on laptop 0: the runner's status changed there.
- **Failover.** Freeze laptop 0 like a pulled cable: `process.kill(run.state.laptops[0].pid, 'SIGSTOP')`. Within 15 s laptop 1's `.cluster-state` reads `Eén laptop onbereikbaar`. A change made through laptop 2's UI still saves.
- **Browser moves.** A plain `run.newPage()` on laptop 0's `/display/outside`, opened before the freeze, reopens on laptop 1 or 2 (`page.waitForURL` to another laptop's origin, 10 s). An `electron: true` page stays on laptop 0.
- **Proof.** `run.proof(page, 'group-…', { laptop: 1 })` so the saved state comes from a laptop that is still up.

## Gotchas

- Every laptop of a run is named `LAPTOP-<index>` (`CLUSTER_LAPTOP_NAME`), so the rows show `LAPTOP-0`, not this machine's name.
- Use `SIGSTOP`, not `SIGTERM`: a stopped server announces it is leaving, which is not what a dead laptop does. `verify.mjs down` sends `SIGCONT` before stopping, so frozen laptops still exit.
- Koppelen works from either side: the laptop with fewer runners takes the other's data. On laptop 0 (40 runners) the empty laptops have a `Koppelen` button that brings them over; next to a laptop that holds fewer runners of its own it reads `Druk op Koppelen op die laptop.` instead. Laptop 1's welcome screen lists only laptops with runners.
- With only one laptop left nothing saves until a second returns. That is correct, not a bug.
- The group check needs real ms timing. Avoid running a 3-laptop run while the machine is under heavy load (another build, `npm run rehearse`), or elections can flap.
- `node scripts/validation/run.mjs failover-ui` and `race-day-ui` are the repo's regression checks for this; run them when you change cluster code.
