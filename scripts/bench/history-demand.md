# Demand-driven history

Base: `6635497992edd24470f6dd4222834ef7f8bdf325` (main before this change).
Both server binaries and WASM assets were built from their corresponding source.

## Reproduction

```sh
node scripts/bench/history-demand.mjs \
  --base /path/to/base/apolloon-native --head /path/to/head/apolloon-native \
  --base-assets /path/to/base/web-dist --head-assets /path/to/head/web-dist \
  --out /path/to/screens --pairs 5 --pushes 5
node scripts/bench/history-demand-cluster.mjs \
  --base /path/to/base/apolloon-native --head /path/to/head/apolloon-native \
  --base-assets /path/to/base/web-dist --head-assets /path/to/head/web-dist \
  --out /path/to/cluster --pairs 5 --laps 40 --spacing 500 --renderer cpu
```

Five paired runs at each of 500, 3,000 and 10,000 retained laps, alternating
base/head order by pair. Each fixture has 150 runners and one repeated historical
label. Chromium uses CPU canvas in both versions, 1366×768, fresh contexts.
All observations are retained. Values below are medians across runs. Bootstrap
intervals are pointwise 95% paired intervals, 20,000 resamples.

`decodedHistory` counts the inline `stateHistory` JSON. `scopeEncoded` is an actual
Brotli response-body measurement of the equivalent standalone `/api/history`
scope: compression of an inline field cannot be attributed independently from
the rest of `/api/state`. Lean standalone replies omit the inline cursor. The raw
results also record actual encoded first-state and per-push state transfer sizes
through Chromium CDP, including HTTP overhead. Those are whole-state transfers,
not history-only sizes. No compression settings were changed.

WASM memory means linear-memory capacity, not live allocation or RSS. Row counts
are delivered lap counts; the UI retains the accepted snapshot and transport
retains its identity index, not another complete payload. Full history remains
sticky within an app instance. The measurements are cold starts, with no modal
open and no prior full-history navigation.

The cluster uses three Rust/SQLite processes on one VM, not three physical
laptops. Ten live pages cover all nine routes plus Beheer Rondes. HTTP proxies
count server egress, including signed inter-node requests and all response
bytes; TCP/IP overhead and incoming browser requests are excluded. CPU sums
`/proc` user/system ticks for the three Rust processes, without idle subtraction
or proxy/browser CPU. Writes occur at 2 Hz with a trusted 60,001 ms lap duration.
Every acknowledged lap ID must exist on every replica. One Raft term must span
each measurement window. Cluster results also contain per-page first-load,
memory and push observations.

## Compatibility and visible behavior

Queue deliberately retains main's existing profile behavior: the RPC succeeds,
`State.profile` is populated, the board becomes inert, and no modal is rendered.
It does not request runner history. Beheer's lean profiles wait for their ten
rows and recover with full history on failure. Profiles over Timing/Overview
request full history to preserve the background page as well. Full routes keep
the existing deltas. Scope changes bypass old unchanged tokens, and scoped/full
cursors share a server epoch but cannot be used interchangeably for deltas.

Native element comparisons cover ties, duration corrections, removed/inserted
laps and historical label edits. Browser checks cover the existing Queue
behavior, deferred Beheer opening, failed scoped requests, lean/full transitions
and a scope-unaware server. Existing state-push verification covers markers,
restart and follower failover. No new loading text was added.

## Standalone results

Bytes are decimal bytes; memory is MiB. Each cell is base → head.

