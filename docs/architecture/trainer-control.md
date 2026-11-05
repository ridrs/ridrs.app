<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Trainer Control (Phase 8)

The virtual gradient and speed drive the trainer's resistance, the Zwift Ride shifts virtual gears, and in ERG the trainer holds a target power. **The physics computes what the trainer should feel; the device plugin decides how to tell its trainer.**

```text
                       physics (clock-driven, 10 ms)                       device side (in turns of inputs)
 metric.power ─► … ─► physics-virtual-speed ─► physics.state / state-batch ─┐
                                                 + trainerLoad              │ derived event
 controller.buttons-changed ─► control-virtual-gears                        ▼
   (input)                       │ series drivetrain.virtual-gear      device-ftms-trainer
                                 ▼ (hold, never stale)                  │ mode by target + Feature bits
                        physics-trainer-load (reader only)              │ clamps, rate-limits, encodes
                          resistance / resistanceWithVirtualGear        ▼
 UI widget ─► trainer.erg-requested ─► control-erg ─► trainer.target-power (input)
                                                       trainer.command, trainer.control-changed
                                                       device.raw-write ─► BLE write with response
                     trainer answers 80 <op> <result> ─► device.raw-notification (input)
```

## Plugins

| Plugin | Type | Role |
|---|---|---|
| `physics-trainer-load` | physics | `physics.trainer-load`: both loads per step as FTMS simulation parameters ([ADR 0054](../decisions/0054-trainer-load-and-virtual-gear-formula.md)) |
| `control-virtual-gears` | control | 24 virtual gears from any controller's shift buttons; series `drivetrain.virtual-gear`, event `drivetrain.gear-changed` ([ADR 0055](../decisions/0055-virtual-gears-and-never-stale-series.md)) |
| `control-erg` | control, transport (a driver) | the rider's ERG target from the activity screen and the power-up buttons, as the input `trainer.target-power` |
| `device-ftms-trainer` | device | reads the Feature, takes control, chooses and sends the commands ([ADR 0056](../decisions/0056-ftms-trainer-control.md)) |
| `ui-widget-virtual-gear` | ui | "12 / 24" in the HUD |
| `ui-widget-target-power` | ui | "ERG 150 W" or nothing; Enter starts ERG, ↑/↓ ±5 W while focused, Back leaves ERG |

`ui-devices` shows the trainer's control state in its details: "Control: simulation", "ERG 150 W", "not supported", "refused", "lost".

## Rules

- The physics never knows a trainer, a mode or a capability; it computes both loads for the same step and never changes the motion. The virtual speed always comes from the measured power, ERG included; trainer commands never feed back.
- The gear source and the trainer load are optional (`optionalRequires`, [ADR 0053](../decisions/0053-optional-capabilities.md)): without a gear source the load with the gear equals the load without it; without a trainer load the engine rides as before.
- Only `device-ftms-trainer` writes to the trainer, through the peripheral link; dependency-cruiser enforces it.
- Every decision is made in a turn, from inputs and derived events, on the logical clock: a replay without a trainer publishes the same commands.

## Defaults

| Parameter | Default | Owner |
|---|---|---|
| Real chainring / cog | 34 T / 14 T | `control-virtual-gears` |
| Virtual gears | 24, geometric 1.0 … 4.818, start gear 12 | `control-virtual-gears` |
| Simulation command interval | ≥ 1000 ms, on change only | `device-ftms-trainer` |
| ERG target and gear changes | at once, ≤ 4 per second | `device-ftms-trainer` |
| ERG target step / default | 5 W / 150 W | `control-erg` |
| ERG target range | the trainer's Supported Power Range, else 0–2000 W | `device-ftms-trainer` |
| Gradient sent | −10 % … +20 % | `device-ftms-trainer` |

## Tests

- `tests/features/devices/ftms-trainer-control.feature`, `trainer-modes.feature`, `trainer-control-transports.feature`;
- `tests/features/physics/trainer-load.feature`, `virtual-gears.feature`;
- `tests/features/recording/trainer-control-replay.feature`, `tests/features/ui/trainer-control-details.feature`;
- `tests/features/apps/ride-with-trainer-control.feature` (the e2e with the simulated trainer and Zwift Ride);
- Vitest: control-point encoding and decoding, the Feature parser, the rate limiter, the gear table and the load-with-gear invariant.

The `BleSimulator` FTMS trainer has a control-point model (`addFtmsTrainer(name, { control })`): Feature bits, a power range, an answer per write (success unless told otherwise), refusal while indications are off, and the ERG target as Indoor Bike Data power in the e2e fixture.
