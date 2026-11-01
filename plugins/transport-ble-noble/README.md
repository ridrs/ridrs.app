<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# transport-ble-noble

Provides `ble.central` on desktop machines (macOS, Linux, Windows) using
[`@abandonware/noble`](https://github.com/abandonware/noble). noble is a native addon and an
`optionalDependency` of this plugin only; if it cannot be installed or loaded the plugin ends in
`entry-load-failure` and its dependents are blocked while everything else keeps running.

- macOS: the terminal application needs Bluetooth permission (System Settings → Privacy & Security → Bluetooth).
- `RIDRS_BLE_NOBLE_FAIL_LOAD=1` makes the entry module fail to load. It simulates a missing Bluetooth stack in tests.
