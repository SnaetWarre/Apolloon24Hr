# Runner totals across state reads

The six SQL aggregates are cached per runner, not persisted or replicated. A normal lap append
invalidates only its runner. Metadata, ordering and labels are always read afresh. Recalculation
uses the original SQL expressions, including SQLite's rounding, number types, duration bounds
and last-lap tie behavior.

SQLite update/commit/rollback hooks separate pending from committed invalidation. Preparing a
linked-laptop write and rolling it back does not discard valid committed totals. Corrections,
undo, imports, merges, restore, snapshot installation, startup, external/schema changes, unknown
writes and overflow of the bounded append journal take the full-query fallback. Up to 64
unobserved appended row IDs are retained before that conservative fallback.

HTTP state builds use fresh, pinned WAL readers, so a connection-local cache alone would not
help them. Readers fork a copy-on-write totals map and its committed invalidations. They publish
refreshed totals only if the source generation still matches; an old reader cannot overwrite
newer lap invalidations. Reads never write to SQLite or change the push token.

## Reproduce the query/state benchmark

Build release, server-only **unit-test executables** at base and head, including the identical
ignored fixture in `native/src/db/runner_totals_bench.rs`. The baseline needs only that file
and this declaration in `db.rs`; do not change its implementation:

```rust
#[cfg(test)]
#[path = "db/runner_totals_bench.rs"]
mod runner_totals_bench;
```

Use separate target directories for different worktrees. Cargo's timestamp-based freshness
checks can otherwise reuse the other worktree's executable. Link each worktree's `.rune` to
the same prepared Rune checkout, and retain the executable reported by Cargo's JSON output:

```sh
CARGO_TARGET_DIR=/absolute/base-target cargo test --release --locked \
  --manifest-path /absolute/base/native/Cargo.toml --no-default-features \
  --bin apolloon-native runner_totals_benchmark --no-run --message-format=json
CARGO_TARGET_DIR=/absolute/head-target cargo test --release --locked \
  --manifest-path native/Cargo.toml --no-default-features \
  --bin apolloon-native runner_totals_benchmark --no-run --message-format=json

node scripts/bench/runner-totals.mjs \
  --base /absolute/base-test-executable --head /absolute/head-test-executable \
  --pairs 10 --out /absolute/query-results
```

The fixture has 150 runners and 500/3,000/10,000 retained laps in a file-backed WAL database.
Each timed call follows one controlled lap append. Deleting that sample and warming the original
dataset happens outside timing, keeping the retained count fixed. Each run records 60 calls
per metric, discarding the first ten as warmup. All remaining observations are retained.

- `queryMs`: `Db::runners()`, including metadata, labels and JSON values.
- `stateMs`: `Db::race_snapshot()`, including runners, labels, race, undo and settings.
- `snapshotStateMs`: the HTTP path's `read_snapshot()?.race_snapshot()`, including opening and
  pinning and closing the WAL reader. HTTP serialization, host/cluster fields and history are
  not included.

Ten interleaved pairs alternate base/head order. The point estimate is the median of run means;
the confidence interval is a 20,000-resample paired bootstrap of `median(head) - median(base)`.
Intervals are pointwise 95%, not multiplicity adjusted. This measures a warm retained dataset;
it is not a cold-start/import benchmark.

## Reproduce loaded server CPU per lap

Build production release server-only binaries at base and head, again with separate target
directories. Build the same web client once with `npm run build`; run from the repo root or set
`APOLLOON_WEB_DIR` to its absolute path. On Linux with Playwright Chromium installed:

```sh
node scripts/bench/runner-totals-cluster.mjs \
  --base /absolute/base-server --head /absolute/head-server \
  --pairs 10 --laps 40 --spacing 1000 --renderer cpu --out /absolute/cluster-results
```

Each run starts three real Rust servers, independent SQLite/WAL files, HTTP membership and
quorum replication. The leader starts with 150 runners and 3,000 laps. Six live WASM screens
(Queue, Analyse, Tactiek, Inside, Competitions, Outside) are distributed two per node. They use
real state/history transport, with no response stubs or synthetic push injection. Backend
latency tracing is off. Renderer selection is asserted at startup; end-of-window evidence is
saved for every screen.

