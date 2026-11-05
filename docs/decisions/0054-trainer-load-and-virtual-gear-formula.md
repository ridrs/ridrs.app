<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0054: The Trainer Load, Without and With the Virtual Gear

Follows [ADR 0026](0026-physics-model-and-fixed-step.md) (the engine) and [ADR 0027](0027-road-gradient-and-environment.md). Phase 8, decisions D3 and D4.

## Context

The trainer should feel what the virtual bike feels. The physics computes that, but it must not know trainers, their protocols or their capabilities: the device plugin chooses what it sends. A trainer **with** virtual shifting applies a gear ratio itself and needs the load **without** the gear. A trainer **without** it (an FTMS trainer driven by ridrs) needs the load **with** the gear.

**Correction to the design conversation.** Its sketch reads "if `capabilities.virtualShifting` then send `trainerResistanceWithVirtualGear`". The stated intent is the opposite: a trainer with virtual shifting gets the gear ratio and the load without the gear, because it applies the gear itself; a trainer without virtual shifting gets the load with the gear. This ADR and the device plugin implement the intent.

## Decision

- **Capability `physics.trainer-load`** (single), provided by `physics-trainer-load`. It requires bicycle, rider and environment, and uses `drivetrain.virtual-gear` when there is one (`optionalRequires`, [ADR 0053](0053-optional-capabilities.md)). It subscribes to nothing and never changes the motion.
- **The engine's only change:** it calls `load(state)` once per step, **after** the motion, and puts the result into `physics.state` and every sample of `physics.state-batch` as `trainerLoad`. Speeds and distances are bit-identical with and without the plugin (unit test; settled speeds 34.2 / 14.9 / 57.9 km/h unchanged).
- **`resistance`** (`trainerResistance`): FTMS simulation parameters of the step:
  - the gradient the integrator used;
  - `Crr · surface factor` (the factors moved into the contract as `SURFACE_ROLLING_FACTORS`, so that the rolling resistance and the trainer load use the same values);
  - `cw = ρ · CdA` with a wind speed of 0. FTMS 1.0 (4.16.2.18) gives the wind resistance coefficient in kg/m without its formula. It is the FE-C convention: "frontal area × drag coefficient × air density", applied as ½ · cw · v². Zwift sends 0.51 kg/m. With 1.225 kg/m³ and 0.32 m² it is 0.392 kg/m.
- **`resistanceWithVirtualGear`** (`trainerResistanceWithVirtualGear`), as an **effective gradient, Crr and cw unchanged**:
  - The real gear is ratio_real (34/14), the virtual one ratio_virtual, and k = ratio_virtual / ratio_real.
  - At a cadence c the trainer's wheel turns at v_t = v / k while the virtual bike rolls at v in the virtual gear.
  - The crank torque is the wheel force times the wheel radius times the gear ratio, so the invariant "same cadence, same crank torque" is F_trainer(v_t) = k · F_virtual(v).
  - With the trainer's model F = m·g·(G + Crr) + ½·cw·v², this gives

    **G' = k · (G + Crr) − Crr + ½ · cw · v² · (k − 1/k²) / (m · g)**.

  - For k = 1 (no shift, or no gear source) it is exactly G. The test checks the invariant with numbers for gears 1, 12 and 24, and one worked value: gear 16 (2.6815) on 5 % at 4 m/s and 85 kg gives G' = 0.05669.
  - Why the gradient alone: scaling Crr and cw instead would need cw · k³ for the aero term, which leaves FTMS's uint8 field (max 2.55 kg/m) in the high gears. Crr would also change on the flat, where the rider expects the same road. The gradient is a sint16 with room to spare, and the device plugin clamps it.
  - Mass: the trainer applies its own rider weight. The formula assumes it is the physics' mass (85 kg by default); the manual check notes the trainer's setting.
- `virtualGear: { index, ratio }` names the gear the load used; absent without a gear source.

## Consequences

- **Predicted power per gear at 90 rpm on the flat** (700×25c wheel 2.105 m, real gear 34×14, so the trainer's wheel turns at 27.6 km/h; 85 kg, Crr 0.004, cw 0.392). It is the virtual bike's power at its speed in the gear. The measured values come from the manual check (D7).

  | gear | ratio | virtual km/h | W |
  |---|---|---|---|
  | 1 | 1.000 | 11.4 | 17 |
  | 4 | 1.228 | 14.0 | 24 |
  | 8 | 1.614 | 18.3 | 43 |
  | 12 | 2.121 | 24.1 | 81 |
  | 14 | 2.432 | 27.6 | 114 |
  | 16 | 2.788 | 31.7 | 163 |
  | 18 | 3.197 | 36.3 | 235 |
  | 20 | 3.665 | 41.7 | 342 |
  | 22 | 4.202 | 47.8 | 502 |
  | 24 | 4.818 | 54.8 | 741 |

- The physics never reads the trainer's mode, capabilities or speed; ERG ignores the load.
- A trainer-side virtual shifting path ([ADR 0057](0057-trainer-side-virtual-shifting-findings.md)) would send `resistance` and the ratio: both are already in the sample.
