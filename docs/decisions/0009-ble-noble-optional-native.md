<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0009: Real Bluetooth LE (`@abandonware/noble`)

We use **@abandonware/noble** (1.9.2-26, MIT) for real BLE on desktop. It is a native addon and therefore a **documented exception** to the "pure JS" library rule. It is an `optionalDependency` of `plugins/transport-ble-noble` only, and dependency-cruiser forbids importing it anywhere else. If it cannot be installed or loaded, the plugin ends in `entry-load-failure` (Phase 1 mechanism), its dependents are blocked and the rest of the app keeps running. `RIDRS_BLE_NOBLE_FAIL_LOAD=1` simulates this in tests. Alternatives: `@stoprocent/noble` (similar, also native), Web Bluetooth (no Node support).
