<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0025: Shared Device and Metric Packages

## Context

Phase 4 adds a second device plugin (`device-heart-rate`) and a third metric plugin (`metric-heart-rate`). Copying the Phase 2 connection lifecycle and metric logic would fork them ("extend, don't fork"). With two device plugins, two BLE scans now run at the same time, but blec (Tauri) and noble run one scan at a time: a second scan replaced the first, and the first plugin to stop its scan stopped the other's.

## Decision

- **`@ridrs/ble-peripheral`**: the connection lifecycle extracted from `device-ftms-trainer` (`startBlePeripheralLink`: scan for one service, connect to the first device, subscribe, reconnect with `p-retry`, publish `device.connection-changed`) and `SharedBleScan` (one native scan for the union of the requested services, fanned out per consumer, restarted wider when a consumer needs more, stopped when the last one is done). The Tauri central (`@ridrs/ble-tauri`, also used by the companion) and `transport-ble-noble` use `SharedBleScan`.
- **`@ridrs/metric-source`**: `defineMetricPlugin` with the shared metric logic; `metric-power`, `metric-cadence` and `metric-heart-rate` are each a manifest plus a few lines of options.
- Both import only `@ridrs/contracts` and their libraries (`p-retry`), never the core or a plugin (`dependency-cruiser`).
- **License: AGPL-3.0-or-later** (maintainer decision, 2026-11-02). They are extracted from AGPL plugins and contain metric logic, which `LICENSING.md` places in the AGPL core; `LICENSING.md` §4 forbids moving AGPL code into an Apache package only to make it permissive.

## Consequences

- All Phase 2 device and metric scenarios pass unchanged on the shared code.
- A future device plugin (e.g. Cycling Power Service) reuses the lifecycle; a future metric reuses the metric logic and its temporal series.
- `rxjs` is no longer a dependency of the metric plugins: staleness comes from the series.
