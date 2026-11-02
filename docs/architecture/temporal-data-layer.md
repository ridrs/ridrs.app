<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Temporal Data Layer (Phase 4)

Phase 4 use case: **sensors update their values at different rates; the display still gets sensible, temporally consistent values.** A trainer sends about 4 times per second and a heart-rate band about once per second, yet power and heart rate are shown together. Each source goes "no signal" after a silence that fits its own rate, and the power-to-heart-rate ratio divides values taken at the **same** time.

```text
Smart trainer (≈4 Hz) ─► device-ftms-trainer ─► measurement.power / .cadence ─► metric-power / metric-cadence ─┐
HR strap/band (≈0.5–1 Hz) ─► device-heart-rate ─► measurement.heart-rate ─► metric-heart-rate ────────────────┤
                                                                                                              │ record()
                                    ┌──────────────── core: temporal data layer (ctx.temporal) ───────────────┤
                                    │ per series: bounded history · sampling interval · freshness ·           │
                                    │ value at time t (measured / interpolated / extrapolated / held) ·       │
                                    │ time-weighted average · time-aligned snapshots                          │
                                    └──────────────┬──────────────────────────────────────────────────────────┘
                                                   │ combine(metric.power, metric.heart-rate)
                                                   ▼
                                  metric-power-heart-rate-ratio  (derived, W/bpm, 10 s window)
                                                   │ metric.* events
                                                   ▼
          HUD: ui-widget-power · ui-widget-cadence · ui-widget-heart-rate · ui-widget-power-heart-rate-ratio
```

Measurements are the source of truth. Estimates improve temporal alignment but are always labelled and never published as measurements. Timing, estimation and alignment live in one place - never inside individual plugins.

## Where the code lives

| Part | Responsibility |
|---|---|
| `@ridrs/temporal` (`packages/temporal`) | Pure, deterministic math on explicit timestamps: `TemporalSeries` (history, interval learning, freshness, `valueAt`, `average`), `IntervalEstimator`, the damped-trend formulas, `buildSnapshot`, and `TEMPORAL_DEFAULTS`. No clock, no timers, no I/O; imports only `simple-statistics` and contract types. |
| `ctx.temporal` (`packages/core/src/temporal-service.ts`) | Series registry and ownership, the one freshness deadline per series (rxjs `timer`), run-to-completion delivery of snapshots and freshness changes, `late-measurement` diagnostics, release on plugin stop. |
| Contracts (`packages/contracts/src/temporal.ts`) | `TemporalValue`, `TemporalAverage`, `TemporalSnapshot`, `Freshness`, `EstimationStrategy`, the writer/reader interfaces and `PluginTemporalContext`. |

Plugins never import `@ridrs/temporal` (enforced by `dependency-cruiser`): there is exactly one estimator, and no plugin can bypass series ownership.

## Series, writers and readers

A series is identified by a capability (series id = capability id), and ownership mirrors capabilities:

- `ctx.temporal.writer(capability, { strategy, min? })`: only for a capability the plugin `provides`, only during `initialize`, exactly one writer per series. Otherwise `undeclared-capability`.
- `ctx.temporal.reader(capability)`: for a capability in `requires`, or for the plugin's own series. Otherwise `undeclared-capability`.
- Writers record only while their plugin is started (`plugin-not-active`). Everything a plugin obtained (freshness handlers, combinations) is released when it stops; a stopped writer's series is cleared and answers `no-source`.
- Queries never change a series. `valueAt(t)` with `t` later than `clock.now()` is `out-of-range`.

```ts
// metric-power (through @ridrs/metric-source)
const writer = ctx.temporal.writer(metricPowerCapability, { strategy: 'damped-trend' });
writer.record({ value, measuredAt, receivedAt, sourceId: deviceId }); // 'accepted' | 'late' | 'duplicate'

// metric-power-heart-rate-ratio
const power = ctx.temporal.reader(metricPowerCapability);
const heartRate = ctx.temporal.reader(metricHeartRateCapability);
ctx.temporal.combine([power, heartRate], ({ at, values }) => { /* both at time `at` */ });
```

