# Backend security and efficiency audit

This change is stacked on PR #8 (`fix/cluster-ip-recovery`). Merge #8 first, then retarget this PR to `main` if GitHub has not already done so. The overlapping discovery, proxy, and test changes have been resolved together and the combined branch was tested locally. This PR does not deploy, release, or monitor CI.

## Findings and fixes

- Browser admission: validate Host, Origin, and Fetch Metadata before HTTP body parsing and during Socket.IO admission. Reject foreign websites, opaque origins, and attacker-controlled DNS hostnames. Preserve normal same-origin LAN, desktop, and Vite proxy access. Add response headers against framing and content sniffing.
- Credential handling: reject unauthorized cluster sync requests before parsing their bodies. Refuse HTTP redirects on bootstrap and sync so pairing codes and cluster secrets cannot be forwarded to a redirect destination. Compare pairing codes using byte-safe constant-time comparison, including malformed Unicode input.
- Resource bounds: general JSON requests are limited to 8 MiB, authenticated cluster requests and decoded cluster responses to 50 MiB, and cluster error responses to 8 KiB. Validate declared and streamed response sizes and cancel oversized streams. Bound runner fields, labels, queues, CSV text and row counts, and captured replication statements. Return short JSON errors without stack traces.
- CSV exports: escape spreadsheet formula prefixes in both exports without modifying stored values. CSV imports use the same runner validation as individual creates.
- Backup inventory: reject traversal paths, filename/metadata aliases, symlinked files, and invalid metadata sizes or dates. This is local-filesystem defense in depth, not a replacement for filesystem permissions.
- Replication correctness: only capture successful SQL statements and discard statements from rolled-back nested transactions. This prevents a partially rejected import row from reappearing during replay on another laptop. Invalidate application snapshot revisions when reopening the database.
- Idle replication: use indexed origin seeks for vectors, skip acknowledged origins and empty batches, fetch only relevant race-base keys, and avoid parsing payloads when only ordering, checksum, or status is needed. Acknowledgements update rows only when their sequence advances.
- Caches: bound prepared statements with a 256-entry LRU. Bound retained serialized HTTP response reservations to 32 MiB and 32 entries, replace obsolete revision slots, and bypass oversized entries. Preserve cache headers on 304 responses and avoid reusing cached sensitive responses. The byte budget covers serialized response cache reservations, not total process memory.
- Dependencies: update four transitive packages without adding dependencies: `qs` 6.15.3 to 6.16.0, `@xmldom/xmldom` 0.8.13 to 0.8.15, `fast-uri` 3.1.5 to 3.1.7, and `nanoid` 3.3.17 to 3.3.18. The final full dependency audit reports zero advisories, including development dependencies. Advisory references: [qs](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx), [xmldom](https://github.com/advisories/GHSA-6gmq-8vp8-gcm6), [fast-uri](https://github.com/advisories/GHSA-f65p-4m7j-42xc), [nanoid](https://github.com/advisories/GHSA-2v37-7h3g-55p8).

## Replication measurements

Raw wall-clock and CPU samples, revisions, environment, and computed comparisons are in [replication-idle.json](./replication-idle.json). This is a function-level microbenchmark of idle replication, not HTTP latency or a whole-application speedup claim.

- Measured baseline: `ce6bf003b95a90e6d543b6d1798930c8153ea3d2`.
- PR base: `41b9eb44f03ad7b2a167b642a4d6efccfe494409`. Its `server/db.ts` is byte-identical to the measured baseline.
- Measured implementation: `ccb98742c557d5aa7893f014261d6866b81a0f38`. Subsequent evidence-only commits do not alter measured code.
- Machine: AMD Ryzen 7 6800H, Linux 7.2.2-1-cachyos, Node v24.18.0.
- Both versions use source backend execution through `tsx`, `NODE_ENV=production`, and SQLite `synchronous=FULL`.
- Fixture: a temporary SQLite database with 100,000 no-op replication operations across five origins, each with a distinct race-base key. This intentionally exposes history-size-dependent scans and does not represent every race workload.
- Per scenario: five warm-up calls, then five samples of 25 calls each. Reported values are the median of sample means and their min/max range, in milliseconds per call.

| Scenario | Baseline median (range), ms | Changed median (range), ms | Absolute delta, ms | Relative delta |
|---|---:|---:|---:|---:|
| Replication vector | 5.89508 (5.84488 to 6.11528) | 0.01290 (0.01258 to 0.01435) | -5.88218 | -99.78% |
| Already caught-up delta | 2.78827 (2.78152 to 2.80094) | 0.01441 (0.01243 to 0.01593) | -2.77386 | -99.48% |
| Empty incoming batch | 59.95901 (59.17455 to 60.62597) | <0.001 (0.00045 to 0.00091) | approximately -59.95839 | >99.99% |
| Unchanged acknowledgement | 0.06249 (0.06036 to 0.06913) | 0.02104 (0.01945 to 0.02578) | -0.04145 | -66.34% |

The empty-batch result is near instrumentation overhead: the meaningful change is that an empty batch now returns before any database work. No process-memory reduction or physical-network recovery timing is claimed by these measurements.

### Reproduction

Run from the repository root after installing the lockfile dependencies:

```sh
node --import tsx scripts/benchmark-replication-idle.ts
```

The script creates and removes its own temporary database; it does not use the operator database. To reproduce the baseline, use the same script with the baseline revision's backend in a separate ordinary clone or branch checkout. The benchmark script was introduced by this PR and must be carried into that baseline checkout unchanged. Use the same Node version, machine, dependencies, and otherwise idle conditions for both runs.

The script asserts the expected replication vector, an empty delta for an acknowledged vector, the correct final operation for a one-operation lag, and an unchanged vector and zero applied operations after empty batches. Additional regression tests check transaction replay and monotonic acknowledgements without redundant updates.

## Validation

Completed against the combined implementation after rebasing onto PR #8:

- `npm test`: 63 tests passed.
- `npm run check`: client and server typechecks, production build, and client bundle budget passed.
- `npm run test:e2e`: 28 tests passed, including the inherited IP recovery regressions and new HTTP, Socket.IO, Vite proxy, redirect, Unicode pairing, parser-limit, and CSV cases.
- `npm audit --json`: zero vulnerabilities across the full dependency tree.
- `git diff --check`: passed.

Focused tests also cover streamed response limits and cancellation, cache revision replacement and budget eviction, gzip and 304 behavior, rolled-back SQL capture, and unsafe backup manifests. No new elaborate test harness was introduced.

## Operational limits and follow-ups

- Custom DNS aliases must appear in `PUBLIC_HOST` or comma-separated `APOLLOON_ALLOWED_HOSTS`. Reverse proxies must preserve the browser's Host. Literal IPs, localhost, and the machine hostname remain supported. See [backend architecture](../../backend-architecture.md) and `.env.example`.
- The 8 MiB ordinary-body limit and input limits intentionally reject oversized requests. CSV text is capped at 5,242,880 JavaScript characters and 10,000 rows, subject also to the encoded HTTP body limit. Authenticated cluster bootstrap/sync responses larger than 50 MiB require a smaller dataset or future paginated transfer support.
- Browser-origin protections are not user authentication. Native clients without Origin headers remain part of the existing trusted-LAN model. Do not expose operator APIs directly to an untrusted network without an access-control layer.
- No database migration is required. Formula escaping affects exported spreadsheet cells, not stored data.
- This is a targeted audit, not a guarantee that all vulnerabilities have been found. Physical DHCP/network-interface changes and cross-platform desktop packaging were not tested in this audit. Automated network regression tests from #8 were rerun.
- PR CI is left to the maintainer as requested.
