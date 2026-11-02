<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0024: Late Measurements Are Rejected

## Context

A measurement can arrive with a `measuredAt` at or before the last accepted one (reordering in a transport, device clocks). Accepting it would move the current state backwards and invalidate snapshots and averages already delivered.

## Decision

- Same `measuredAt` and same value as the last accepted measurement: **duplicate**, ignored silently.
- Any other `measuredAt ≤` the last accepted one: **late**, rejected - not stored, no interval, no freshness change, no snapshot. The writer gets `'late'`; a `late-measurement` diagnostic is reported at most once per series per 10 s. Metric plugins publish nothing for it.
- Exception: the **first measurement after a disconnect mark** may share the last accepted timestamp. A disconnect closes the stretch, and Phase 2's "Metrics return with the first new measurement after reconnection" scenario delivers the measurement before and after a reconnection within the same millisecond. The new measurement starts the next stretch; nothing is estimated across the mark.

## Consequences

- The current state never moves backwards; history stays ordered by `measuredAt`.
- Bounded reordering (a short buffer that accepts slightly late data) is a later option, to be revisited with recording and replay (Phase 9).
