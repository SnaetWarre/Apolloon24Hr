# Racing clock cost

```sh
node scripts/bench/queue-clock.mjs \
  --fixtures fixtures \
  --base-binary artifacts/base/apolloon-native --base-web artifacts/base/web \
  --head-binary artifacts/head/apolloon-native --head-web artifacts/head/web \
  --pairs 10 --seconds 60 --out results/queue-clock
```

Build each revision with `npm run build` and a release native binary, saving its
entire `native/web-dist` directory. Use the same fixtures and Chromium installation
for both. The fixture databases must contain 150 runners and 500/3000/10000 laps.
Baseline and head run sequentially, alternating AB/BA pairs. No build, test or
other benchmark should run during measurement.

Each fresh browser has one page. All retained lap/runner fields come from its
fixture. Race/active timestamps are normalized, and runners occupy both queue
lanes (one running, 75 waiting, 74 warming up). The browser receives one initial
snapshot; state pushes are held pending and registration reads return an empty
map. Thus network, DB updates and history application are excluded. `Date.now`
advances with in-page monotonic time, so the real app clocks and timers run at
their normal rates. Startup and a five-second warmup are excluded.

The in-page metric sums outermost generated WASM callback wall durations using
`performance.now`, excluding DevTools calls and idle gaps. It includes synchronous
UI, layout and drawing work, not GPU completion/presentation or all JavaScript.
Total browser process CPU and renderer-only CPU use the browser CDP session's
`SystemInfo.getProcessInfo` cumulative CPU seconds, summed over processes (each
counter includes all its threads), not a main-thread task-time proxy. Counters bracket the in-page measurement within
the two CDP roundtrips. Exited measured processes invalidate a run. Node and server
CPU are separate. Server CPU uses Linux `/proc/<pid>/stat` user+system ticks and
the system's `CLK_TCK`, on the same counter window. The backend is idle during
these windows because state pushes are held pending; this is not a loaded-server
benchmark and no server CPU reduction is expected. No RSS or native frame-time
metrics are collected. On software-rendered VMs GPU/browser process CPU matters;
these results do not represent a physical GPU or compositor's display latency.

Every run records renderer evidence and checks it before/after measurement,
rejecting handover/loss during the window. WebGL2 is the default. If unavailable,
restart the **whole** comparison with `--renderer cpu`; never mix renderers.
Rendered accessibility clock text must advance, and suspended/stalled windows
are rejected. Interrupted experiments should be preserved separately, not mixed
into a fresh uninterrupted run.

Default cases are Queue at each lap count plus Inside and Competitions at 3000
laps. Outside has no repeating clock; its deadline-driven flash expiry is tested
but is not a periodic workload. `--cases 3000:queue --pairs 2 --seconds 5` is a
short harness smoke check, not sufficient evidence for a performance claim.

`results.json` is checkpointed after each run. `summary.json` reports medians of
run means in ms/s, min–max spread, and a deterministic 20,000-resample paired
percentile bootstrap 95% CI for median(head) minus median(base). These are
pointwise intervals, not multiplicity adjusted. Keep all observations. First-pair
screenshots and per-run server logs live beside the raw results.

The frame counters separately record Rune rAF requests, rAF callbacks and WASM
callbacks containing WebGL draw/clear/blit calls. They count submitted work, not
GPU completion or physical display presentation. The GL probe also records each
draw callback's scissor bounding coverage, clipped to the canvas dimensions,
including intermediate framebuffer passes. This is a raster-work coverage proxy,
not Rune's logical damage rectangles; full-sized intermediate passes can make it
the whole viewport even when only a small area of the final image changed.
`scissorPixelsPerSec` sums those per-callback bounds. GPU-process CPU is reported
separately from renderer-only and whole-browser CPU.

`--diagnostic-clock-step-ms 1000` is an explicit control that advances the app's
clock in one-second steps while keeping the real browser scheduler. Its results
are marked diagnostic and must not be mixed with real-time performance samples.
