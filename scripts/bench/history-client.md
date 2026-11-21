# Retained-history client benchmark

Build and save a base release server and matching `native/web-dist`, then build
head. Supply disposable SQLite fixtures named `500.db`, `3000.db`, `10000.db` with
those exact lap counts and at least one runner. The harness copies them; it never
opens the originals for writing. Example (paths are local benchmark inputs):

```sh
node scripts/bench/history-client.mjs \
  --fixtures .bench-data/fixtures \
  --base-binary .bench-data/base-server --base-web .bench-data/base-web \
  --pairs 12 --out .tmp-bench/history-client
```

Each pair alternates base/head order. Both run at 1366×768 in dark mode, on fresh
browser contexts and fresh database copies. Lap durations are normalized to
55–90 seconds; finish spacing is seven seconds. Each case has three warmup pushes
and five recorded pushes by default. These are controlled real-WASM transport
pushes, not real network/server latency or process CPU measurements.

## Renderer gate

WebGPU is disabled to prefer WebGL2, as in `native/scripts/check-web.mjs`.
Measurement waits for Rune's `web.handover.done` mark **and** a successful WebGL2
context, not merely a visible CPU bootstrap canvas. Renderer identity, context
types and marks are saved per run and checked after every push. A loss/failure
cannot silently mix renderers. Auto mode discards an incomplete WebGL2 attempt
and reruns the **entire** table with both versions forced to CPU. Use
`--renderer webgl2` to reject fallback or `--renderer cpu` to force CPU explicitly.

## In-page timing

Payload delivery over DevTools, JSON serialization and synthetic Response
construction finish **before** measurement. Delivery is aligned to a native RAF.
Identical, validated instrumentation wraps both generated wasm-bindgen callback
constructors, including callback cleanup. WASM itself is not modified.

The primary metric, `workMs`, sums outermost WASM callback wall time using
`performance.now()` inside the page, from response release through the end of the
Rune RAF in which the unique snapshot marker has been applied. This includes
transport decoding/history work in microtasks, UI polling, derivation, layout,
and synchronous drawing/submission. Nested callbacks are not double-counted.
Driver protocol tasks, idle waits, GPU completion/presentation and other threads
are excluded. `elapsedMs` separately records response-release-to-applied-frame
latency, including waits; `callbacks` checks that the instrumentation actually ran.
An unrelated Playwright RAF cannot terminate the measurement.

The benchmark fails rather than guessing if the binding constructors change, a
push does not reach an applied Rune frame, history recovery occurs unexpectedly,
or a renderer changes. The new timing boundaries are not numerically comparable
with earlier DevTools `Performance.TaskDuration` windows.

## Statistics and diagnostics

The independent unit is the browser run, not each push. First take the median of
its five samples, then the median across paired runs. `summary.json` reports a
deterministic 20,000-resample **paired** percentile bootstrap 95% confidence
interval for `median(head) - median(base)`. A lower bound above zero flags a
significantly slower row. Intervals are pointwise, not multiplicity-adjusted.
Use at least ten pairs for conclusions; defaults use twelve for all eighteen rows.
All raw pushes, run IDs and renderer evidence remain in `results.json`.

For a focused same-renderer diagnostic, use `--laps 3000 --routes analysis
--kinds one-lap --pairs 2 --trace --renderer webgl2`. Trace mode saves Chromium
traces and CPU profiles; do not mix those samples into the unprofiled table.
For Rust symbol names, supply an equivalent web build generated without
wasm-bindgen's `--remove-name-section`; verify its noncustom WASM sections match.
