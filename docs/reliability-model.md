# Reliability, Failover, And Backup Model

Apolloon keeps SQLite as the storage engine on every Electron laptop.
Reliability comes from three separate mechanisms, each for a different failure:

1. SQLite transactions protect one laptop from partial writes.
2. Three linked laptops each hold a full copy and take over from each other
   by themselves, for when a laptop fails.
3. Point-in-time backups keep older versions, for when a wrong action was
   copied to every laptop.

## Why This Model

At the event three laptops run the app: timing, the queue desk, and the
warm-up post. The people at those tables are not technical, so a failing
laptop must never need a decision or a manual step, and no two laptops may
ever disagree about the queue or the laps.

Apolloon therefore links the laptops into one group that chooses one of them
by majority vote (the Raft algorithm) to put every change in order. Any
laptop's screen can make changes: they are passed to that laptop. A change
counts as saved once two of the three laptops hold it, so losing any one
laptop loses nothing that was confirmed. Because a laptop can only take over
with a majority, a broken cable can never produce two laptops that each think
they are in charge, and nothing ever needs merging.

The cost of this guarantee: with only two of three laptops up, everything
works; with one, nothing is saved until a second is back (or someone
confirms that the others are gone for good, see below). Two linked laptops
are therefore not enough: then losing either one stops saving.

## How The Group Works

- One laptop leads each term. It writes every change and its replication log
  entry in one SQLite transaction, sends the entry to the others at once, and
  confirms the change to the screen once a majority stored it.
- A change made on another laptop's screen is passed to the leader, and the
  screen shows it as soon as its own copy has it. If the leader fails while a
  change is on its way, the change is repeated at the next leader; a request
  id makes sure it is applied exactly once.
- The leader sends a heartbeat every 150 ms. When a laptop hears nothing for
  1.5 to 3 seconds, it first asks the others whether an election could
  succeed, then asks for their votes. Only a laptop holding every confirmed
  change can win, so a takeover never loses confirmed data.
- A leader that cannot reach a majority for 1.5 seconds steps down, so a
  laptop on the wrong side of a broken cable stops saving instead of
  recording changes that the others never see.
- A laptop that returns (restarted, or its cable plugged back in) hears from
  the current leader, catches up, and carries on. If it holds changes the
  group never confirmed, it backs up its database (`pre-resync`) and installs
  a full copy from the leader.
- Browsers (TVs, extra screens) remember the laptops and reopen the same page
  on another laptop when theirs dies. A browser notices within 2.5 seconds
  that its laptop stopped answering, then asks the other laptops: once they
  have a leader and say they lost that laptop too, and it has still not
  answered two seconds after the browser lost it, the browser moves. A laptop
  that is back within two seconds never moves a screen, and in
  `npm run bench:failover` freezes of up to three seconds did not either. When the others cannot
  say (too few laptops left, or they still reach it), the browser moves after
  eight seconds. The Electron app always stays on its own laptop.
- Every laptop announces itself on the LAN every two seconds (UDP broadcast,
  port 45737). Laptops of a group use the announcements to find each other
  again when their addresses change. A laptop on its own lists the laptops it
  can join, so linking is one click.
