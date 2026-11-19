---
name: verify-apolloon
description: Drive the real Apolloon native desktop or browser with disposable race data to verify changes an operator can see, including Timing, Wachtrij, Beheer, public screens, and laptop failover.
---

# Verify Apolloon

Build and drive the Rune app against a real Rust server. See [operator workflows](features/README.md) for the affected screen and what needs to persist. Use scratch SQLite files, fresh ports, and a virtual display or headless Chromium. Keep the user's race data, profiles, and open windows out of the run.

```sh
npm ci
npx playwright install chromium
npm run build
npm run test:native
npm run test:browser
```

- `native/scripts/check-web.mjs` exercises timing and import in Chromium and saves screenshots and server output. Pass `--cpu` to disable both GPU backends.
- `native/scripts/check-failover.mjs` pairs three servers and verifies browser fullscreen and recovery on a surviving laptop.
- `xvfb-run -a bash native/scripts/check-renderer-recovery.sh KILL` checks desktop recovery during an active lap. Use `STOP` for a frozen window. Requires `xdotool`, `jq`, and the desktop build.
- `python3 native/scripts/check-package.py /path/to/staged/apolloon-native` starts the packaged server from outside the checkout and reads the browser entry point and WASM.

For another operator flow, run the built server with an unused `PORT`, a scratch `APOLLOON_NATIVE_DATA`, and `CLUSTER_ENABLED=false` for a solo run. Use a headless Playwright viewport of 1366×768 for operator screens and 1920×1080 for public screens. Seed data through the server or copy a disposable SQLite database. Drive controls through actual clicks and keyboard events, then assert the saved state separately through the HTTP API. Capture the screenshot and the relevant JSON before stopping the exact process you started.
