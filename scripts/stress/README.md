# Race stress harness

Run from the repository root on Linux (Node 24+, `/proc`, `getconf`):

```
npm run stress:race -- --hours 24 --ratio 60 --seed night-1
```

Defaults: 24 race-hours, 60x speed, `.tmp-stress/`, release native binary.
Flags: `--hours`, `--ratio`, `--seed`, `--out`, `--binary`, `--compare`.
The default binary is built only if missing. An explicit missing binary fails.
No dependencies are installed and no existing race databases are used.
Backups stay enabled, matching the event. Each run keeps three disposable DBs,
server logs and backups in a uniquely named subdirectory and writes one top-level
JSON. Delete the run directory after investigation if disk space is needed.

Lap deadlines and chaos start times are seeded race-time offsets; OS/election
timing and successful writes are not deterministic. The clock is compressed in
the driver, not in the product: persisted lap durations are wall time. Late
requests execute serially, so overload can extend the run. Five real-second
election freezes are intentionally not compressed. Setup, recovery and final
validation can add time beyond the requested race duration. Polls run every
second plus request time; resource samples every five seconds plus sample time.
At extreme ratios the first/last hour may contain no samples (reported as null).

Writes rotate through all screens, reading the current leader's state for the
optimistic handoff token. Completed runners return to the end of the queue.
No failed handoff is blindly retried: a timeout may already have committed.
Raw requests, acknowledged lap IDs and final histories expose this uncertainty.
All errors outside bounded chaos/recovery windows fail the run. Chaos recovery
uses idempotent status writes to a separate non-racing probe runner; those writes
are included in the metrics. Recovery reports first successful write, election
and full equal-log-head catch-up separately. CPU is process CPU (100% = one core).
Slopes use linear regression per race-hour, not per wall-hour.

The newest prior top-level JSON is compared automatically, or use `--compare`.
Only compare like-for-like machines, binaries, flags and seeds. Exit 1 means an
invariant/setup/comparison failure; inspect `failures`, requests and server logs.
The harness never modifies product sources or pushes commits.
