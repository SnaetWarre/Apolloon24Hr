# Six-screen lap-to-screen benchmark (Linux/X11)

From the repository root, with Node 24+, Rust, wasm32-unknown-unknown,
wasm-bindgen matching Cargo.lock, Playwright Chromium, Python 3 + Pillow,
libX11 and xdotool, and an available `DISPLAY=:0`:

```sh
npm run bench:screens
npm run bench:screens -- --followers
npm run bench:screens -- --trace
npm run bench:screens -- --followers --trace
```

Tracing is off by default. With `--trace`, the report includes per-press native
previous-frame submit/present overlap, own apply, view build/acquire (excluding
apply), upload/encode, submit, present and frame-to-pixels time. Submit/present
are CPU wall times, not GPU execution or physical scanout. Missing boundaries
remain N/A. Request IDs join server waiter/worker/snapshot/serialization markers
to client headers/body/JSON parsing and history/apply markers. Proxy body byte
counts are encoded HTTP entity bytes, not TCP/IP framing; browser Resource Timing
also records decoded and encoded entity sizes. Proxy-to-client intervals include
decompression and client scheduling, and cannot identify network time alone.
State cache hits have no build/serialization sample; state/history time includes
both on misses. Opt-in instrumentation adds timestamp/logging overhead.

Builds the web bundle first and release desktop binary if either artifact is
missing. After source changes, rebuild explicitly before comparing:

```sh
bash native/scripts/build-web.sh
cargo build --release --locked --manifest-path native/Cargo.toml --bin apolloon-native
```

Each invocation creates `.tmp-bench/<timestamp>/`, three fresh databases and
three linked release servers, seeding 2,240 laps among 40 queued/running runners.
All runners belong to the first team; a competition against the second team is
configured. Backups and network discovery are disabled for disposable runs.

`--trace` (or `APOLLOON_LATENCY_TRACE=1`) opts into realtime-microsecond stage
records and refresh-cadence measurements. Native/server records are buffered on
a bounded channel and printed by a dedicated thread; no UI-frame-thread file I/O
is performed. With tracing off there are no timestamp reads, allocations or I/O
for records, and no frame callbacks are installed. The handoff correlation key is
the existing active-runner/start-time token, joined to the actual lap ID after
commit. Replica records come from the durable apply boundary in `cluster/log.rs`.
The notifier timestamp is the SQLite commit hook, before the durable commit
returns; state readers still wait for the database mutex to be released.

The trace adds `latency-events.json`, stage p50/p95/max in µs, observed native
drawn-frame intervals, browser rAF intervals, and browser clock resolution to the
summary. Native frame records use Rune's after-drawn callback. Rune does not call
its frame hooks on web: the benchmark instead observes WebGPU surface queue
submission, visible WebGL flush, or visible CPU canvas upload. Unsupported frame
boundaries remain N/A rather than being guessed from rAF. The response boundary
is after the majority-waiting action returns, not instrumentation inside Raft.
Neither API submission nor rAF proves physical scanout; native intervals reflect
the actual application workload, not a forced continuous animation. Browser
`frame → a11y` is explicitly NOT `frame → pixel`; the endpoint is unchanged from
the accepted baseline. Browser timestamps use `performance.timeOrigin +
performance.now`; observed clock quantization is reported per screen.
Five headed Chromium contexts render the public displays, queue and Timing at
1366x768. Native Timing uses the same release binary, attached to the leader.
`--followers` alternates browser origins across the two follower servers; native
Timing and writes stay on the leader. All three processes still share one VM:
this flag exercises replica visibility, not physical network latency.

Fifteen genuine Space presses are sent to the native Timing window with
`xdotool key --window`, timestamped immediately before injection, 21 seconds
apart. No measurement handoffs are submitted by the driver over HTTP. Spacing
respects the existing 20-second short-lap protection; no auto-confirmation is
used. Each run takes about five minutes. The measurement window starts before
the first injection and ends 100ms after the final native lap pixel appears.
Browser observations are retrieved after the rapid-press check, and can extend
beyond that traffic window. Percentiles use nearest rank; overall pools all six
surfaces (native pixels plus browser accessibility, not all-screen pixels).

After each press, full histories fetched directly from all three replicas must
preserve every seeded lap ID and contain exactly one additional unique lap ID,
identical across replicas. These driver reads bypass the counting proxies.
After the final lap becomes visible, a separate Space press approximately
300ms later must change the native lap-region pixels (short-lap modal) without
adding a lap on any replica. Escape dismisses it and must restore the previous
lap-region pixels. `native-short-lap-modal.png` must also be reviewed to verify
the modal says “Toch afklokken?”; the summary records that visual-review need.
The rapid press and its modal pixels are excluded from latency and traffic.
Protection: busy/dialog-open presses are ignored; otherwise laps under 20,000ms
require explicit confirmation. The separate 500ms double-click guard applies
to finishing the race, not ordinary handoffs.

Browser timestamps are MutationObserver observations of Rune's accessibility
mirror, not HTTP response completions: the newest lap's runner and personal lap
number for Timing, total laps for inside/competitions,
current runner for outside, and the first remaining waiting runner for queue.
Later rendered states can cover multiple handoffs. These are accessibility-tree
commit times, not physical monitor scan-out times. Raw trees are retained to
audit each match. Background browser throttling is disabled; rendering is not
deliberately disabled for covered windows.

Native crop calibration always uses leader Timing's layout (follower Timing
has a timing-owner warning that shifts its layout). In follower mode a temporary
leader page is opened and closed before measurement, leaving five browser screens.
Native captures use XGetImage of only the newest completed lap's runner badge
(40 for the final seeded lap, then 1–15 for the measured laps), with a 5ms
target period. Changed crops and their timestamps are retained. Exactly one
change between sends is required for each latency; zero/multiple changes make
that observation invalid rather than guessing. The summary reports maximum
actual sampling gap, because VM scheduling cannot guarantee 10ms deadlines.
Native is raised above the browser and kept visible; do not move/cover its
window or interact with the desktop during a run. `--setup-only` provides a
30-second calibration window, with no measurement summary.

Transparent local HTTP proxies count all six clients' state/history requests
and encoded response-body bytes (not headers/TCP framing). Driver setup and
token reads bypass the proxies. Summary rates are whole-window averages;
`traffic.json` retains request start times for one-second bins. Proxies stream
responses rather than buffering. Browser failover/status probes are separate.

Artifacts: summary JSON/Markdown, raw browser tree observations, native pixel
changes/crops, traffic, screenshots before/after, process logs and databases.
Only complete 15/15 observations on all six screens produce a valid summary.
Do not treat partial percentiles as a passing baseline. Software rendering,
shared CPU and loopback networking differ substantially from three real Macs.
