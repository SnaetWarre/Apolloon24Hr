#!/usr/bin/env bash
set -euo pipefail

VPS_HOST="${VPS_HOST:-185.102.172.74}"
VPS_USER="${VPS_USER:-root}"
LOCAL_HOST="${LOCAL_HOST:-127.0.0.1}"
LOCAL_PORT="${LOCAL_PORT:-5173}"
REMOTE_BIND="${REMOTE_BIND:-0.0.0.0}"
REMOTE_PORT="${REMOTE_PORT:-80}"

target="${VPS_USER}@${VPS_HOST}"
public_url="http://${VPS_HOST}"
if [[ "${REMOTE_PORT}" != "80" ]]; then
  public_url="${public_url}:${REMOTE_PORT}"
fi

if ! command -v ssh >/dev/null 2>&1; then
  echo "ssh is required but was not found in PATH." >&2
  exit 1
fi

if ! timeout 2 bash -c ":</dev/tcp/${LOCAL_HOST}/${LOCAL_PORT}" >/dev/null 2>&1; then
  echo "Nothing is listening on ${LOCAL_HOST}:${LOCAL_PORT}." >&2
  echo "Start Apolloon first with: sudo npm run dev:fresh" >&2
  exit 1
fi

cat <<EOF
Opening reverse tunnel:
  ${public_url} -> ${LOCAL_HOST}:${LOCAL_PORT} on this laptop

Share display views:
  ${public_url}/display/outside
  ${public_url}/display/inside

Keep this terminal open while sharing the app.
Stop the tunnel with Ctrl+C.

If the URL only works from the VPS itself, enable this on the VPS:
  GatewayPorts yes
  AllowTcpForwarding yes
then restart sshd.

EOF

set +e
ssh \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -N \
  -T \
  -R "${REMOTE_BIND}:${REMOTE_PORT}:${LOCAL_HOST}:${LOCAL_PORT}" \
  "${target}"
status=$?
set -e

if [[ "${status}" -ne 0 && "${REMOTE_PORT}" == "80" ]]; then
  cat >&2 <<EOF

The VPS refused remote port 80.

Most likely causes:
  - something on the VPS is already listening on port 80
  - sshd on the VPS does not allow remote forwards on public/privileged ports

Try the built-in fallback:
  sudo npm run tunnel:vps:8080

Then share:
  http://${VPS_HOST}:8080/display/outside
  http://${VPS_HOST}:8080/display/inside

If port 80 is required, check the VPS:
  sudo ss -ltnp 'sport = :80'
  sudo sshd -T | grep -Ei 'gatewayports|allowtcpforwarding|permitlisten'
EOF
fi

exit "${status}"
