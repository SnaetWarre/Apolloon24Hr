# Six-screen lap-to-screen benchmark (Linux/X11)

From the repository root, with Node 24+, Rust, wasm32-unknown-unknown,
wasm-bindgen matching Cargo.lock, Playwright Chromium, Python 3 + Pillow,
libX11 and xdotool, and an available `DISPLAY=:0`:

```sh
npm run bench:screens
npm run bench:screens -- --followers
```

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
mirror, not HTTP response completions: total laps for Timing/inside/competitions,
current runner for outside, and the first remaining waiting runner for queue.
Later rendered states can cover multiple handoffs. These are accessibility-tree
commit times, not physical monitor scan-out times. Raw trees are retained to
audit each match. Background browser throttling is disabled; rendering is not
deliberately disabled for covered windows.

Native crop calibration always uses leader Timing's layout (follower Timing
has a timing-owner warning that shifts its layout). In follower mode a temporary
leader page is opened and closed before measurement, leaving five browser screens.
Native captures use XGetImage of only the static lap-total digits, with a 5ms
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
