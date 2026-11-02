<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# fixture-ble-simulator-ride

Test fixture that provides `ble.central` with two simulated devices, for
`tests/features/apps/ride-with-heart-rate.feature` and for development without hardware.

| Device                      | Appears                            | Script                                                                                                                                           |
| --------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SIM KICKR` (FTMS trainer)  | 200 ms after the first scan starts | The Phase 2 trainer script: 4 packets of 200 W / 90 rpm every 250 ms, drops the connection for 500 ms, then 220 W / 92 rpm every 250 ms forever. |
| `SIM HRM` (heart-rate band) | 300 ms after the first scan starts | `00 91` (145 bpm) every 1000 ms after connecting. After 16 notifications it stays connected but stops notifying.                                 |

## Switches

- **Without a trainer:** set the environment variable `RIDRS_SIMULATED_RIDE_TRAINER=off` before the
  plugin initializes. Only the band appears.
- **Stop the band now:** while the fixture runs, `globalThis[Symbol.for('ridrs.fixture.simulated-ride')]`
  holds `{ stopHeartRate() }`. The band then stays connected and stops notifying, as after its 16th
  notification. The handle is removed when the plugin stops.

The fixture runs real timers in the `ui` profile; with `@fake-timers` it follows the fake clock.
