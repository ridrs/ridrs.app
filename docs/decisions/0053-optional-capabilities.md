<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0053: Optional Capabilities (`optionalRequires`)

Amends [ADR 0005](0005-dependency-graph.md) and the capability resolution of [core.md](../architecture/core.md). Phase 8, trainer control.

## Context

A required capability without a provider blocks the plugin (`missing-capability`). Phase 8 has two dependencies that must not block:

- `physics-engine` asks `physics.trainer-load` once per step when it is installed, and rides exactly as before without it.
- `physics-trainer-load` reads the virtual gear (`drivetrain.virtual-gear`) when a gear source is installed; without one the load with the gear equals the load without it.

Making either a `requires` would make the gear source or the trainer load mandatory. Leaving it out of the manifest would make the plugin unable to read it (access is checked against the manifest) and would leave the start order to chance.

## Decision

- **Manifest field `optionalRequires`** (array of capability ids, optional): the plugin starts after the providers of these capabilities when they are there, may access them like required ones, and is **not** blocked when they are missing. An unregistered capability id is still `unknown-capability`, as for `requires`.
- **`ctx.capabilities.find(contract)`** returns the provider of a single capability or `undefined`; `get` still throws `missing-capability`. A temporal series of an optional capability may be read; without a writer it answers `no-source`, as any series does.
- Rule 6 (the manifest is authoritative) holds: what a plugin may use is still all in its manifest.

## Consequences

- Rule 3: the field has two users in this phase; it is not used for anything else.
- Capability resolution orders by both lists; blocking still follows `requires` only.
