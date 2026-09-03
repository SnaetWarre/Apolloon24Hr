## Context

<!-- Problem, scope, deliberate exclusions, and anything a takeover agent must know. -->

## What changed

<!-- Concrete behavior and implementation changes. -->

## Evidence

<!-- Delete sections that do not apply. Do not check boxes without adding the evidence. -->

### UI before and after

| Surface and state | Before | After |
|---|---|---|
| <!-- route, viewport, seed --> | <!-- github.com/.../blob/<branch>/docs/...png?raw=true --> | <!-- github.com/.../blob/<branch>/docs/...png?raw=true --> |

- [ ] Same data, viewport, route, and state in both captures
- [ ] Evidence committed under `docs/pr-evidence/<branch-slug>/`
- [ ] Responsive capture included when responsive behavior changed

### Optimization measurements

| Metric | Base | Head | Delta | Method and spread |
|---|---:|---:|---:|---|
| <!-- relevant metric and unit --> | | | | <!-- command, repetitions, median/range or p95 --> |

- Baseline:
- Changed version:
- Environment and hardware:
- Workload, warm-up, and repetitions:
- Correctness check:

## Validation

- [ ] `npm test`
- [ ] `npm run check`
- [ ] `npm run test:e2e` when runtime, integration, persistence, replication, or critical operator flow changed
- [ ] Focused checks:

## Risks and follow-ups

<!-- Migration concerns, known limitations, rollback notes, or "None". -->
