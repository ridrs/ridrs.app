<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0055: Virtual Gears as a Temporal Series That Never Goes Stale

Follows [ADR 0023](0023-temporal-model-and-defaults.md) (the temporal data layer) and rule 11 (the physics reads data through readers). Phase 8, decision D4.

## Context

The Zwift Ride's shift buttons change a virtual gear; the physics needs that gear at each step. Rule 11 forbids the physics to subscribe to data events, so the gear must come through the interpolation layer as a series. A gear held for minutes must not become `stale` there, the way a silent sensor does.

## Decision

- **`control-virtual-gears`** (type `control`, AGPL) hears `controller.buttons-changed` of any device. A **press** (a button newly held) of `shift-up-*` shifts one gear harder, of `shift-down-*` one gear easier. Holding does not repeat, and the gears end at 1 and 24. It knows no concrete controller.
- **The table:** real gear 34 × 14 (2.4286, a KICKR CORE with the Zwift Cog, the Zwift Ride's default), 24 virtual gears in a **geometric series** from 34 × 34 (1.0) to 53 × 11 (4.818): each gear 7.08 % harder than the one below, so every shift feels the same. Gear 12 (2.121) is the start of every ride; the gear does not carry over between rides (no storage yet). Everything is in its `config.snapshot`.
- **The series `drivetrain.virtual-gear`:** the value is the gear's **ratio**, written in the input's turn with `hold`. The capability's implementation gives `realRatio` and the `ratios` of the table, from which a reader gets the index. That is minimal: no second series, no metadata in the temporal layer.
- **Never stale:** the smallest extension of `@ridrs/temporal` that keeps its rules is a writer option `stale: 'never'` (only with `hold`). The last value holds until the next one and the series stays `fresh` (no `delayed`, no `stale`). A periodic re-write was rejected: it would put timers and recorded noise into a control plugin and make the series' sampling interval meaningless. A disconnect break (`markUnavailable`) still works. There is still one store, the temporal layer.
- **`drivetrain.gear-changed { index, ratio, count }`** is published in the same turn for the HUD only; the physics never reads it.
- Two shifts in the same millisecond: the gear is a state, so the series is reset and the last one is written.

## Consequences

- `physics-trainer-load` reads the ratio at its step's time through a reader; a gear of minutes ago is still there.
- A gear source is optional for the physics ([ADR 0053](0053-optional-capabilities.md)).
