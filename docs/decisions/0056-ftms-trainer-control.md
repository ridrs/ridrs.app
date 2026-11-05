<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0056: FTMS Trainer Control: Modes, Choice, Rate, Clamping, Finish, Replay

Phase 8, decisions D2, D3, D5. Amends [ADR 0029](0029-recording-format-ridrs-v1.md) (the announced `device.raw-write` is now real).

## Context

The physics computes what the trainer should feel ([ADR 0054](0054-trainer-load-and-virtual-gear-formula.md)); only the trainer's device plugin knows what the trainer can do and how to tell it. Rule 7 asks that a replay reproduces every command without a trainer.

## Decision

**Specification.** Fitness Machine Service 1.0 (Bluetooth SIG, 2017):

- Feature `2acc`: uint32 machine features, then uint32 target setting features; bit 3 is power target (ERG), bit 13 is indoor bike simulation parameters (4.3.1.2).
- Supported Power Range `2ad8`: sint16 minimum and maximum, uint16 increment, in W.
- Control Point `2ad9` op codes (4.16.1): `00` Request Control, `05` Set Target Power (sint16, 1 W), `07` Start or Resume, `11` Set Indoor Bike Simulation Parameters (wind sint16 0.001 m/s, grade sint16 0.01 %, Crr uint8 0.0001, Cw uint8 0.01 kg/m).
- Response `80 <op code> <result>`; result `01` is success, `02` op code not supported, `03` invalid parameter, `04` operation failed, `05` control not permitted.

Every byte string of the brief was checked against this; `05 b4 00` for 180 W is right.

**The device plugin (`device-ftms-trainer`):**

- On every connection: subscribe to Indoor Bike Data, then to the control point (optional), then read the Feature and the power range (D3: "resistance mode" means simulation).
- No target-setting bit, or no control point: `control: 'unsupported'`, and the trainer stays a sensor exactly as before.
- Otherwise it writes Request Control, then Start or Resume when the ride starts (also once control is granted during a ride). Every write is with response.
- A result other than `01` reports `trainer-command-failed`, at most once per op code in 10 s. A refused Request Control (or a refused write of it) is `refused`.
- A lost link is `lost` and reports `trainer-control-lost` once. On reconnect it repeats everything and resends the last mode command.

**Choosing the output, in this order** (the mode is published in `trainer.control-changed`):

1. ERG target set and power target supported: `erg`. Set Target Power with the target, clamped to the Supported Power Range (0–2000 W without one).
2. Simulation supported and the load names a virtual gear: `simulation` with `resistanceWithVirtualGear`.
3. Simulation supported: `simulation` with `resistance`.
4. Trainer-side virtual shifting: not in this phase ([ADR 0057](0057-trainer-side-virtual-shifting-findings.md)).
5. Otherwise `none`.

**Clamping and rate (D5), on the logical clock in the turn of the batch or the input:**

- The gradient is clamped to −10 … +20 %. The KICKR CORE itself simulates up to 16 %, so values above that are harmless.
- Simulation parameters go out at most once per 1000 ms, and only when the encoded command changes.
- An ERG target, a new gear or the switch from ERG go out at once, at most 4 per second.
- The load comes from the newest sample of each `physics.state-batch`, a derived event a device plugin may hear. The plugin never computes physics: it encodes, clamps and rate-limits.

**Finish:**

- A **neutral simulation** (no wind, grade 0, the last Crr and cw). It ends ERG and keeps control for the next ride.
- **Reset** (`01`) was rejected: it gives up control, so the next ride would have to ask again, and some trainers fall back to their own last mode.
- Between rides no simulation is sent.

**ERG target (D2).**

- `control-erg` is a driver (types `control` and `transport`, so a replay leaves it out like the world driver).
- It turns `trainer.erg-requested { change: enter | up | down | leave }` from the activity screen into the input `trainer.target-power { watts | null }`, and so do the Zwift Ride's power-up buttons (right: start ERG or +5 W; left: −5 W). Defaults: 150 W, steps of 5 W.
- A finished ride leaves ERG. The virtual speed still comes from the measured power.

**Determinism and replay.**

- The replay central connects to nothing, so trainer control is driven by inputs only:
  - the connection (`device.connection-changed`, now naming the optional characteristics subscribed, e.g. `2ad9`);
  - the reads (new input `device.raw-read`, data or error, before `connected`);
  - the trainer's answers (`device.raw-notification` on `2ad9`);
  - failed writes (new input `device.raw-write-failed`);
  - the target power and the buttons.
- `trainer.command`, `trainer.control-changed`, `drivetrain.gear-changed` and `device.raw-write` are derived and compared.
- The link publishes `device.raw-write` in the deciding turn and writes only when a connection is there. A replay therefore needs no central that "accepts writes" or "answers reads", unlike the brief's suggestion.

## Consequences

- The device details show the control in one line ("Control: simulation", "ERG 150 W", "refused", "lost"); a trainer ridrs cannot control shows none.
- A trainer without a control point, a lost control or a refused command leaves the ride running as before.
