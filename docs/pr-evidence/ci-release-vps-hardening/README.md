# CI, release and VPS hardening

Base: `80fa4316a7eacd43d38234aae3f822df4beb54bc`.
Branch: `fix/ci-release-vps-hardening`.

## Changes and evidence

- PR CI now runs type checking, unit tests, E2E/integration tests and Linux/Windows package startup checks. `Required CI` aggregates all three jobs and is enforced on `main`, including administrators.
- Package startup checks use a temporary database and verify the packaged version, SQLite readiness and populated renderer. Linux executes the extracted AppImage; Windows executes the packaged executable from `win-unpacked`. This does not test the Windows installer wizard or desktop shortcuts. CI disables Chromium's sandbox for these isolated smoke processes.
- Package homepage now names `SnaetWarre/Apolloon24Hr`.
- Release preparation verifies the selected tag against the checked out package version before creating a release or building installers. Matching and mismatching tag cases are covered by `tests/release-tag.test.mjs`.
- Production environment permits only `main`; its expected host key was obtained through the existing strict SSH connection and stored as `VPS_KNOWN_HOSTS`. GitHub concurrency prevents overlapping workflow deployments; server-side flock also covers manual deploys. Upload/release identifiers include a random suffix to avoid simultaneous upload collisions.
- The service uses `apolloon:apolloon`, a read-only filesystem except for its data and private temporary directories, no capabilities and no privilege escalation. Deployment stops SQLite before migrating data ownership. Release code remains owned by the privileged deployment account.

## Local validation

Linux laptop, Node 24.18.0. CI uses Node 22.

- `npm test`: 58 passed.
- `npm run check`: passed, including both type checks and client budget.
- `npm run test:e2e`: 23 passed, including SQLite, backup, replication and HTTP integration.
- `node --test tests/release-tag.test.mjs`: passed.
- `npm run electron:build:linux`: passed.
- `node scripts/package-smoke.mjs --ozone-platform=x11`: passed against the AppImage, version 2.0.0, SQLite ready and renderer populated. Window remains hidden throughout.
- `bash -n scripts/deploy-vps.sh` and `git diff --check`: passed.

Chromium's native headless Ozone mode exited unsuccessfully on this laptop; the hidden X11 window passed. Linux CI uses Xvfb. Windows startup is verified by the Windows CI job.

## Operational notes

Before migration, the live service had no User setting, data was owned by root, and SQLite quick_check returned ok. The previous service definition was saved to `/root/apolloon-service-before-hardening.conf`.

The service intentionally has no capability to bind privileged ports; use a reverse proxy for ports 80/443. Existing port 3000 is retained. To roll back service settings, restore the saved unit, reload systemd and restart. Root can still read the migrated data; no database restore is required for a service-only rollback.

References: [GitHub deployment controls](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments), [systemd execution controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html).
