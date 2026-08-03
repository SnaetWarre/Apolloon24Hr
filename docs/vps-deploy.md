# VPS Deploy

This deploy path runs Apolloon on the VPS itself. It does not need a reverse SSH tunnel or a laptop that stays online.

## What Gets Deployed

`npm run deploy:vps` builds the app locally, uploads a tarball, and installs it as a systemd service on the VPS.

The release code goes to:

```text
/opt/apolloon/releases/<timestamp>-<git-sha>
/opt/apolloon/current -> latest release
```

Live SQLite data stays outside the release:

```text
/var/lib/apolloon/data/app.db
/var/lib/apolloon/backups/
```

Deploying new code does not overwrite the live database or its versioned backups.

## VPS Prerequisites

The deploy script can install Node.js automatically when deploying as `root` or as a user with passwordless `sudo`.
By default it installs Node `22.12.0` under `/opt/node-v22.12.0-linux-x64` and links `node`, `npm`, and `npx` into `/usr/local/bin`.

Override the bootstrap version if needed:

```bash
VPS_NODE_VERSION=22.12.0 npm run deploy:vps
```

The deploy script also expects:

```text
ssh
scp
tar
curl
systemd
```

If you deploy as a non-root user, that user needs passwordless `sudo` for installing Node prerequisites, creating `/opt/apolloon`, creating `/var/lib/apolloon`, and managing the systemd service.

## Manual Deploy From This Laptop

Default target is the existing VPS from the tunnel script:

```bash
npm run deploy:vps
```

Override values when needed:

```bash
VPS_HOST=185.102.172.74 \
VPS_USER=root \
VPS_APP_PORT=3000 \
VPS_PUBLIC_APP_PORT=3000 \
npm run deploy:vps
```

After deploy:

```text
http://185.102.172.74:3000
http://185.102.172.74:3000/display/outside
http://185.102.172.74:3000/display/inside
```

The deploy script waits for `/api/health` and verifies that its `releaseId`
matches the versioned release directory before declaring success. This catches
a process that is reachable but still running the previous build.

If you want plain port 80 and nothing else is using it on the VPS:

```bash
VPS_APP_PORT=80 VPS_PUBLIC_APP_PORT=80 npm run deploy:vps
```

## GitHub Actions Deploy

The workflow is `.github/workflows/deploy-vps.yml`.

It can be run manually from GitHub Actions with `workflow_dispatch`.

To auto-deploy every push to `main`, set repository variable:

```text
VPS_AUTO_DEPLOY=true
```

Required repository secrets:

```text
VPS_SSH_PRIVATE_KEY
VPS_HOST
```

Optional repository secrets:

```text
VPS_USER
```

Optional repository variables:

```text
VPS_APP_DIR
VPS_DATA_DIR
VPS_SERVICE_NAME
VPS_APP_PORT
VPS_PUBLIC_HOST
VPS_PUBLIC_APP_PORT
VPS_NODE_VERSION
```

Defaults:

```text
VPS_USER=root
VPS_APP_DIR=/opt/apolloon
VPS_DATA_DIR=/var/lib/apolloon
VPS_SERVICE_NAME=apolloon
VPS_APP_PORT=3000
VPS_PUBLIC_HOST=$VPS_HOST
VPS_PUBLIC_APP_PORT=$VPS_APP_PORT
VPS_NODE_VERSION=22.12.0
```

## VPS Operations

Check service:

```bash
systemctl status apolloon
```

Follow logs:

```bash
journalctl -u apolloon -f
```

Restart manually:

```bash
systemctl restart apolloon
```

The deploy script keeps the latest five releases under `/opt/apolloon/releases`.
