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
- **Metric plugins** know no device. The first delivering device is the active source; loss (`reconnecting`/`disconnected`) or 3 s of silence makes the metric `unavailable` - the last value is never kept.
- **Testing**: `packages/testing` holds the in-process BLE simulator (importable from `tests/**` only). `tests/fixtures/plugins/simulated-trainer` provides `ble.central` from it and plays a scripted ride.
