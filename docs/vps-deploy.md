# VPS Deploy

This deploy path runs Apolloon on the VPS itself. It does not need a reverse SSH tunnel or a laptop that stays online.

## What Gets Deployed

`npm run deploy:vps` builds the app locally, uploads a tarball, and installs it as a systemd service on the VPS. When a clean checkout of the same commit is already running and healthy with the requested service settings, it exits before building or restarting the service.

The release code goes to:

```text
/opt/apolloon/releases/<timestamp>-<git-sha>-<random-suffix>
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
By default it installs Node `24.21.0` under `/opt/node-v24.21.0-linux-x64` and links `node`, `npm`, and `npx` into `/usr/local/bin`.

Override the bootstrap version if needed:

```bash
VPS_NODE_VERSION=24.21.0 npm run deploy:vps
```

The deploy script also expects:

```text
ssh
scp
tar
curl
systemd
flock
useradd
```

If you deploy as a non-root user, that user needs passwordless `sudo` for installing Node prerequisites, creating `/opt/apolloon`, creating `/var/lib/apolloon`, and managing the systemd service.

## Manual Deploy From This Laptop

Default target is the existing VPS:

```bash
npm run deploy:vps
```

To redeploy the same commit, for example after changing local build environment variables, run:

```bash
DEPLOY_FORCE=1 npm run deploy:vps
```

The fast check does not apply to a checkout with uncommitted files, an explicit `DEPLOY_ARTIFACT`, or `DEPLOY_SKIP_BUILD=1`. It also falls through to a full deploy when the service is stopped, unhealthy, or configured differently.

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

The service runs as the dedicated `apolloon` system account. Releases remain
owned by the deployment account; only the data directory is writable by the
service. The first deployment stops the service before migrating data ownership.
systemd limits filesystem writes to that directory and private temporary files,
removes capabilities, and prevents privilege escalation. Use a reverse proxy for
ports 80/443; the unprivileged application should use port 3000.

Manual and CI deployments share a server-side `flock`, held through readiness
verification and release cleanup. Concurrent deploys wait up to ten minutes.

## GitHub Actions Deploy

The workflow is `.github/workflows/deploy-vps.yml`.

It can be run manually from GitHub Actions with `workflow_dispatch` on `main`.
Configure a `production` environment restricted to the `main` branch. The workflow
uses that environment and the `apolloon-production` concurrency group without
cancelling a running deployment.

To auto-deploy every push to `main`, set repository variable:

```text
VPS_AUTO_DEPLOY=true
```

Required production environment secrets:

```text
VPS_SSH_PRIVATE_KEY
VPS_HOST
VPS_KNOWN_HOSTS
```

`VPS_KNOWN_HOSTS` contains the expected OpenSSH known_hosts entry, including the
hostname/IP used by `VPS_HOST`. Obtain it through an already trusted SSH connection
or the provider console and verify its fingerprint. Never establish trust using
an unauthenticated live `ssh-keyscan`. Both CI and manual deployment require a
matching saved host key; key rotation requires deliberately replacing that entry.

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
VPS_NODE_VERSION=24.21.0
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
