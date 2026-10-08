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
  port 45737). A laptop on its own lists the laptops it can join, so linking
  is one click. Laptops of a group use the announcements to find each other
  again when their addresses change; an announcement never joins or changes
  data by itself.
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

"Alleen verder werken" is the one decision left to a person, because only a
person can know that the other laptops are really gone and not just behind a
loose cable. It is only offered when no majority is reachable. Changes the
other laptops confirmed in the last moments before they failed may be missing
if this laptop had not received them yet.

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
Handoffs are not listed: they are the laps.

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

1. Link the laptops: on the second and third laptop, open Beheer › Systeem ›
   Laptops koppelen and click Koppelen next to the first laptop, which is
   listed by itself. Beheer › Voorbereiding shows "Alle 3 laptops zijn
   bereikbaar en hebben alle gegevens."
2. Open a TV page (`/display/outside`) in a browser on a fourth device.
3. Start a practice race on the timing laptop and time a few laps.
4. Pull the power (or battery) of the laptop that leads, unless that is the
   timing laptop; then pick another (Beheer › Systeem shows which one "ordent
   de wijzigingen"). Within a few seconds the others show "Eén laptop
   onbereikbaar". Press the timing key during those seconds: the lap still
   counts, with the time of the press.
5. Check that the TV reopened on another laptop within about five seconds
   (up to ten when the laptop that leads lost its power or cable).
6. Keep working on the queue desk and the warm-up post; everything saves.
7. Start the laptop again. It shows the same runners and laps within seconds,
   and the status returns to "Alles veilig".
8. Pull the network cable of one laptop for a minute, make changes on the
   others, and plug it back in. It catches up by itself.
9. Download the latest backup to a USB stick.

## Event-Day Check

Before timing starts:

1. Beheer › Voorbereiding shows all three laptops reachable and up to date.
2. The last backup is recent; download one to a separate device.
3. Every laptop is plugged into power and the router by cable. While the race
   runs, the desktop app keeps the screen on and the laptop awake, and asks
   before it closes; check that the operating system does not force sleep or
   updates anyway.