| Laps | Route | History decoded | Scope encoded | First state encoded | WASM MiB | Lap rows | State bytes/push |
|---:|---|---:|---:|---:|---:|---:|---:|
| 500 | `/` | 180234 → 2649 | 15341 → 524 | 18646 → 3846 | 19.44 → 18.00 | 500 → 7 | 3739.0 → 4056.0 |
| 500 | `/queue` | 180234 → 0 | 15341 → 0 | 18646 → 3454 | 36.13 → 34.69 | 500 → 0 | 6656.2 → 7123.6 |
| 500 | `/timing` | 180234 → 1929 | 15341 → 469 | 18646 → 3789 | 19.06 → 17.63 | 500 → 5 | 3739.0 → 3977.2 |
| 500 | `/admin` | 180234 → 0 | 15341 → 0 | 18646 → 3446 | 19.00 → 17.50 | 500 → 0 | 3739.0 → 3562.2 |
| 500 | `/admin?section=laps` | 180234 → 180234 | 15341 → 15328 | 18658 → 18725 | 24.63 → 24.88 | 500 → 500 | 3739.0 → 3738.8 |
| 500 | `/analysis` | 180234 → 180234 | 15341 → 15328 | 18646 → 18720 | 22.44 → 22.44 | 500 → 500 | 3739.0 → 3738.8 |
| 500 | `/tactics` | 180234 → 180234 | 15341 → 15328 | 18646 → 18720 | 24.81 → 24.81 | 500 → 500 | 3739.0 → 3738.8 |
| 500 | `/display/inside` | 180234 → 180234 | 15341 → 15328 | 18658 → 18720 | 23.75 → 23.75 | 500 → 500 | 3739.0 → 3738.8 |
| 500 | `/display/competitions` | 180234 → 180234 | 15341 → 15328 | 18646 → 18720 | 18.94 → 19.00 | 500 → 500 | 3739.0 → 3738.8 |
| 500 | `/display/outside` | 180234 → 180234 | 15341 → 15328 | 18658 → 18706 | 17.38 → 17.38 | 500 → 500 | 3739.0 → 3738.8 |
| 3000 | `/` | 1085297 → 2677 | 89623 → 525 | 91907 → 3780 | 27.00 → 18.06 | 3000 → 7 | 3667.8 → 3986.0 |
| 3000 | `/queue` | 1085297 → 0 | 89623 → 0 | 91944 → 3380 | 44.69 → 34.81 | 3000 → 0 | 6559.8 → 6979.6 |
| 3000 | `/timing` | 1085297 → 1949 | 89623 → 471 | 91944 → 3720 | 26.63 → 17.75 | 3000 → 5 | 3667.8 → 3906.0 |
| 3000 | `/admin` | 1085297 → 0 | 89623 → 0 | 91907 → 3340 | 26.81 → 17.50 | 3000 → 0 | 3667.8 → 3489.0 |
| 3000 | `/admin?section=laps` | 1085297 → 1085297 | 89623 → 89437 | 91944 → 91931 | 33.94 → 33.56 | 3000 → 3000 | 3667.8 → 3669.0 |
| 3000 | `/analysis` | 1085297 → 1085297 | 89623 → 89437 | 91907 → 91931 | 32.44 → 32.44 | 3000 → 3000 | 3667.8 → 3669.0 |
| 3000 | `/tactics` | 1085297 → 1085297 | 89623 → 89437 | 91907 → 91931 | 33.38 → 32.56 | 3000 → 3000 | 3667.8 → 3669.0 |
| 3000 | `/display/inside` | 1085297 → 1085297 | 89623 → 89437 | 91907 → 91931 | 31.44 → 31.44 | 3000 → 3000 | 3667.8 → 3669.0 |
| 3000 | `/display/competitions` | 1085297 → 1085297 | 89623 → 89437 | 91944 → 91931 | 26.69 → 26.63 | 3000 → 3000 | 3667.8 → 3669.0 |
| 3000 | `/display/outside` | 1085297 → 1085297 | 89623 → 89437 | 91898 → 91931 | 25.06 → 25.06 | 3000 → 3000 | 3667.8 → 3669.0 |
| 10000 | `/` | 3623051 → 2664 | 257792 → 526 | 260476 → 3875 | 48.38 → 17.88 | 10000 → 7 | 3791.0 → 4103.0 |
| 10000 | `/queue` | 3623051 → 0 | 257792 → 0 | 260476 → 3504 | 65.06 → 34.81 | 10000 → 0 | 7470.0 → 7228.0 |
| 10000 | `/timing` | 3623051 → 1940 | 257792 → 472 | 260476 → 3852 | 48.25 → 17.63 | 10000 → 5 | 3791.0 → 4029.2 |
| 10000 | `/admin` | 3623051 → 0 | 257792 → 0 | 260476 → 3474 | 48.50 → 17.50 | 10000 → 0 | 3791.0 → 3613.2 |
| 10000 | `/admin?section=laps` | 3623051 → 3623051 | 257792 → 257189 | 260476 → 260505 | 56.13 → 56.44 | 10000 → 10000 | 3791.0 → 3790.8 |
| 10000 | `/analysis` | 3623051 → 3623051 | 257792 → 257189 | 260476 → 260505 | 60.19 → 60.13 | 10000 → 10000 | 3791.0 → 3790.8 |
| 10000 | `/tactics` | 3623051 → 3623051 | 257792 → 257189 | 260476 → 260505 | 55.19 → 54.63 | 10000 → 10000 | 3791.0 → 3790.8 |
| 10000 | `/display/inside` | 3623051 → 3623051 | 257792 → 257189 | 260476 → 260505 | 53.25 → 53.19 | 10000 → 10000 | 3791.0 → 3790.8 |
| 10000 | `/display/competitions` | 3623051 → 3623051 | 257792 → 257189 | 260476 → 260505 | 48.63 → 48.63 | 10000 → 10000 | 3791.0 → 3790.8 |
| 10000 | `/display/outside` | 3623051 → 3623051 | 257792 → 257189 | 260476 → 260220 | 47.69 → 47.69 | 10000 → 10000 | 3791.0 → 3790.8 |

