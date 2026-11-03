<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# AGENTS.md

## Licensing

Follow the licensing policy defined in [`LICENSING.md`](LICENSING.md).
Do not introduce or change licenses without maintainer approval.

## Standing Engineering Rules (All Phases)

1. **Test first.** Every use case starts with Cucumber scenarios that fail first. Cucumber is strict; given scenarios are never weakened.
2. **Libraries over utilities.** Generic helpers come from well-maintained, pure-JS, ESM libraries or Node built-ins; own code is reserved for ridrs domain logic. Every library choice has an ADR in `docs/decisions/`.
3. **No speculative implementation.** No events, capabilities, metrics, plugins or manifest fields without a use case in the current phase.
4. **Headless first.** All domain logic runs and is tested without a GUI.
5. **Plugins only talk through contracts.** Events and capabilities; no imports between plugins; the core never knows concrete plugins. Enforced by `dependency-cruiser`.
6. **The manifest is authoritative.** Folder prefixes are naming conventions only.
7. **Determinism.** Simulation code reads time and schedules work only through `ctx.clock`; a turn has one logical time, and tasks run at their planned time, before inputs of the same time. External inputs and results of asynchronous work enter only through the input queue (`ctx.inputs`). Ids come from `ctx.ids`, never from randomness. The same inputs give the same execution and the same states, live and on replay ([time-and-scheduling.md](docs/architecture/time-and-scheduling.md)).
8. **Extend, don't fork.** Each phase builds on the previous one; no parallel implementations.
9. **Every phase ends with a vertical use case** that runs through the real architecture.
10. **Rendering reads, never drives.** Rendering never drives or writes the simulation; frame rate never changes physics results.
