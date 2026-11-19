#!/usr/bin/env bash
# Run under xvfb-run with xdotool, jq, and a built Linux native binary.
set -euo pipefail
cd "$(dirname "$0")/../.."
signal="${1:-KILL}"
case "$signal" in KILL|STOP) ;; *) exit 2 ;; esac

proof="$(mktemp -d)"
app= server= restored=
cleanup() {
    for pid in "$server" "$restored" "$app"; do
        if [[ -n "$pid" ]]; then kill -KILL "$pid" 2>/dev/null || true; fi
    done
    if [[ -n "$app" ]]; then wait "$app" 2>/dev/null || true; fi
    if [[ -f "$proof/server.log" ]]; then cat "$proof/server.log"; fi
    rm -r "$proof"
}
trap cleanup EXIT

ready() {
    for _ in {1..150}; do
        if "$@"; then return 0; fi
        sleep 0.1
    done
    return 1
}

port="$(node -e 'const s=require("node:net").createServer(); s.listen(0,()=>{console.log(s.address().port); s.close()})')"
url="http://127.0.0.1:$port"
mkdir -m 700 "$proof/runtime"
export XDG_RUNTIME_DIR="$proof/runtime" XDG_CONFIG_HOME="$proof/config"
export APOLLOON_NATIVE_DATA="$proof/app.db" APOLLOON_UPDATE_CHECK=0 CLUSTER_ENABLED=false
printf 'PORT=%s\n' "$port" >"$proof/.env"
native/target/debug/apolloon-native >"$proof/window.log" 2>&1 &
app=$!

ready curl -fs "$url/api/health" >/dev/null
window="$(ready xdotool search --all --onlyvisible --pid "$app" --name 'Apolloon Telsysteem')"
ready test -s "$proof/window-route"
open_timing() {
    xdotool mousemove --window "$window" 80 210 click 1
    grep -qx '/timing' "$proof/window-route"
}
ready open_timing
runner="$(curl -fsS -H 'Content-Type: application/json' -d '{"name":"Recovery runner","status":"waiting"}' \
    "$url/api/action/runners.create" | jq -er .id)"
pressed_at="$(node -p 'Date.now()')"
curl -fsS -H 'Content-Type: application/json' \
    -d "{\"activeRunnerId\":null,\"activeStartedAt\":null,\"pressedAt\":$pressed_at}" \
    "$url/api/action/race.handoff" >/dev/null

server="$(pgrep -P "$app" -f 'apolloon-native --server')"
kill -"$signal" "$app"
# Require the same server to keep answering even before the new renderer appears.
for _ in {1..150}; do
    curl -fsS "$url/api/state" >"$proof/state.json"
    kill -0 "$server"
    restored="$(pgrep -P "$server" -f 'apolloon-native' || true)"
    if [[ -n "$restored" ]]; then break; fi
    sleep 0.1
done
test -n "$restored"
wait "$app" 2>/dev/null || true
app=
ready xdotool search --all --onlyvisible --pid "$restored" --name 'Apolloon Telsysteem' >/dev/null
ready grep -qx '/timing' "$proof/window-route"
kill -0 "$server"
jq -e --arg runner "$runner" '.race.activeRunnerId == $runner' "$proof/state.json" >/dev/null
echo "PASS ($signal): Timing reopened while the original server kept timing the runner."
