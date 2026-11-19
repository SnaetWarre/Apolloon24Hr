# Apolloon Telsysteem

Lap counting for the Apolloon 24 Urenloop. The desktop app uses Rune. Its Rust server stores the race in SQLite and serves the same Rune screens in a browser.

## Set up the race laptops

1. Install the same Apolloon version on each laptop and connect them to the same wired network.
2. Start Apolloon on the first laptop and import registrations from Excel or CSV. Start it on the other laptops. They discover the group automatically. You can enter a laptop address directly on the welcome screen.
3. In **Beheer › Voorbereiding**, check that each laptop is ready. The app uses TCP port `5173` for the browser and UDP port `45737` for discovery. Use a DHCP reservation or **Beheer › Systeem & herstel › Vast netwerkadres** if the browser address needs to stay fixed.
4. Open the address shown in Apolloon in a browser on the second monitor. Choose **Binnenscherm**, **Competitiescherm**, or **Buitenscherm** and press F11 for fullscreen.
5. Download a backup from **Beheer › Systeem & herstel** before starting the race.

Before the race, linking merges registrations and labels. A shared registration counts once when name, email, and phone match. Linking protects race data as soon as a runner starts, including the first lap. A group of three can continue timing after one laptop drops out. The browser can move to a surviving laptop and retain its view.

For an upgrade from the previous desktop app, keep a separate backup and close that app before opening Apolloon 6.0. The default data folder carries over. Install 6.0 on every laptop before linking them. See [event rehearsal](docs/rehearse-hardware.md) and [recovery](docs/reliability-model.md).

## Build and verify

Use Rust, Git, Bash, curl, tar, a C compiler, and the platform windowing libraries. On Debian or Ubuntu install `build-essential pkg-config libxkbcommon-dev libwayland-dev libx11-dev libxi-dev libxcursor-dev libxrandr-dev`. Node.js 24 and npm are used by the verification, release, and Wrapped tools.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
bash native/scripts/build-web.sh
cargo run --locked --manifest-path native/Cargo.toml
```

On a fresh checkout, run `bash native/scripts/prepare-rune.sh` before invoking Cargo directly. The browser build already runs this step. Start only the server with `cargo run --locked --manifest-path native/Cargo.toml --no-default-features -- --server`. Development writes to `.native-data/app.db` by default. Set `APOLLOON_NATIVE_DATA` to use a different database.

```sh
npm ci
npx playwright install chromium
npm run check
npm test
npm run test:native
npm run test:browser
```

Read [native setup](native/README.md), [VPS deployment](docs/vps-deploy.md), and [Wrapped cards and mail](docs/wrapped.md).

## Prepare a release

After the release commit is on `main`, create a `native-v<version>` tag that matches `native/Cargo.toml` and has a section in [the changelog](CHANGELOG.md). The Release workflow checks the tag, builds and tests the Windows installer, macOS disk image, and Linux archive, then assembles a draft with SHA256 checksums. Its files can be inspected before publishing.

Publishing the draft copies the verified assets to the [public release feed](https://github.com/SnaetWarre/apolloon-releases/releases). Native Apolloon reads that feed under **Beheer › Systeem & herstel › Nu controleren**. The first tagged version for this cutover is `native-v6.0.0`. Once a later native version is available, verify that an installed copy finds it, creates a backup, installs it, and reopens the race database.