## Defaults

`T` is the learned sampling interval. All rules work on epoch-ms timestamps from the injected clock, so identical input gives identical results. The values are `TEMPORAL_DEFAULTS` in `@ridrs/temporal`.

| Parameter | Default |
|---|---|
| Interval estimate | median of the last **8** accepted intervals |
| Learned after | **3** accepted intervals (≥ 4 measurements) |
| Outlier interval | > **2.5 ×** current estimate (only once learned) |
| Sustained change | **3** consecutive outlier intervals within ±20 % of their own median replace the window |
| Fallback stale threshold (interval not learned) | **3000 ms** (identical to Phase 2) |
| Delayed after (learned) | **1.5 T** since the last receive |
| Stale after (learned) | **clamp(8 T, 2000 ms, 10000 ms)** since the last receive |
| Trend window | **4 T** before the last measurement, least-squares slope, at least **3** measurements, else no trend |
| Full-trend horizon | **T** after the last measurement |
| Decay time constant τ | **T** |
| Hold after | **3 T** after the last measurement |
| History | **60 s** and at most **600** measurements per series |
| Minimum value | **0** for every Phase 4 series |

## Rules

### Timestamps

`measuredAt` places a value on the time axis (values, interpolation, extrapolation, averages). `receivedAt` places a packet on it (interval learning, freshness, next expected arrival). FTMS and Heart Rate packets carry no device time, so `measuredAt = receivedAt` (`timestampOrigin: 'receive'`); the rules stay correct when they differ. Native receive timestamps from the Tauri layer are not used: their IPC jitter (p95 ≈ 23 ms on Android) is far below the sensor intervals and the median absorbs it.

### Sampling interval

An interval is the `receivedAt` difference of two consecutive accepted measurements; intervals ≤ 0 are ignored. After 3 intervals `T` is the median of the last 8 (an even count takes the mean of the two middle values). Once learned, an interval above 2.5 T is a gap: the measurement is accepted, the interval is not. Three consecutive outliers within ±20 % of their own median replace the window (a sustained change); a moderate change is followed by the median on its own. `nextExpectedAt = lastReceivedAt + T` is an expectation, not a deadline. `reset()` forgets the intervals; a stale or disconnected period does not.

### Freshness

| State | Condition (bounds are half-open: a threshold is reached at its exact time) |
|---|---|
| `none` | nothing recorded since start or `reset()` |
| `fresh` | received less than 1.5 T ago (learned) or less than 3000 ms ago (not learned) |
| `delayed` | learned only: at least 1.5 T ago, less than the stale threshold |
| `stale` | at least the stale threshold ago |
| `disconnected` | `markUnavailable('disconnected')` and no measurement since |

The core keeps **one** deadline per series - its next transition - and notifies `onFreshnessChange` handlers exactly once per transition, with the transition time. A new measurement re-arms it. There are no other timers: no prediction timers, no snapshot timers.

### Value at time `t`

Let `a` be the last accepted measurement with `a.measuredAt ≤ t` and `b` the next one.

| Situation | Result |
|---|---|
| `t` exactly at a measurement | that value, `measured` |
| `a` and `b` exist | `damped-trend`: linear interpolation, `interpolated`; `hold`: `a.value`, `held` |
| stale gap between `a` and `b` (`b.receivedAt − a.receivedAt` ≥ the stale threshold at `a`) | before `a.receivedAt + threshold`: `a.value`, `held`; after: `unavailable` / `stale` |
| disconnect mark between `a` and `t` | `unavailable` / `disconnected` - never interpolate or extrapolate across one |
| after the last measurement, stale at `t` | `unavailable` / `stale` |
| after the last measurement, otherwise | estimate (below) |
| before the history, after now | `unavailable` / `out-of-range`; nothing recorded: `no-source` |

**Estimate** after the last measurement (`Δ = t − last.measuredAt`, value `x`, slope `v` per ms):

