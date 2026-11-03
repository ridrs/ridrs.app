<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0036: Configuration Snapshot as the Capability `config.snapshot`

## Context

A recording must say with which parameters it was made, and the recorder must know no plugin.

## Decision

- Capability `config.snapshot` (`multiple`): `{ section /* the plugin id */, snapshot(): JsonValue }`. In Phase 9: `physics-engine` (step, batch and publish cadence), `physics-bicycle`, `physics-rider`, `physics-environment`, `physics-road` (course segments), `physics-powertrain`, `physics-virtual-speed` (`minimumDriveSpeed` = v_min, maximum gradient). Their `provides` grow; their `requires` do not.
- The `snapshot` record holds `host` (`ctx.host.describe()`) and `sections` sorted by section, each passed through JSON. A throwing provider is recorded as `{ error }` and reported as `config-snapshot-failed`.
- `fixture-storage-memory` provides a section too, so `recording-session` (which requires at least one provider) runs in features without physics plugins.
- A replay reports differing, missing and added sections and plugin version changes; it applies none.
