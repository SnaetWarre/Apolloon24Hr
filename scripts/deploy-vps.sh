#!/usr/bin/env bash
set -euo pipefail

VPS_HOST="${VPS_HOST:-185.102.172.74}"
VPS_USER="${VPS_USER:-root}"
VPS_APP_DIR="${VPS_APP_DIR:-/opt/apolloon}"
VPS_DATA_DIR="${VPS_DATA_DIR:-/var/lib/apolloon}"
VPS_SERVICE_NAME="${VPS_SERVICE_NAME:-apolloon}"
VPS_APP_PORT="${VPS_APP_PORT:-3000}"
VPS_PUBLIC_HOST="${VPS_PUBLIC_HOST:-${VPS_HOST}}"
VPS_PUBLIC_APP_PORT="${VPS_PUBLIC_APP_PORT:-${VPS_APP_PORT}}"

target="${VPS_USER}@${VPS_HOST}"
remote_shell='flock -w 600 /run/lock/apolloon-deploy.lock bash -s'
if [[ "$VPS_USER" != root ]]; then
  remote_shell="sudo -n $remote_shell"
fi

release_id="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)-${RANDOM}${RANDOM}"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

artifact="${DEPLOY_ARTIFACT:-$scratch/apolloon-vps.tar.gz}"
if [[ -z ${DEPLOY_ARTIFACT:-} ]]; then
  bash native/scripts/build-web.sh
  cargo build --release --locked --manifest-path native/Cargo.toml --no-default-features
  cp native/target/release/apolloon-native "$scratch/"
  cp -R native/web-dist "$scratch/"
  python3 native/scripts/check-package.py "$scratch/apolloon-native"
  tar -czf "$artifact" -C "$scratch" apolloon-native web-dist
fi

remote_artifact="/tmp/apolloon-$release_id.tar.gz"
scp -o StrictHostKeyChecking=yes -o BatchMode=yes "$artifact" "$target:$remote_artifact"
ssh -o StrictHostKeyChecking=yes -o BatchMode=yes "$target" "$remote_shell" -- \
  "$remote_artifact" "$VPS_APP_DIR" "$VPS_DATA_DIR" "$VPS_SERVICE_NAME" "$VPS_APP_PORT" \
  "$VPS_PUBLIC_HOST" "$VPS_PUBLIC_APP_PORT" "$release_id" <<'REMOTE'
set -euo pipefail

artifact="$1"
app_dir="$2"
data_dir="$3"
service="$4.service"
port="$5"
public_host="$6"
public_port="$7"
release_id="$8"
release="$app_dir/releases/$release_id"
current="$app_dir/current"
unit="/etc/systemd/system/$service"
database="$data_dir/data/app.db"

mkdir -p "$release" "$data_dir/data"
tar -xzf "$artifact" -C "$release"
rm -f "$artifact"
test -x "$release/apolloon-native"
test -s "$release/web-dist/index.html"
test -s "$release/web-dist/app_bg.wasm.gz"

if ! id apolloon >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$data_dir" --no-create-home --shell /usr/sbin/nologin apolloon
fi
test "$(id -u apolloon)" -ne 0

previous=$(readlink "$current" || true)
backup_unit=$(mktemp)
had_service=false
if [[ -f "$unit" ]]; then
  cp "$unit" "$backup_unit"
  had_service=true
fi

rollback() {
  local result=$?
  if [[ "$result" != 0 ]]; then
    systemctl stop "$service" || true
    if [[ -n "$previous" ]]; then ln -sfn "$previous" "$current"; else rm -f "$current"; fi
    if [[ "$had_service" == true ]]; then cp "$backup_unit" "$unit"; else rm -f "$unit"; fi
    systemctl daemon-reload || true
    if [[ "$had_service" == true ]]; then systemctl start "$service" || true; fi
  fi
  rm -f "$backup_unit"
  return "$result"
}
trap rollback EXIT

# Close the old writer before changing ownership or allowing SQLite to migrate.
if [[ "$had_service" == true ]]; then systemctl stop "$service"; fi
chown -R apolloon:apolloon "$data_dir"
chmod 750 "$data_dir"
chmod -R a+rX "$release"
ln -sfn "$release" "$current"

cat > "$unit" <<SERVICE
[Unit]
Description=Apolloon 24h tracker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=apolloon
Group=apolloon
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=$data_dir
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
WorkingDirectory=$current
Environment=CLUSTER_ENABLED=false
Environment=APOLLOON_NATIVE_DATA=$database
Environment=PORT=$port
Environment=PUBLIC_HOST=$public_host
Environment=PUBLIC_APP_PORT=$public_port
Environment=APOLLOON_RELEASE_ID=$release_id
ExecStart=$current/apolloon-native --server
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl start "$service"
for attempt in {1..20}; do
  health=$(curl -fsS --max-time 2 "http://127.0.0.1:$port/api/health" 2>/dev/null || true)
  if [[ "$health" == *'"ok":true'* && "$health" == *"\"releaseId\":\"$release_id\""* ]] &&
    curl -fsS --max-time 2 "http://127.0.0.1:$port/" | grep -Fq 'Apolloon laden'; then
    systemctl enable "$service"
    echo "Verified release $release_id at http://$public_host:$public_port"
    exit 0
  fi
  sleep 1
done

journalctl -u "$service" --no-pager -n 50 >&2
exit 1
REMOTE