- `hold`: `x`, quality `held`.
- `damped-trend`: `v` is the least-squares slope over the measurements of the current stretch (after the last disconnect or stale gap) with `measuredAt ≥ last.measuredAt − 4T`, if there are at least 3 and `T` is learned; else `v = 0`. The value is the integral of a rate that is constant up to `T` and then decays with `τ = T`:

  ```text
  D(Δ) = Δ                                   for Δ ≤ T
  D(Δ) = T + τ · (1 − e^(−(Δ − T)/τ))         for T < Δ ≤ 3T
  D(Δ) = D(3T)                                for Δ > 3T      (hold)
  estimate = max(min, x + v · D(Δ))
  ```

  Quality `extrapolated` while `v ≠ 0` and `Δ ≤ 3T`, `held` afterwards. Example (180, 190, 200, 210 W every 250 ms): 220 at +T, 226.32 at +2T, 228.65 at +3T and held there; stale 2000 ms after the last packet.

Strategies are a writer option, consumers never choose: `metric-power` uses `damped-trend`; `metric-cadence` (pedalling stops abruptly) and `metric-heart-rate` (slow, no useful trend) use `hold`.

### History, late and duplicate measurements

The history keeps accepted measurements for 60 s (by `measuredAt`, relative to the newest) and at most 600. A measurement at the same `measuredAt` with the same value as the last accepted one is a **duplicate** (ignored silently, no snapshot). Any other measurement with `measuredAt ≤` the last accepted one is **late**: rejected (not stored, no interval, no freshness change, no snapshot), the writer gets `'late'`, and a `late-measurement` diagnostic is reported at most once per series per 10 s. The current state never moves backwards ([ADR 0024](../decisions/0024-late-measurements-rejected.md)).

One exception: a disconnect closes the stretch, so the **first measurement after a disconnect mark may share the last timestamp** (a device lost and back within the same millisecond, as in Phase 2's reconnection scenario). It starts the new stretch; nothing is estimated across the mark.

### Time-weighted average

`average({ window, at })` is the time integral of exactly `valueAt` over `[at − window, at]`, divided by the available time. Each piece is integrated in closed form (constant, linear, or the damped trend via `∫D`, split where the estimate reaches `min`). Unavailable time (before the history, stale, disconnected, after now) is excluded: `coverage = available / window`, `quality` = the least certain quality used (`measured < interpolated < held < extrapolated`). There are no packet-count averages, so the result does not depend on the sensor's rate.

### Time-aligned snapshots

`combine(readers, handler)` delivers **one** snapshot per accepted measurement of any of the series, at `t = measuredAt` of that measurement: the trigger series is `measured`, every other one is `valueAt(t)`, and an unavailable input is present with its reason. Never for late or duplicate measurements, never for estimates, never on timers, and nobody waits for the slower source. Two series measured at the same time give two snapshots, in recording order. Snapshots are built when the measurement is recorded and delivered like events: queued after the current handler, in subscription order, never re-entrant; a throwing handler becomes `event-handler-failure`. `snapshot(readers, t)` builds the same structure for any `t ≤ now`, without trigger and without side effects.

## Consumers in Phase 4

- **Metric plugins** (`@ridrs/metric-source`): record every accepted measurement of the active source, `reset()` on a source change, `markUnavailable('disconnected')` when the device is lost, and publish `unavailable` / `stale` exactly once when their series turns `stale`. A 4 Hz trainer is therefore "no signal" after 2 s, a 1 Hz band after 8 s, and fewer than 4 measurements keep Phase 2's 3 s.
- **`metric-power-heart-rate-ratio`**: see [devices-and-metrics.md](devices-and-metrics.md#derived-metrics).

## How Phase 5 uses it

The physics step (fixed 100 Hz) will query `valueAt(stepTime)` on a `metric.power` reader at every step time `t ≤ now`, and read `quality` to know how much of the input is estimated. It gets measured values at packet times, interpolated values between packets (only after the next packet arrived, i.e. in the past), and the damped trend after the last packet. Open questions for Phase 5: which strategy and horizon the step should use for power (the current `damped-trend` with τ = T extrapolates up to 3 T ≈ 750 ms at 4 Hz), and whether the 2 s minimum stale threshold is right for physics input.