CPU canvas is forced equally in both versions to avoid the VM's shared SwiftShader GPU queue
dominating screen progress. `--renderer webgl2` instead requires WebGL2 throughout. The server
CPU result must not be compared across different renderer configurations. This harness does
not measure browser CPU, GPU completion, presentation, RSS or native frame time.

After eight seconds of settling/idle sampling, 40 scripted handoffs run at 1 Hz. This is an
accelerated race: newly recorded lap durations are short, while the retained fixture has valid
60,001-ms laps. CPU is the process-wide user + system tick delta from `/proc/<pid>/stat`, using
`getconf CLK_TCK`, divided by acknowledged laps. The window includes the final one-second
interval. Raw CPU includes idle/background work; five-second idle CPU rates are saved alongside
it, not subtracted. Bootstrap methodology matches the query benchmark.

Screens may coalesce pushes; every screen must keep polling, and per-screen response counts
are retained. Every new lap ID and the exact final count are checked on all three nodes, outside
the CPU window. Do not infer browser-visible latency from these CPU measurements.

**Hardware limitation:** three processes over loopback on one VM are not three physical laptops.
The comparison exercises the production replication path, but physical-network and independent
GPU/CPU behavior remain unmeasured.

## Measured query/state result

Base: `416e2bc`, versus this change; release server-only test executables, same prepared Rune
sources. Ten interleaved pairs per retained size, 150 runners. Values below are milliseconds,
medians of run means; intervals are head minus base.

| Retained laps | Timed work | Base | Head | Change | 95% CI, delta ms |
| ---: | --- | ---: | ---: | ---: | --- |
| 500 | Runners, including labels | 0.831 | 0.709 | -14.7% | [-0.138, -0.101] |
| 500 | Race state | 1.234 | 1.116 | -9.6% | [-0.143, -0.097] |
| 500 | WAL reader + race state | 1.645 | 1.549 | -5.8% | [-0.118, -0.007] |
| 3,000 | Runners, including labels | 1.590 | 0.713 | -55.2% | [-0.951, -0.860] |
| 3,000 | Race state | 2.067 | 1.105 | -46.6% | [-0.991, -0.946] |
| 3,000 | WAL reader + race state | 2.577 | 1.595 | -38.1% | [-1.049, -0.951] |
| 10,000 | Runners, including labels | 3.716 | 0.750 | -79.8% | [-3.043, -2.896] |
| 10,000 | Race state | 4.141 | 1.137 | -72.5% | [-3.093, -2.950] |
| 10,000 | WAL reader + race state | 5.107 | 1.749 | -65.8% | [-3.524, -3.261] |

All nine pointwise intervals exclude zero; the 500-lap WAL result is small and marginal, not a
large end-to-end win. These optimized, warm synthetic fixtures are not directly comparable
with earlier discovery-profile absolute timings.

## Loaded cluster CPU result

Ten interleaved pairs, 40 handoffs per run at 1 Hz, 3,000 retained laps, six live CPU-canvas
screens and three loopback Rust nodes as described above. Values are raw process CPU
milliseconds per acknowledged lap, medians of run means; intervals are head minus base.

| Metric | Base | Head | Change | 95% CI, delta CPU ms/lap |
| --- | ---: | ---: | ---: | --- |
| Leader | 34.375 | 32.375 | -5.8% | [-2.750, +0.750] |
| Sum of all three servers | 76.750 | 73.125 | -4.7% | [-6.250, +2.000] |

**Both intervals include zero: the loaded server CPU change is inconclusive.** The significant
query/state-builder savings do not establish a whole-server CPU improvement in this experiment.
Outliers were retained. This is not a measurement on three physical laptops, and no claim is
made about browser CPU, native frame time, Brotli or RSS.

All 800 scripted handoffs were acknowledged, with the exact new lap IDs and 3,040 final laps on
every replica in each run. The saved replication logs retain one Raft term from the final join
through all measured handoffs, so the measured leader did not change during a run.

Full raw samples, per-screen renderer/response evidence and summaries from this machine:

- `/home/ubuntu/runner-totals-query-final/{results,summary}.json`
- `/home/ubuntu/runner-totals-cluster-final/{results,summary}.json`
- Per-run logs and SQLite files in those directories.

Production server executable SHA-256:

```text
base c97c1c625cb2598c845315b8e5ca122d5fc30afdd358bb8d54c8e1369041dea4
head dc78f2769d5bf0d269f49e845e25a4bd551ce2f018445ed393b6fc104de6924f
```
