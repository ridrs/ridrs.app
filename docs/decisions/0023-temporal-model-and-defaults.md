<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0023: Temporal Model and Defaults

## Context

Sources deliver at different rates (trainer ≈ 4 Hz, heart-rate band ≈ 0.5–1 Hz). Phase 2 declared a metric stale after a fixed 3 s: too slow for the trainer, too nervous for heart rate. Consumers that combine sources need values at the same time, and Phase 5's physics will query power at fixed step times.

## Decision

- **One shared part of the core.** `@ridrs/temporal` holds the pure math (no clock, no timers); the core service `ctx.temporal` owns time, deadlines and lifecycles. Plugins never import `@ridrs/temporal`.
- **Series = capability.** Only the provider writes (during `initialize`), readers need the capability in `requires`. Everything a plugin obtains is released when it stops.
- **Two time axes.** `measuredAt` drives values, `receivedAt` drives timing (intervals, freshness).
- **Learned interval** `T`: median of the last 8 receive intervals after 3; outliers above 2.5 T are gaps; three consistent outliers are a sustained change.
- **Freshness** with one deadline per series: delayed from 1.5 T, stale from clamp(8 T, 2 s, 10 s); 3 s while `T` is unknown (Phase 2 unchanged). Bounds are half-open (a threshold is reached at its exact time), which is what the features specify.
- **Values at a time** are labelled `measured`, `interpolated`, `held` or `extrapolated`. `damped-trend` extrapolates the integral of a rate that is constant for T and decays with τ = T, held from 3 T, floored at the series minimum (0 in Phase 4). `hold` never extrapolates. The writer chooses the strategy.
- **Averages** are time integrals of exactly `valueAt`, in closed form, with coverage; **snapshots** are delivered once per accepted measurement, run-to-completion, never on timers.
- No numeric confidence score: `quality` and `Freshness` carry the information with a defined meaning.

The parameters are one exported object, `TEMPORAL_DEFAULTS`; the table is in [temporal-data-layer.md](../architecture/temporal-data-layer.md).

## Consequences

- A 4 Hz trainer is "no signal" after 2 s, a 1 Hz band after 8 s; Phase 2 scenarios (fewer than 4 measurements) keep 3 s.
- The trend window is limited to the current stretch (after the last disconnect or stale gap), so a trend never spans a gap even when 4 T exceeds the stale threshold.
- Settings for windows, thresholds or strategies are deliberately absent until a use case needs them.
