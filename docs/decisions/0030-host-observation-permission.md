<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0030: Host Observation Behind a Manifest Permission

## Context

Recording needs every event and diagnostic of the host in one global order, without code in every plugin. A plugin must never get that silently.

## Decision

- The manifest gets an optional, strictly validated `permissions` array. The only value is `observe-host`; any other value makes the manifest invalid.
- `ctx.host.observe({ onEvent, onDiagnostic })` and `ctx.host.describe()` throw `RidrsError('permission-denied')` without the permission. The core checks it on every call.
- `onEvent` runs synchronously in `publishFromSource`, after validation and before queued delivery: the one global publish order, also under nested publishes. Observers are read-only (publishing from one throws); a throwing observer becomes one `event-handler-failure`. Observations belong to the plugin context and end when it stops.
- `describe()` returns the platform (given by the composition root), the plugin set (`id`, `version`, `types`, `provides`, `requires`, `state`), the disabled plugins, the capability resolution and `TEMPORAL_DEFAULTS`.
- Composition roots get the same tap as `PluginHost.observe(owner, observer)` (used by the replay and the tests) and `PluginHost.getProviders(contract)` for `multiple` capabilities.

## Consequences

- The core still knows no concrete event, plugin or file.
- `recording-session` observes from `initialize`, so events published while other plugins start (the initial `activity.state-changed`) are part of its pre-roll.
