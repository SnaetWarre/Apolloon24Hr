# Cluster address recovery evidence

Baseline: `ce6bf003b95a90e6d543b6d1798930c8153ea3d2` (`main`).
Changed implementation: `694065b8820a235b489fbc997c613631a3281c53`
(`fix/cluster-ip-recovery`). Later commits only add this evidence.

## Recovery latency

| Measurement | Baseline | Changed | Absolute delta | Relative delta |
|---|---:|---:|---:|---:|
| Median announcement-to-connected latency | 5022.58 ms | 49.60 ms | -4972.97 ms | -99.01% |
| Minimum to maximum, five samples | 5007.01 to 5032.33 ms | 48.80 to 77.63 ms | | |

Raw samples and environment are in [recovery-benchmark.json](recovery-benchmark.json).
Both revisions ran on the same AMD Ryzen 7 6800H (8 cores, 16 threads), Linux
7.2.2-1-cachyos, Node.js 24.18.0, npm 11.16.0, and installed dependencies.
Both used the source backend through `tsx`, with `NODE_ENV=test`.

Command:

```sh
APOLLOON_RECOVERY_BENCHMARK=1 node --import tsx --test --test-name-pattern='signed UDP address changes' tests/cluster-network.e2e.test.ts
```

The benchmark test was introduced in this PR and run against the unchanged
baseline backend before implementing the fix. To reproduce the baseline, use
the same test file from the changed revision with the baseline server files.

Each revision gets one discarded warm-up and five measured repetitions. Every
repetition starts a fresh backend/database and an HTTP test peer. A real signed
UDP packet announces an unreachable URL. After the first failed HTTP probe,
another signed packet advertises a working URL for the same host ID. Timing
starts before sending that second packet and ends when HTTP cluster status
confirms the replacement URL and two connected hosts. Every repetition also
checks that there is one peer and its host identity is retained.

The fixture sets the old-address retry delay to 5000 ms, sync/discovery intervals
to 50 ms, request timeout to 250 ms, and status polling to 20 ms. It exchanges no
application operations. Benchmark mode removes the regression's one-second
latency assertion so both implementations can complete, while keeping identity
and host-count assertions.

This measures removal of an inherited retry delay. It is not a throughput, CPU,
or production DHCP recovery benchmark. Default discovery is every 1000 ms and
default sync is every 350 ms; packet loss, OS address assignment, routing,
timeouts and data catch-up add their own delays. The spread is small relative
to the roughly five-second change, but the exact millisecond figure depends
on polling and scheduling.

## Correctness

Before the fix, all three initial targeted regressions failed:

- A response/broadcast for an unreachable second interface left only one
  connected host instead of two.
- A delayed old-address response prevented the new address being probed within
  1500 ms.
- Discovery did not recover within 2000 ms after a blocking UDP socket closed.

The final network suite has nine passing regressions covering retry reset,
cached-interface failover, two-way data catch-up, sticky successful routes,
late responses, late timeouts, incoming source-interface selection, rejecting
an unexpected host at a reused address, and UDP bind recovery.

The two-database regression keeps both backend processes running. It stops a
forwarding endpoint at `127.0.0.2`, makes a local write on each database during
the outage, and recreates the endpoint at `127.0.0.3` with the same port. A signed
UDP announcement triggers recovery; both databases then contain all three
expected runners, including the pre-outage runner, with the same peer ID and
no duplicate peer. On non-Linux platforms the fixture moves ports on
`127.0.0.1` because Linux's full loopback range is not portable.

The replica's own periodic outbound probe is delayed in this test so it cannot
bypass the simulated outage through a direct reverse connection. The other
backend performs authenticated push/pull exchanges through the moved endpoint.
This is an endpoint-loss simulation using real HTTP, UDP and SQLite, not a
physical laptop/DHCP, firewall, or Windows/macOS adapter test.

## Validation

- `npm test`: 58 passed.
- `npm run check`: passed client/server type checks and production client budget.
- `npm run test:e2e`: production build passed, 23 tests passed.
- `git diff --check`: passed.

No schema or cluster-protocol migration is required. There is no UI change or
claim about general CPU/throughput improvements. UDP rebinding follows the
[Node.js datagram socket error and bind lifecycle](https://nodejs.org/api/dgram.html).
The operational limits and browser behavior are documented in
[the reliability model](../../reliability-model.md#laptop-ip-changes).
