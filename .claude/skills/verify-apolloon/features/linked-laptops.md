# Linked laptops

At the event three laptops run the app as one group. Each holds the full database; a change counts once two laptops have it, and when one laptop disappears the other two carry on by themselves. A new laptop finds the others on the network; while it holds no runners it links by itself, otherwise in one click.

## Sub-features

- `group-link` lists the other laptops under Beheer › Systeem & herstel and links with `Koppelen`, whichever side it is pressed on; the side with fewer runners takes the other's data. With as many runners, a laptop nobody changed yet takes the data of one where someone prepared labels, logos, or settings (`changed` in `/api/cluster/status`).
- `group-auto-link` links a group without runners with the others by itself (about 5 s), the same way round as `Koppelen`. A laptop with runners never does. An empty laptop that hears two groups with runners waits and says so, and so does one whose link fails three rounds in a row (about 15 s), with the reason.
- `group-status` shows `Alles veilig` when all three are linked and `Eén laptop onbereikbaar` when one is gone.
- `group-write-anywhere` saves a change made on any laptop's screen, and shows it on the others.
- `group-failover` keeps saving with two laptops after the third freezes.
- `group-browser-moves` moves a browser display to another laptop when its own one disappears; the Electron app stays.

## How to get to it (user POV)

- Beheer › Systeem & herstel (`/admin?section=system`) on any laptop: the others are listed, with a `Koppelen` button where pressing it there goes the right way. `Laptop niet in de lijst? Vul het adres in` links by typed address under the same rule. Opening it puts the cursor in the address box.
- The welcome screen (`/`) of an empty laptop lists the laptops that hold runners, each with `Koppelen`.
- Beheer › Voorbereiding shows whether all laptops are reachable.
- The system notice at the bottom of the sidebar on every screen.
- Linking by itself has no button: start the laptops. The laptop that linked shows `Automatisch gekoppeld met LAPTOP-0, …` under Beheer › Systeem & herstel and on Overzicht (or its welcome screen); the others show `LAPTOP-1 is automatisch bijgekomen, …`.

## Driving it with drive.mjs

Preconditions:

- A fresh run with `--laptops=3`. Laptop 0 is seeded; 1 and 2 are empty. `verify.mjs doctor` shows `cluster=solo` on all three.
- `Koppelen` shows in any browser, so a plain `run.newPage({ laptop })` can link. `electron: true` only matters for `group-browser-moves`.

- **Link.** For laptop 1 and then 2: `await page.goto(run.url('/admin?section=system', i))`. In `page.locator('.cluster-peer-row', { hasText: new URL(run.url('/', 0)).host })` click `Koppelen` (allow 15 s for discovery), then click `Koppelen` in the dialog. Text `Gekoppeld.` appears. Afterwards `run.api('/api/cluster/status', 0)` has `state: 'healthy'` and `doctor` shows `cluster=healthy` and `runners=40` on all three.
- **Link by itself.** Start with `up --laptops=3 --auto-link`. Within 15 s, with no click, `run.api('/api/cluster/status', 0)` lists three members and `autoLink.linked` names `LAPTOP-1` and `LAPTOP-2` with `with: 'LAPTOP-0'`. On laptop 1's Systeem tab `.cluster-auto-link` reads `Automatisch gekoppeld met LAPTOP-0, …`; on laptop 0 it reads `LAPTOP-1 is automatisch bijgekomen, …`. Read the group on a laptop other than the one in the screenshot.
- **Never with runners.** Start with `up --laptops=3 --seeded=2 --auto-link`. After 15 s laptops 0 and 1 still each show `cluster=solo` in `doctor`, and laptop 2's welcome screen and Systeem tab show `Niet vanzelf gekoppeld: LAPTOP-0 en LAPTOP-1 hebben elk lopers.` (either order).
- **Prepared laptop keeps its data.** Start with `up --laptops=3 --scenario=empty`. On laptop 0 add a label under `/admin?section=labels` (`Naam van het nieuwe label`, then `Label toevoegen`); `run.api('/api/cluster/status', 0).changed` turns `true`, laptop 1 stays `false`. On laptop 0's Systeem tab press `Koppelen` next to laptop 1: the dialog reads `Op LAPTOP-1 staan nog geen lopers. Die laptop neemt alle gegevens van deze laptop over … Op deze laptop verandert niets.` After `Gekoppeld.` the label is in `/api/state` on both laptops.
- **Status.** On laptop 1's Systeem tab, `.cluster-state` reads `Alles veilig`.
- **Write anywhere.** Make a change through laptop 2's UI (for example check a runner in on `/queue`, see `queue.md`). Read `/api/state` on laptop 0: the runner's status changed there.
- **Failover.** Freeze laptop 0 like a pulled cable: `process.kill(run.state.laptops[0].pid, 'SIGSTOP')`. Within 15 s laptop 1's `.cluster-state` reads `Eén laptop onbereikbaar`. A change made through laptop 2's UI still saves.
- **Browser moves.** A plain `run.newPage()` on laptop 0's `/display/outside`, opened before the freeze, reopens on laptop 1 or 2 (`page.waitForURL` to another laptop's origin, 10 s). An `electron: true` page stays on laptop 0.
- **Proof.** `run.proof(page, 'group-…', { laptop: 1 })` so the saved state comes from a laptop that is still up.

## Gotchas

- Every laptop of a run is named `LAPTOP-<index>` (`CLUSTER_LAPTOP_NAME`), so the rows show `LAPTOP-0`, not this machine's name.
- Without `--auto-link` the empty laptops never link by themselves, which the `Link` steps above rely on. With it, they are linked before you could click.
- Use `SIGSTOP`, not `SIGTERM`: a stopped server announces it is leaving, which is not what a dead laptop does. `verify.mjs down` sends `SIGCONT` before stopping, so frozen laptops still exit.
- Koppelen works from either side: the laptop with fewer runners takes the other's data. On laptop 0 (40 runners) the empty laptops have a `Koppelen` button that brings them over; next to a laptop that holds fewer runners of its own it reads `Druk op Koppelen op die laptop.` instead. Laptop 1's welcome screen lists only laptops with runners.
- With only one laptop left nothing saves until a second returns. That is correct, not a bug.
- The group check needs real ms timing. Avoid running a 3-laptop run while the machine is under heavy load (another build, `npm run rehearse`), or elections can flap.
- `node scripts/validation/run.mjs failover-ui` and `race-day-ui` are the repo's regression checks for this; run them when you change cluster code.
