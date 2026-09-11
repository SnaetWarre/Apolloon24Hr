# SQLite build-flow evidence

## Problem

Base revision `93a78ef` upgraded to `better-sqlite3` 13.0.3. Its packaged
`gypfile: false` setting is not reliably honored by npm, so a clean VPS install
ran the implicit `node-gyp rebuild` path. The production server had Python but
no `make`, and deployment stopped before the release became active.
[The upstream 13.0.3 issue](https://github.com/WiseLibs/better-sqlite3/issues/1516)
reports the same clean-install fallback despite the bundled native binary.

This branch returns to `better-sqlite3` 12.11.1 and lets `electron-builder`
perform its standard native dependency rebuild. The wrapper only preserves the
original Node.js binding so the same checkout remains usable by the standalone
backend after Electron packaging. This follows
[electron-builder's native-module flow](https://www.electron.build/v26/docs/configuration/#nativerebuilder),
where `npmRebuild` defaults to true and `@electron/rebuild` is the default
rebuilder.

## Matched clean-install check

Both revisions were installed with the official Node.js 22.12.0 Linux x64
archive and its bundled npm 10.9.0:

```sh
npm ci --omit=dev --include=optional
```

The test `PATH` contained only Node.js, npm, and `sh`. This makes an accidental
source build fail while still allowing a published prebuilt binary to install.

| Revision | better-sqlite3 | Result |
| --- | --- | --- |
| Base `93a78ef` | 13.0.3 | Failed in the implicit `node-gyp rebuild` path while searching for build prerequisites |
| `fix/sqlite-build-flow` | 12.11.1 | Installed 160 production packages and opened an in-memory SQLite 3.53.2 database on Node ABI 127 |

## Electron package check

```sh
npm run electron:build:linux
```

- `electron-builder` 26.15.3 ran `@electron/rebuild` for Electron 41.10.3.
- The unpacked application contains `better-sqlite3` ABI 145.
- The local checkout is restored to Node ABI 137 after packaging.
- The generated AppImage started headlessly and returned `ok: true`, schema
  version 9, and `database.ready: true` from `/api/health`.

## Regression checks

- `npm test`: 58 passed.
- `npm run check`: passed both typecheck targets and the client budget.
- `npm run test:e2e`: 23 passed.
- `npm audit --omit=dev`: 0 vulnerabilities.
- `git diff --check`: passed.

## Tradeoff

Version 12 uses the deprecated `prebuild-install` helper and therefore prints a
deprecation warning during a fresh install. That warning is preferable to
depending on the known npm installation regression in version 13. Upgrade
again after the upstream package reliably skips its implicit `node-gyp` step.
