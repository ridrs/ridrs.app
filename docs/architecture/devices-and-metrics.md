<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Devices and Metrics (Phase 2)

```text
transport-ble-noble  --ble.central-->  device-ftms-trainer
device-ftms-trainer  --device.connection-changed, measurement.power, measurement.cadence-->  metric-power, metric-cadence
metric-*             --metric.power, metric.cadence (+ latest())-->  output-console
```

- **Contracts** (`packages/contracts`): `ble.central` (UUIDs normalized to 4-char lowercase hex), the device/measurement/metric events and `MetricReading`.
- **Core extension**: `ctx.signal` is aborted by the host when a plugin stops; `ctx.reportDiagnostic` lets plugins report problems (`malformed-packet`, `multiple-sources`).
- **Device plugin** owns protocol bytes; nobody else sees them. FTMS carries no timestamp, so `measuredAt = receivedAt` with origin `receive`.
- **Metric plugins** know no device. The first delivering device is the active source; loss (`reconnecting`/`disconnected`) or 3 s of silence makes the metric `unavailable` - the last value is never kept. (Phase 4 replaces the fixed 3 s by a threshold that fits the source's rate; 3 s remains the fallback.)
- **Testing**: `packages/testing` holds the in-process BLE simulator (importable from `tests/**` only). `tests/fixtures/plugins/simulated-trainer` provides `ble.central` from it and plays a scripted ride.

## Phase 4: a second source, shared building blocks, derived metrics

```text
ble.central --> device-ftms-trainer --measurement.power, .cadence-->     metric-power, metric-cadence ─┐
ble.central --> device-heart-rate   --measurement.heart-rate-->          metric-heart-rate ────────────┤ series (ctx.temporal)
                                                    metric-power-heart-rate-ratio <── combine ─────────┘
```

- **Heart rate** (`device-heart-rate`): scans for the Heart Rate Service `180d`, connects to the first device found, subscribes to Heart Rate Measurement `2a37` and publishes `measurement.heart-rate` (bpm, `measuredAt = receivedAt`, origin `receive`). Flags (bit 0 value format, bits 1-2 sensor contact, bit 3 Energy Expended, bit 4 RR-intervals) are read per the Bluetooth SIG Heart Rate Service; energy and RR-intervals are only checked for their length. Contact supported but not detected, or a value of 0, is "no reading", not 0 bpm. A packet shorter than its flags require or an odd number of RR bytes is `malformed-packet`; the connection stays up. `device-ftms-trainer` and `device-heart-rate` each scan for their own service only and never take the other's device.
- **`@ridrs/ble-peripheral`** (`packages/ble-peripheral`, AGPL-3.0-or-later): the connection lifecycle extracted from `device-ftms-trainer` (scan → connect → subscribe → reconnect with `p-retry` → `device.connection-changed`), used by both device plugins; decoding stays in the plugin. It also holds `SharedBleScan`, which lets the Tauri and noble centrals serve several concurrent scans from the one scan their platform allows (the union of the requested services; each consumer sees only its own).
- **`@ridrs/metric-source`** (`packages/metric-source`, AGPL-3.0-or-later): the shared logic of `metric-power`, `metric-cadence` and `metric-heart-rate` (three plugins, three manifests, one implementation). Unchanged from Phase 2: the active-source rule, `multiple-sources`, `disconnected` handling, never inventing values, `latest()`. New: every accepted measurement of the active source goes into the metric's temporal series; a source change resets the series, a lost device marks it disconnected, and the metric goes `unavailable` / `stale` when the series turns stale - after a silence that fits the source's rate instead of a fixed 3 s (see [temporal-data-layer.md](temporal-data-layer.md)). Late or duplicate measurements change nothing.
- **Units and reasons**: `MetricUnit` adds `bpm` and `W/bpm`; `MetricUnavailableReason` adds `insufficient-data`, used only by derived metrics while warming up.

### Derived metrics

A derived metric requires only metrics and reads their series; it never subscribes to `measurement.*` and imports nothing device-, BLE- or UI-related (enforced by `dependency-cruiser`). Its `available` readings use the **plugin id** as `deviceId` and the snapshot time `t` as both `measuredAt` and `receivedAt`.

`metric-power-heart-rate-ratio` combines `metric.power` and `metric.heart-rate`. For each snapshot at `t`: if either input is unavailable at `t`, it publishes `unavailable` with the power reason if power is unavailable, else the heart-rate reason (`out-of-range` becomes `insufficient-data`); else it takes both 10 s time-weighted averages at `t`; below 80 % coverage it is `unavailable` / `insufficient-data` ("warming up"); else it publishes `average power / average heart rate` in W/bpm. When an input metric publishes `unavailable`, the ratio follows at once with that reason. Available readings are published once per snapshot; an unavailability only when it changes.
