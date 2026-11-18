# Host Apolloon on the VPS

The **Deploy VPS** GitHub workflow builds the headless Rust server and Rune browser assets, opens a disposable SQLite database, then uploads the verified package over SSH. Start the workflow explicitly after the release commit is on `main`. This starts a standalone app on the VPS. Event laptops form their own group on the event network.

Configure the `production` environment with the existing `VPS_HOST`, `VPS_USER`, `VPS_SSH_PRIVATE_KEY`, and `VPS_KNOWN_HOSTS` secrets. Deployment variables specify the installation directory, data directory, service name, server port, and public host or port. The defaults are `/opt/apolloon`, `/var/lib/apolloon`, service `apolloon`, and port `3000`.

Before the first cutover, use Beheer to download a verified backup. The deploy script stops the old writer and uses the same SQLite file at `$VPS_DATA_DIR/data/app.db`. It starts the new systemd service with `apolloon-native --server`, checks its release identifier and browser entry point, and restores the previous service definition and executable pointer if startup fails.

For a manual deploy from a matching Linux environment, run `bash scripts/deploy-vps.sh`. Set `DEPLOY_ARTIFACT` to use an archive already built for the VPS with `apolloon-native` and `web-dist/` at its root. The host needs systemd, curl, tar, and SSH. The service runs under the unprivileged `apolloon` account.
