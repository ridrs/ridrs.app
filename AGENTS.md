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
7. **Determinism.** Time comes from the injected clock; ordering is deterministic.
8. **Extend, don't fork.** Each phase builds on the previous one; no parallel implementations.
9. **Every phase ends with a vertical use case** that runs through the real architecture.
