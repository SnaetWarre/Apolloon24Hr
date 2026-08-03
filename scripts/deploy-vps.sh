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
VPS_NODE_VERSION="${VPS_NODE_VERSION:-22.12.0}"
DEPLOY_SKIP_BUILD="${DEPLOY_SKIP_BUILD:-0}"
DEPLOY_ARTIFACT="${DEPLOY_ARTIFACT:-}"

target="${VPS_USER}@${VPS_HOST}"
release_id="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo manual)"
tmp_dir="$(mktemp -d)"

cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

if [[ -z "${DEPLOY_ARTIFACT}" ]]; then
  if [[ "${DEPLOY_SKIP_BUILD}" != "1" ]]; then
    npm run build
  fi

  DEPLOY_ARTIFACT="${tmp_dir}/apolloon-vps-${release_id}.tar.gz"
  tar \
    --exclude='node_modules' \
    --exclude='.vite-cache' \
    -czf "${DEPLOY_ARTIFACT}" \
    package.json \
    package-lock.json \
    dist \
    dist-server
fi

if [[ ! -f "${DEPLOY_ARTIFACT}" ]]; then
  echo "Deploy artifact not found: ${DEPLOY_ARTIFACT}" >&2
  exit 1
fi

remote_artifact="/tmp/apolloon-${release_id}.tar.gz"

echo "Uploading ${DEPLOY_ARTIFACT} to ${target}:${remote_artifact}"
scp "${DEPLOY_ARTIFACT}" "${target}:${remote_artifact}"

echo "Installing release ${release_id} on ${target}"
ssh "${target}" "bash -s" -- \
  "${remote_artifact}" \
  "${VPS_APP_DIR}" \
  "${VPS_DATA_DIR}" \
  "${VPS_SERVICE_NAME}" \
  "${VPS_APP_PORT}" \
  "${VPS_PUBLIC_HOST}" \
  "${VPS_PUBLIC_APP_PORT}" \
  "${release_id}" \
  "${VPS_NODE_VERSION}" <<'REMOTE'
set -euo pipefail

remote_artifact="$1"
app_dir="$2"
data_dir="$3"
service_name="$4"
app_port="$5"
public_host="$6"
public_app_port="$7"
release_id="$8"
node_version="$9"

if [[ "$(id -u)" -eq 0 ]]; then
  sudo_cmd=()
else
  sudo_cmd=(sudo)
fi

install_os_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    "${sudo_cmd[@]}" apt-get update
    "${sudo_cmd[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl xz-utils
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    "${sudo_cmd[@]}" dnf install -y ca-certificates curl xz
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    "${sudo_cmd[@]}" yum install -y ca-certificates curl xz
    return
  fi

  if command -v apk >/dev/null 2>&1; then
    "${sudo_cmd[@]}" apk add --no-cache ca-certificates curl xz
    return
  fi

  echo "Cannot install Node prerequisites automatically: unsupported VPS package manager." >&2
  exit 1
}

node_major() {
  if ! command -v node >/dev/null 2>&1; then
    echo 0
    return
  fi
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

install_node() {
  local machine arch platform install_dir url tmp_archive
  machine="$(uname -m)"
  case "${machine}" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)
      echo "Unsupported CPU architecture for automatic Node install: ${machine}" >&2
      exit 1
      ;;
  esac

  platform="linux-${arch}"
  install_dir="/opt/node-v${node_version}-${platform}"
  url="https://nodejs.org/dist/v${node_version}/node-v${node_version}-${platform}.tar.xz"
  tmp_archive="/tmp/node-v${node_version}-${platform}.tar.xz"

  install_os_packages
  if [[ ! -d "${install_dir}" ]]; then
    curl -fsSL "${url}" -o "${tmp_archive}"
    "${sudo_cmd[@]}" mkdir -p "${install_dir}"
    "${sudo_cmd[@]}" tar -xJf "${tmp_archive}" -C "${install_dir}" --strip-components=1
    rm -f "${tmp_archive}"
  fi

  "${sudo_cmd[@]}" ln -sfn "${install_dir}/bin/node" /usr/local/bin/node
  "${sudo_cmd[@]}" ln -sfn "${install_dir}/bin/npm" /usr/local/bin/npm
  "${sudo_cmd[@]}" ln -sfn "${install_dir}/bin/npx" /usr/local/bin/npx
}

if [[ "$(node_major)" -lt 22 || ! -x "$(command -v npm || true)" ]]; then
  echo "Installing Node.js ${node_version} on the VPS..."
  install_node
fi

node_bin="$(command -v node || true)"
npm_bin="$(command -v npm || true)"
if [[ -z "${node_bin}" || -z "${npm_bin}" || "$(node_major)" -lt 22 ]]; then
  echo "Node.js >= 22 and npm are required on the VPS." >&2
  exit 1
fi

releases_dir="${app_dir}/releases"
release_dir="${releases_dir}/${release_id}"
current_dir="${app_dir}/current"

"${sudo_cmd[@]}" mkdir -p "${release_dir}" "${data_dir}"
"${sudo_cmd[@]}" tar -xzf "${remote_artifact}" -C "${release_dir}"
"${sudo_cmd[@]}" rm -f "${remote_artifact}"
"${sudo_cmd[@]}" chown -R "$(id -u):$(id -g)" "${release_dir}"

cd "${release_dir}"
"${npm_bin}" ci --omit=dev --include=optional

"${sudo_cmd[@]}" ln -sfn "${release_dir}" "${current_dir}"

service_file="/etc/systemd/system/${service_name}.service"
"${sudo_cmd[@]}" tee "${service_file}" >/dev/null <<SERVICE
[Unit]
Description=Apolloon 24h tracker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${current_dir}
Environment=NODE_ENV=production
Environment=CLUSTER_ENABLED=false
Environment=DATA_PATH=${data_dir}
Environment=PORT=${app_port}
Environment=PUBLIC_HOST=${public_host}
Environment=PUBLIC_APP_PORT=${public_app_port}
Environment=APOLLOON_RELEASE_ID=${release_id}
ExecStart=${node_bin} dist-server/server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SERVICE

"${sudo_cmd[@]}" systemctl daemon-reload
"${sudo_cmd[@]}" systemctl enable "${service_name}.service" >/dev/null
"${sudo_cmd[@]}" systemctl restart "${service_name}.service"

ready=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:${app_port}/api/health" >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "${ready}" != "1" ]]; then
  echo "Apolloon readiness check failed." >&2
  "${sudo_cmd[@]}" journalctl -u "${service_name}.service" --no-pager -n 50 >&2
  exit 1
fi

health_json="$(curl -fsS "http://127.0.0.1:${app_port}/api/health")"
actual_release="$(printf '%s' "${health_json}" | "${node_bin}" -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => { process.stdout.write(JSON.parse(input).releaseId || ""); });
')"
if [[ "${actual_release}" != "${release_id}" ]]; then
  echo "Release verification failed: expected ${release_id}, got ${actual_release:-none}." >&2
  exit 1
fi

echo "Readiness verified for release ${actual_release}."

"${sudo_cmd[@]}" systemctl --no-pager --lines=20 status "${service_name}.service"

find "${releases_dir}" -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n +6 | xargs -r rm -rf

cat <<EOF

Apolloon deployed.
Local service: http://127.0.0.1:${app_port}
Public URL:    http://${public_host}:${public_app_port}
Data dir:      ${data_dir}
Service:       ${service_name}.service
EOF
REMOTE
