# Failover Rehearsal On The Event Laptops

Run this the week before the race, with the three event laptops on the event
router. `npm run rehearse -- --hardware` runs the same chaos as
`npm run rehearse`, but against the installed app on the real laptops: it
pulls power by killing the app, pulls cables with firewall rules (nft on
Linux, Windows Defender Firewall on Windows), freezes the app like a closed
lid, and sometimes cuts only two laptops off from each other while the third
still reaches both. A bot presses Space on the timing laptop and another
re-queues runners. At the end it heals everything and checks that every
laptop holds the same laps, with every confirmed lap exactly once.

The bots write into the real databases. The script saves a backup first and
restores it after a passing run, but run it before importing the real
runners if you can, and keep hands off Beheer while it runs: the restore
undoes every change made during the run.

## Once, The Day Before

1. Install the same Apolloon version on all three laptops, plug them into the
   event router by cable, and give each a fixed address (DHCP reservation, or
   Beheer › Systeem & herstel › Vast netwerkadres). Link them in Beheer ›
   Systeem › Laptops koppelen, or pass `--link` on the first run (laptops that
   join keep their own data in a backup).
2. Each Windows laptop, in PowerShell as administrator:
   - `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`, then
     `Set-Service sshd -StartupType Automatic; Start-Service sshd`.
   - Add this laptop's `~/.ssh/id_ed25519.pub` to
     `C:\ProgramData\ssh\administrators_authorized_keys`, then
     `icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant Administrators:F /grant SYSTEM:F`.
   - Log in on the desktop with that same administrator account and stay
     logged in: the script starts the app on that desktop.
   - Leave Windows Defender Firewall on. Rules in a profile that is off do
     nothing, and the script refuses to start.
3. This (Linux) laptop: allow `nft` without a password with
   `sudo visudo -f /etc/sudoers.d/apolloon-rehearse` and the line
   `warre ALL=(root) NOPASSWD: /usr/bin/nft`. Delete that file after the race.
4. Run `ssh <user>@<ip> hostname` to each Windows laptop once to accept its
   host key.
5. Copy `scripts/rehearse-laptops.example.json` to `rehearse-laptops.json` in
   the repository and fill it in. The first laptop is the timing laptop.
   `ssh` is left out for the laptop running the script. `app` is the AppImage
   path on Linux; on Windows it is found in the default install folders.

## The Run

```text
npm run rehearse -- --hardware --minutes=20          # automatic, nobody needed
npm run rehearse -- --hardware --minutes=20 --hands  # also real cables, lids, power buttons
```

With `--hands`, the script asks for one physical action every few minutes
("Pull the network cable of desk", "Close the lid of warmup", "Switch desk
off") and waits for Enter. Do the automatic run first, then a `--hands` run
with the people who will sit at the laptops. That run is the only one that
covers Windows lid sleep and a real cable.

- Ctrl+C once ends the chaos early, heals, and still checks and restores.
  Ctrl+C twice stops at once, but first removes the firewall rules and
  unfreezes the apps.
- `--seed=<n>` repeats a fault schedule. `--keep` keeps the rehearsal laps
  instead of restoring the backup.

## Reading The Result

A pass ends with `Every laptop holds the same laps, and every confirmed lap
exactly once.`, and every laptop is back to its runners and laps from before.

A failure lists what went wrong. The rehearsal laps stay on the laptops so
you can look at them, and the end of each laptop's server log is in
`.rehearse/`. Keep the seed and the output. When done, restore the backup it
names in Beheer › Systeem & herstel › Backup terugzetten on the timing
laptop.

- `... still saved with its cable pulled: the cut did not take`: the firewall
  left the connections between the laptops open. The test failed, not the
  app; check the firewall before trusting the run.
- Anything else (lap logs differ, a confirmed lap missing, two runners at
  once, an unexpected error on a press) is a bug in the app. Fix it before
  race day.

## If Something Is Left Behind

`npm run rehearse -- --hardware --heal` removes the rehearsal firewall rules,
unfreezes and starts the app on every laptop. By hand:

- Linux: `sudo nft delete table inet apolloon_rehearse`
- Windows: `Remove-NetFirewallRule -Group apolloon_rehearse`

The Windows laptops keep a scheduled task `ApolloonRehearse` that only runs
when the script starts it; `Unregister-ScheduledTask ApolloonRehearse`
removes it.
