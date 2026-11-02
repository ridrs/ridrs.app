<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0022: Median and Least-Squares Slope (`simple-statistics`)

## Context

The temporal data layer learns a sampling interval from the median of recent receive intervals and estimates a trend as a least-squares slope. Both are generic statistics, not ridrs domain logic, and `AGENTS.md` asks for well-maintained, pure-JS ESM libraries for such helpers. `@ridrs/temporal` must stay runtime-neutral (Node and WebView) and free of I/O.

## Decision

Use **simple-statistics** 7.12.1 (ISC, pure JS, ESM, no dependencies) for `median` and `linearRegression`, in `@ridrs/temporal` only. 7.12.1 is the last 7.x release; 8.0.0 was five days old when this phase started and is not needed.

The domain formulas stay our own code: the damped extrapolation and its closed-form integral, the interval-learning rules, freshness, the history and late-measurement rules and the snapshot semantics.

## Consequences

- No hand-written statistics helpers. The license is ISC, compatible with AGPL-3.0-or-later; listed in `NOTICE`.
- `dependency-cruiser` allows `simple-statistics` (and type-only contracts) as the only imports of `packages/temporal`.
- Rejected: a Kalman/filter library, a time-series database, a units or a ring-buffer package. A bounded array with trimming holds 60 s of data; filters would add an uninterpretable confidence the brief excludes.