## Three-node results

**Steady-state CPU did not improve.** The cold-load/client-memory savings trade
against extra bounded snapshot work: 500/3k cluster CPU increases have positive
paired intervals. At 10k the CPU interval includes zero. Egress is approximately
unchanged, with a small measured increase at 10k. No idle subtraction was used.

| Laps | Metric | Base | Head | Change | 95% CI, head − base |
|---:|---|---:|---:|---:|---|
| 500 | leaderCpuPerLap | 18.25 | 20.00 | 9.59% | [0.75, 4.00] |
| 500 | clusterCpuPerLap | 39.50 | 42.25 | 6.96% | [1.00, 8.50] |
| 500 | serverBytesPerSecond | 161826.84 | 162274.72 | 0.28% | [-7.53, 1513.64] |
| 500 | serverBytesPerLap | 80912.45 | 81144.07 | 0.29% | [-1.97, 761.50] |
| 3000 | leaderCpuPerLap | 25.00 | 26.00 | 4.00% | [0.25, 3.75] |
| 3000 | clusterCpuPerLap | 59.25 | 61.00 | 2.95% | [0.75, 8.75] |
| 3000 | serverBytesPerSecond | 160540.51 | 160696.76 | 0.10% | [-271.23, 1860.53] |
| 3000 | serverBytesPerLap | 80275.57 | 80353.27 | 0.10% | [-138.63, 932.25] |
| 10000 | leaderCpuPerLap | 46.00 | 47.50 | 3.26% | [-2.75, 7.00] |
| 10000 | clusterCpuPerLap | 120.50 | 128.25 | 6.43% | [-7.25, 18.00] |
| 10000 | serverBytesPerSecond | 159259.85 | 161085.02 | 1.15% | [60.75, 3707.54] |
| 10000 | serverBytesPerLap | 79635.07 | 80544.50 | 1.14% | [26.30, 1845.55] |

CPU units are ms/lap; transfer units are bytes/s or bytes/lap as named.
All 1,200 acknowledged laps replicated exactly. Every run retained one Raft term.

### Per-screen observations with all pages open

Cells are base → head medians, with the same meanings as the standalone table.

