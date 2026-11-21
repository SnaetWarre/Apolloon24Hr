# Race stress harness

Run from the repository root on Linux (Node 24+, `/proc`, `getconf`):

```
npm run stress:race -- --hours 24 --ratio 60 --seed night-1
```

Defaults: 24 race-hours, 60x speed, summaries in `.tmp-stress-results/`, work
artifacts in `.tmp-stress/`, release native binary. The summary default moved
to keep work artifacts outside the summary folder even with no flags.
Flags: `--hours`, `--ratio`, `--seed`, `--out`, `--work`, `--binary`, `--compare`.
`--work` must be outside `--out`; neither the same folder nor its descendant.
The default binary is built only if missing. An explicit missing binary fails.
No dependencies are installed and no existing race databases are used.
Backups stay enabled, matching the event. Each run keeps three disposable DBs,
server logs, backups and `raw.json` in a uniquely named `--work` subdirectory.
`raw.json` holds all requests, acknowledgement IDs, full final histories, lap
schedule and resource samples. Delete that work directory after investigation
if disk space is needed. `--out` receives only a compact summary JSON: config,
chaos events, counts, percentile metrics with per-hour buckets, growth, failures,
comparison and at most 120 uniformly selected resource samples per laptop.
Growth and peak values still use all samples; metrics are rounded to 0.001.

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
Work artifacts expose this uncertainty without bloating the summary.
All errors outside bounded chaos/recovery windows fail the run. Chaos recovery
uses idempotent status writes to a separate non-racing probe runner; those writes
are included in the metrics. Recovery reports first successful write, election
and full equal-log-head catch-up separately. `outageMs` ends when restart/resume
begins; `caughtUpMs` and `recoveryMs` start there, including process startup but
excluding the planned downtime. `disruptionMs`, `newLeaderMs` and `firstWriteMs`
start at chaos onset; `firstWriteAfterRestoreMs` starts at restart/resume.
Write errors are split by chaos window and cause: injected-down transport,
live HTTP response, other transport, and no writable leader found by the driver.
A live response is never classified as an injected-down transport error, even
if the node was frozen earlier in that request. Writes still rotate to all nodes.
CPU is process CPU (100% = one core).
Slopes use linear regression per race-hour, not per wall-hour.

The newest prior top-level run JSON is compared automatically, or use `--compare`.
Unrelated/malformed JSON is ignored in automatic discovery. Legacy run files
are supported; their recovery times are normalized to the restore timestamp.
Only compare like-for-like machines, binaries, flags and seeds. Exit 1 means an
invariant/setup/comparison failure; inspect `failures`, requests and server logs.
The harness never modifies product sources or pushes commits.