- A laptop whose group holds no runners links by itself, within about five
  seconds, with the other laptops it hears: with the group that holds runners,
  or between empty groups the way Koppelen would link them, so only one side
  moves. A group that holds runners never links by itself; that stays a press
  on Koppelen. An empty laptop that hears two groups with runners does not
  guess: it says so and waits for a press. Beheer › Systeem & herstel and the
  overview name the laptops that linked by themselves ("Automatisch gekoppeld
  met LAPTOP-TIJD, 3 minuten geleden"). `CLUSTER_AUTO_LINK=false` turns it
  off.
- Koppelen links the same way whichever laptop it is pressed on. A group
  where the race started (or a lap was counted) keeps its data against one
  where it did not, whatever the runner counts, so a spare laptop with the
  registration list takes the running race instead of replacing it. Between
  two groups alike in that, the side with fewer runners takes the other's
  data. The laptop that takes the data keeps a backup of its old database.
- Laptops only link when app version and database schema are identical.

```text
screen ──► own laptop ──► leader ──► other laptops
                            │            │
                            ◄── stored ──┘   (confirmed once 2 of 3 hold it)
```

## Timing Precision

- A press is dated from its key event, converted to the group clock, so
  the time the request needs, and any wait during a takeover, does not count.
- A lap is the time between the timing screen's own two presses on the
  browser's monotonic clock. The server uses it when it is within 250 ms of
  the clock difference, and falls back to the clock difference otherwise
  (after a page reload or a switch to another laptop).
- The group clock follows the leader. Every laptop measures its offset to the
  leader every two seconds, keeping the fastest recent round trip, and a
  laptop that takes over keeps its offset, so times stay continuous.

## When Laptops Fail

| What happens | What the laptops do | What people do |
| --- | --- | --- |
| Any one laptop dies or loses its cable | The other two carry on; a new leader is chosen within about 3 s if needed. A key press during the takeover waits and then counts with its original time. | Nothing. Bring the laptop back when convenient; it catches up by itself. |
| A laptop comes back | It catches up, or re-syncs after a backup of its own data. | Nothing. |
| Two laptops are down | The last one shows "Te weinig laptops bereikbaar" and saves nothing. | Turn a second laptop on or fix the cable. Only if both others are truly gone: Beheer › Systeem › "Alleen verder werken". |
| After "Alleen verder werken" the others return | They follow the laptop that went on alone and keep their own data in a `pre-resync` backup. | Nothing. |
| One laptop is gone for good (broken, stolen, dropped) | The other two carry on, but a laptop that will never come back still counts. A spare linked next to it makes four laptops that need three for a majority, so it adds no safety. After 30 s without an answer, Beheer › Systeem offers "Uit de groep halen" next to it. | Click "Uit de groep halen" next to the dead laptop, then link a spare (an empty laptop links by itself; on a spare that holds runners, press Koppelen, and it takes the group's race). The group is three laptops again and one more may fail. |
| A laptop taken out of the group comes back | It is not taken back in by itself. It saves nothing and Beheer › Systeem on it says "Deze laptop is uit de groep gehaald". | Only if it works again: click "Opnieuw koppelen" on it. It takes the group's data and keeps its own in a `pre-join` backup. |

"Alleen verder werken" is the one decision left to a person, because only a
person can know that the other laptops are really gone and not just behind a
loose cable. It is only offered when no majority is reachable. Changes the
other laptops confirmed in the last moments before they failed may be missing
if this laptop had not received them yet.

"Uit de groep halen" is the other one. It is a replicated write on the
leader, like adding a laptop, and changes the group by one laptop at a time:
it waits until a majority holds every earlier write, so it never overlaps
another change to the group. It is only offered while the group has a
majority, for a laptop the leader has not heard from for 30 seconds, and
never for the leader itself; a laptop that just restarts or loses its cable
for a moment is back well within that time. The group then needs a majority
of the laptops that are left, so removing a dead laptop never takes safety
away. The removed laptop stays on a replicated list
(`cluster_removed_json`). When it asks for votes, the others answer that it
was taken out, and the leader does not take it back in by itself, unlike a
laptop left out by "Alleen verder werken". A laptop that broke once may break
again, and taking it back in by itself would make the group bigger without
the crew knowing, so the next failure could stop all saving. Koppelen on that
laptop ("Opnieuw koppelen") brings it back on purpose and takes it off the
list. Beheer › Activiteit lists the removal with the screen it came from.

### Laptop addresses

The laptops find each other by their announcements, also when every address
changes at once (another router, new DHCP leases). Browsers (TVs, extra
screens) only know the address they opened and the laptops they learned
while connected, so give each laptop a fixed address anyway: a DHCP
reservation on the event router, or, when the router cannot be configured,
Beheer › Systeem & herstel › Vast netwerkadres on each laptop. That panel pins
the wired adapter through the operating system's permission prompt, opens TCP
5173 and UDP 45737 in the firewall, and switches the adapter back to DHCP
after the event; its scripts are also downloadable for manual use. On
Windows the installer already opens the same two firewall rules (it asks for
permission once, only when a rule is missing) and removes them on uninstall.

## Backup Policy

Every laptop runs its own backup scheduler, every five minutes by default. A
backup is kept only after all of these steps succeed:

1. `node:sqlite` creates an online backup into a temporary file.
2. A worker thread converts it to a single rollback-journal file and runs
   `PRAGMA quick_check` and `PRAGMA foreign_key_check`, so the checks never
   delay a timing request.
3. The file is flushed and atomically renamed.

Retention keeps the 48 newest scheduled backups (four hours at the default
interval) and the 20 newest manual and safety backups (taken before joining
or re-syncing). Admin shows the last backup, failures, free disk space, and
offers a backup download.

```text
<DATA_PATH>/backups/apolloon-<time>-<reason>-<id>.sqlite
```

Configuration overrides:

```text
BACKUP_ENABLED=false
BACKUP_INTERVAL_MS=300000
BACKUP_INITIAL_DELAY_MS=10000
BACKUP_MIN_FREE_BYTES=2147483648
```

## Recovery Runbook

A failed laptop needs no recovery: the others carry on. Use a point-in-time
backup when every laptop holds the same wrong change, such as a deleted runner
or a wrong import.

Beheer › Activiteit shows what changed, when, and from which screen and
address, so the moment before the mistake is easy to find. Each entry is saved
in the same write as the change, so every laptop lists the same activity.
Handoffs are not listed: they are the laps. The laptops list their own changes
too, with `Vanzelf · laptop <name>` as where: a laptop that links (with
Koppelen or by itself), a laptop with a new address, "Alleen verder werken",
"Uit de groep halen" (with the screen it was clicked on), and a laptop that stopped answering for five seconds and the moment it is back.
The laptop that leads writes those last two; a laptop that takes over goes on
from the same list (`cluster_unreachable_json`), so a laptop that stays away is
listed once.

Restoring a backup, from any linked laptop:

1. Open Beheer › Systeem & herstel › Backup terugzetten on the laptop that
   holds the backup; each laptop lists its own.
2. Click Terugzetten next to the backup. The confirmation shows how many
   runners and laps it holds, and warns when the race was running then.
3. The laptop sends the backup's event data to the leader. The leader saves a
   verified `pre-restore` backup of the current group state, retrying if a write
   arrives while the backup is being checked, then restores as one ordinary
   replicated write. Every linked laptop changes at once; nobody stops or
   relinks a laptop. The activity log and the group itself are not restored.
4. If the race was running at the backup, the runner on the track then is on
   the track again with the start time of then. Check the timing screen.

A restore can be undone by restoring its `pre-restore` backup on the laptop
named in the restore result. When no laptop survives, copy a backup from USB
to `<DATA_PATH>/backups/` on a new laptop,
start Apolloon, and restore it there.

A laptop whose database a power cut or disk error damaged still starts. On
every start the server runs `PRAGMA quick_check` on a read-only connection
(about 1.4 ms on the verify skill's `large` scenario, 70 ms on a 54 MB file).
When SQLite cannot read the file, the server moves `data/app.db` and its
`-wal` and `-shm` files to `data/app.damaged-<time>.sqlite`, unchanged, and
starts with an empty database. The `backups/` folder stays as it was. The
welcome screen and Beheer › Systeem & herstel › Herstelbackups name the file
it put aside. Then:

1. Link the laptop to the group again. An empty laptop links by itself
   within a few seconds; otherwise click Koppelen on the welcome screen.
2. When no other laptop holds the data, restore one of this laptop's own
   backups in Beheer › Systeem & herstel › Backup terugzetten.

The desktop app says "De databank op deze laptop is beschadigd en kon niet
opzij gezet worden." only when moving the file failed, for example because a
virus scanner held it. Close other programs and press Opnieuw proberen. If
that keeps failing, press Logmap openen, move `app.db` out of the `data`
folder there, leave `backups` alone, and press Opnieuw proberen.

## How The Failover Is Tested

- `npm test` runs the consensus code for hundreds of seeded random runs on
  a fake clock and network: laptops crash, sleep, and lose cables (also one
  way), messages are lost, late, or duplicated, and clocks jump. After
  every step it checks that there is one leader per term, that no confirmed
  change is lost, and that no lap counts twice; afterwards the group must
  recover by itself. A failing seed replays exactly.
- `npm run rehearse` does the same with three real servers on one machine
  and a bot pressing Space, and compares the lap logs of all laptops.
- `npm run rehearse -- --hardware` does it on the three event laptops over
  SSH, with firewall rules for cables, also between only two of them; see
  `docs/rehearse-hardware.md`.
- `npm run bench:failover` opens a TV and a browser operator on one of three
  real servers, crashes or freezes that laptop, and measures how long until
  each screen shows its page from another laptop; it also checks that
  freezes of one to three seconds move no screen.

## Rehearsal Before The Event

Do this once with the three event laptops on the event router, with the
people who will sit at them watching.

1. Link the laptops: start the app on the second and third laptop while they
   are still empty. They link with the first laptop by themselves within a few
   seconds; Beheer › Systeem › Laptops koppelen says "Automatisch gekoppeld
   met" and the first laptop's name. A laptop that already holds runners does
   not link by itself; on it, click Koppelen next to the first laptop. Beheer › Voorbereiding
   shows "Alle 3 laptops zijn bereikbaar en hebben alle gegevens."
2. Open a TV page (`/display/outside`) in a browser on a fourth device.
3. On the timing laptop, open Beheer › Systeem & herstel and press `Nu backup
   maken`. Write down the time of that backup. It holds the runners from
   before the practice race; the last step puts them back.
4. Start a practice race on the timing laptop and time a few laps.
5. Pull the power (or battery) of the laptop that leads, unless that is the
   timing laptop; then pick another (Beheer › Systeem shows which one "ordent
   de wijzigingen"). Within a few seconds the others show "Eén laptop
   onbereikbaar". Press the timing key during those seconds: the lap still
   counts, with the time of the press.
6. Check that the TV reopened on another laptop within about five seconds
   (up to ten when the laptop that leads lost its power or cable).
7. Keep working on the queue desk and the warm-up post; everything saves.
8. Start the laptop again. It shows the same runners and laps within seconds,
   and the status returns to "Alles veilig".
9. Pull the network cable of one laptop for a minute, make changes on the
   others, and plug it back in. It catches up by itself.
10. Download the latest backup to a USB stick.
11. Remove the practice race. The app has no reset button. Without this step
    the first press on race day continues the practice race: the race clock
    counts from the rehearsal and the practice laps count in every ranking.
    - Wait until all three laptops show "Alles veilig".
    - On the timing laptop, open Beheer › Systeem & herstel. The list under
      Backup terugzetten only shows the backups of the laptop you are on, so
      use the same laptop as in step 3.
    - Find the backup from step 3: the time you wrote down, with Handmatig in
      the Soort column. Press `Terugzetten` next to it and confirm with
      `Terugzetten`. All linked laptops go back together.
    - Everything changed after step 3 is undone, also changes to runners.
    - The practice race is not lost: the app keeps it in a backup marked
      `Vóór terugzetten`. The message after the restore says on which laptop.
12. On every laptop, check that Overzicht says `Race nog niet gestart`,
    Analyse shows 0 rondes, and the big button in Timing says `Start` with the
    first runner's name, not `Race hervatten`.

## Event-Day Check

Before timing starts:

1. Beheer › Voorbereiding shows all three laptops reachable and up to date.
2. Overzicht says `Race nog niet gestart`. If it shows a start time or
   `Race afgesloten`, the practice race is still there: remove it as in the
   last steps of the rehearsal before the first runner starts.
3. The last backup is recent; download one to a separate device.
4. Every laptop is plugged into power and the router by cable. While the race
   runs, the desktop app keeps the screen on and the laptop awake, and asks
   before it closes; check that the operating system does not force sleep or
   updates anyway.