| Laps | Route | History decoded | Scope encoded | First state encoded | WASM MiB | Lap rows | State bytes/push |
|---:|---|---:|---:|---:|---:|---:|---:|
| 500 | `/` | 180234 → 2649 | 15284 → 523 | 19174 → 4324 | 17.88 → 16.44 | 500 → 7 | 4713.8 → 5102.1 |
| 500 | `/queue` | 180234 → 0 | 15283 → 0 | 19177 → 3938 | 17.94 → 16.50 | 500 → 0 | 8914.1 → 8665.5 |
| 500 | `/timing` | 180234 → 1929 | 15283 → 468 | 19176 → 4286 | 17.88 → 16.44 | 500 → 5 | 4735.0 → 5001.2 |
| 500 | `/admin` | 180234 → 0 | 15284 → 0 | 19174 → 3911 | 18.19 → 16.75 | 500 → 0 | 4696.0 → 4520.7 |
| 500 | `/admin?section=laps` | 180234 → 180234 | 15283 → 15314 | 19177 → 19173 | 18.13 → 18.13 | 500 → 500 | 4729.5 → 4725.4 |
| 500 | `/analysis` | 180234 → 180234 | 15283 → 15315 | 19176 → 19174 | 18.69 → 18.69 | 500 → 500 | 4735.0 → 4728.1 |
| 500 | `/tactics` | 180234 → 180234 | 15284 → 15315 | 19175 → 19145 | 17.75 → 17.75 | 500 → 500 | 4696.1 → 4703.8 |
| 500 | `/display/inside` | 180234 → 180234 | 15283 → 15314 | 19202 → 19179 | 17.50 → 17.50 | 500 → 500 | 4729.6 → 4711.6 |
| 500 | `/display/competitions` | 180234 → 180234 | 15283 → 15314 | 19188 → 19170 | 17.50 → 17.50 | 500 → 500 | 4735.0 → 4727.9 |
| 500 | `/display/outside` | 180234 → 180234 | 15284 → 15315 | 19205 → 19170 | 17.13 → 17.13 | 500 → 500 | 4696.6 → 4703.6 |
| 3000 | `/` | 1085297 → 2677 | 89725 → 527 | 92620 → 4253 | 25.63 → 16.44 | 3000 → 7 | 4667.7 → 5059.4 |
| 3000 | `/queue` | 1085297 → 0 | 89723 → 0 | 92615 → 3863 | 25.69 → 16.56 | 3000 → 0 | 8731.5 → 8573.4 |
| 3000 | `/timing` | 1085297 → 1949 | 89723 → 472 | 92545 → 4213 | 25.63 → 16.50 | 3000 → 5 | 4684.1 → 4952.6 |
| 3000 | `/admin` | 1085297 → 0 | 89725 → 0 | 92620 → 3848 | 25.88 → 16.63 | 3000 → 0 | 4667.8 → 4471.5 |
| 3000 | `/admin?section=laps` | 1085297 → 1085297 | 89723 → 89483 | 92615 → 92565 | 25.88 → 25.88 | 3000 → 3000 | 4584.1 → 4676.4 |
| 3000 | `/analysis` | 1085297 → 1085297 | 89723 → 89482 | 92545 → 92565 | 26.31 → 26.31 | 3000 → 3000 | 4684.1 → 4673.9 |
| 3000 | `/tactics` | 1085297 → 1085297 | 89724 → 89483 | 92620 → 92487 | 25.50 → 25.50 | 3000 → 3000 | 4667.7 → 4622.4 |
| 3000 | `/display/inside` | 1085297 → 1085297 | 89722 → 89483 | 92491 → 92505 | 25.31 → 25.31 | 3000 → 3000 | 4584.1 → 4676.4 |
| 3000 | `/display/competitions` | 1085297 → 1085297 | 89724 → 89483 | 92503 → 92528 | 25.25 → 25.25 | 3000 → 3000 | 4684.1 → 4673.9 |
| 3000 | `/display/outside` | 1085297 → 1085297 | 89724 → 89483 | 92501 → 92563 | 24.94 → 24.94 | 3000 → 3000 | 4667.7 → 4622.4 |
| 10000 | `/` | 3623051 → 2664 | 257062 → 526 | 261240 → 4390 | 48.25 → 16.38 | 10000 → 7 | 4710.5 → 5145.9 |
| 10000 | `/queue` | 3623051 → 0 | 257061 → 0 | 261306 → 4000 | 62.63 → 16.50 | 10000 → 0 | 8893.6 → 8734.4 |
| 10000 | `/timing` | 3623051 → 1940 | 257062 → 472 | 261445 → 4353 | 48.25 → 16.50 | 10000 → 5 | 4510.9 → 5045.3 |
| 10000 | `/admin` | 3623051 → 0 | 257062 → 0 | 261240 → 3982 | 48.44 → 16.75 | 10000 → 0 | 4710.5 → 4555.9 |
| 10000 | `/admin?section=laps` | 3623051 → 3623051 | 257062 → 257062 | 261306 → 260318 | 53.38 → 54.06 | 10000 → 10000 | 4639.7 → 4554.7 |
| 10000 | `/analysis` | 3623051 → 3623051 | 257061 → 257063 | 261444 → 260389 | 58.63 → 57.00 | 10000 → 10000 | 4641.5 → 4652.9 |
| 10000 | `/tactics` | 3623051 → 3623051 | 257062 → 257062 | 261241 → 260462 | 54.38 → 54.38 | 10000 → 10000 | 4710.5 → 4731.1 |
| 10000 | `/display/inside` | 3623051 → 3623051 | 257062 → 257063 | 261571 → 260672 | 52.38 → 52.31 | 10000 → 10000 | 4639.7 → 4652.2 |
| 10000 | `/display/competitions` | 3623051 → 3623051 | 257061 → 257063 | 261219 → 260484 | 48.50 → 48.44 | 10000 → 10000 | 4425.2 → 4548.6 |
| 10000 | `/display/outside` | 3623051 → 3623051 | 257062 → 257062 | 261125 → 260652 | 47.31 → 47.31 | 10000 → 10000 | 4710.5 → 4731.1 |

The standalone and loaded-cluster tables are separate observations, not pooled.
Recent snapshots can send more per lap than one-row full-history deltas; this
change targets cold history and retained rows, not steady-state bandwidth.
