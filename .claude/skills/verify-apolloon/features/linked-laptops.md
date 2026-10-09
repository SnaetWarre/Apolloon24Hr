# Linked laptops

At the event three laptops run the app as one group. Each holds the full database; a change counts once two laptops have it, and when one laptop disappears the other two carry on by themselves. A new laptop finds the others on the network; while it holds no runners it links by itself, otherwise in one click.

## Sub-features

- `group-link` lists the other laptops under Beheer › Systeem & herstel and links with `Koppelen`, whichever side it is pressed on; the side with fewer runners takes the other's data. With as many runners, a laptop nobody changed yet takes the data of one where someone prepared labels, logos, or settings (`changed` in `/api/cluster/status`).
- `group-auto-link` links a group without runners with the others by itself (about 5 s), the same way round as `Koppelen`. A laptop with runners never does. An empty laptop that hears two groups with runners waits and says so, and so does one whose link fails three rounds in a row (about 15 s), with the reason.
- `group-status` shows `Alles veilig` when all three are linked, `Eén laptop onbereikbaar` when one is gone, and `Twee laptops · Koppel een derde, zodat er één mag uitvallen` in a group of two, such as right after `Uit de groep halen`.
- `group-write-anywhere` saves a change made on any laptop's screen, and shows it on the others.
- `group-failover` keeps saving with two laptops after the third freezes.
- `group-replace` takes a laptop that is gone for good out of the group with `Uit de groep halen` (offered next to it after 30 s of silence, only while the group still saves), so a spare linked in its place makes three laptops again and one more may fail. The removed laptop is not taken back in by itself; on it, `Opnieuw koppelen` brings it back.
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
- **Link by itself.** Start with `up --laptops=3 --auto-link`. Within 15 s, with no click, `run.api('/api/cluster/status', 0)` lists three members and `autoLink.linked` names `LAPTOP-1` and `LAPTOP-2` with `with: 'LAPTOP-0'`. On laptop 1's Systeem tab a `.cluster-auto-link` line reads `Automatisch gekoppeld met LAPTOP-0, …`; on laptop 0 one reads `LAPTOP-1 is automatisch bijgekomen, …`. A tab can show several such lines (laptop 1 also shows `LAPTOP-2 is automatisch bijgekomen, …`), so filter by text. Read the group on a laptop other than the one in the screenshot.
- **Never with runners.** Start with `up --laptops=3 --seeded=2 --auto-link`. After 15 s laptops 0 and 1 still each show `cluster=solo` in `doctor`, and laptop 2's welcome screen and Systeem tab show `Niet vanzelf gekoppeld: LAPTOP-0 en LAPTOP-1 hebben elk lopers.` (either order).
- **Prepared laptop keeps its data.** Start with `up --laptops=3 --scenario=empty`. On laptop 0 add a label under `/admin?section=labels` (`Naam van het nieuwe label`, then `Label toevoegen`); `run.api('/api/cluster/status', 0).changed` turns `true`, laptop 1 stays `false`. On laptop 0's Systeem tab press `Koppelen` next to laptop 1: the dialog reads `Op LAPTOP-1 staan nog geen lopers. Die laptop neemt alle gegevens van deze laptop over … Op deze laptop verandert niets.` After `Gekoppeld.` the label is in `/api/state` on both laptops.
- **Status.** On laptop 1's Systeem tab, `.cluster-state` reads `Alles veilig`.
- **Write anywhere.** Make a change through laptop 2's UI (for example check a runner in on `/queue`, see `queue.md`). Read `/api/state` on laptop 0: the runner's status changed there.
- **Failover.** Freeze laptop 0 like a pulled cable: `process.kill(run.state.laptops[0].pid, 'SIGSTOP')`. Within 15 s laptop 1's `.cluster-state` reads `Eén laptop onbereikbaar`. A change made through laptop 2's UI still saves.
- **Replace a dead laptop.** Needs a second run for the spare: `up --run=spare --laptops=3 --scenario=empty` (its laptop 0 is the spare; a one-laptop run has linking off). Link the group, then freeze laptop 2 with `SIGSTOP`. After 30 s, on laptop 0's Systeem tab, its row (`.cluster-peer-row` with `LAPTOP-2`) has a `Uit de groep halen` button; click it, then `Uit de groep halen` in the danger dialog. `LAPTOP-2 is uit de groep gehaald.` appears and `/api/cluster/status` lists two members with `majority: 2`. Link the spare from its own Systeem tab: its list shows only its own run's laptops, because each run has its own discovery port. Open `Laptop niet in de lijst? Vul het adres in`, type laptop 0's `host:port` (the cursor is already in the box), click `Koppelen` in that fold-out and in the dialog: three members, `majority: 2`. Freeze laptop 1 too: a change through laptop 0 still saves. Beheer › Activiteit lists `LAPTOP-2 uit de groep gehaald`. `SIGCONT` on laptop 2: within 15 s its Systeem tab says `Deze laptop is uit de groep gehaald` with `Opnieuw koppelen`, and the group still has three members.
- **Browser moves.** A plain `run.newPage()` on laptop 0's `/display/outside`, opened before the freeze, reopens on laptop 1 or 2 (`page.waitForURL` to another laptop's origin, 10 s). An `electron: true` page stays on laptop 0.
- **Proof.** `run.proof(page, 'group-…', { laptop: 1 })` so the saved state comes from a laptop that is still up.

## Gotchas

- Every laptop of a run is named `LAPTOP-<index>` (`CLUSTER_LAPTOP_NAME`), so the rows show `LAPTOP-0`, not this machine's name. The spare from a second run has such a name too, so a group can hold two laptops called `LAPTOP-0` (Activiteit then lists `LAPTOP-0 gekoppeld met Koppelen` for the spare). Tell them apart by address.
- Without `--auto-link` the empty laptops never link by themselves, which the `Link` steps above rely on. With it, they are linked before you could click.
- Use `SIGSTOP`, not `SIGTERM`: a stopped server announces it is leaving, which is not what a dead laptop does. `verify.mjs down` sends `SIGCONT` before stopping, so frozen laptops still exit.
- Koppelen works from either side: the laptop with fewer runners takes the other's data. On laptop 0 (40 runners) the empty laptops have a `Koppelen` button that brings them over; next to a laptop that holds fewer runners of its own it reads `Druk op Koppelen op die laptop.` instead. Laptop 1's welcome screen lists only laptops with runners.
- With only one laptop left nothing saves until a second returns. That is correct, not a bug.
- A dead laptop that is not taken out still counts: linking a spare next to it makes four laptops that need three. `Uit de groep halen` is the fix, not a bug in linking. The button needs 30 s of silence counted by the current leader, so it shows later after a takeover.
- The group check needs real ms timing. Avoid running a 3-laptop run while the machine is under heavy load (another build, `npm run rehearse`), or elections can flap.
- `node scripts/validation/run.mjs failover-ui` and `race-day-ui` are the repo's regression checks for this; run them when you change cluster code.
