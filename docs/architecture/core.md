<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Application Core Architecture

Phase 1 establishes the headless foundation of **ridrs**: a contract-driven plugin host and a typed in-memory event bus.

## Packages and Boundaries

- **`@ridrs/contracts` (`packages/contracts`)**: Public developer contracts licensed under `Apache-2.0`. Defines `manifestSchema`, `definePlugin`, `defineEvent`, `defineCapability`, `Clock`, `PluginContext`, `Diagnostic`, and `RidrsError`. Imports no internal packages.
- **`@ridrs/core` (`packages/core`)**: Platform runtime licensed under `AGPL-3.0-or-later`, runtime-neutral (Node and WebView). Implements `discoverPlugins`, `resolveCapabilities`, `CapabilityRegistry`, `EventBus`, `DiagnosticCollector`, and `PluginHost`. Imports only `@ridrs/contracts`.
- **`@ridrs/headless` (`apps/headless`)**: Headless CLI composition root licensed under `AGPL-3.0-or-later`. Discovers plugins from a target directory, starts the `PluginHost`, and handles graceful shutdown on `SIGINT`/`SIGTERM`.

Architectural boundaries are enforced in CI via `dependency-cruiser` (`.dependency-cruiser.cjs`). Plugins may only import `@ridrs/contracts` (and shared contract definitions) and never import `@ridrs/core`, `apps/*`, or another plugin's folder.

## Plugin Discovery & Manifest Validation

Discovery goes through the `PluginSource` port, so the core stays runtime-neutral (see [ui-and-activity.md](ui-and-activity.md#runtime-neutral-core)). `createFileSystemPluginSource(dir)` (Node-only entry `@ridrs/core/node`, `tinyglobby`) lists the immediate subdirectories of a plugin root; `createBundledPluginSource(set)` takes a plugin set bundled at build time. Every candidate's `manifest.json` is validated against `manifestSchema` (Zod v4 `.strict()` plus `semver`):

- Missing `manifest.json` reports `missing-manifest`.
- Invalid JSON or schema violations report `invalid-manifest` with field-level details.
- Duplicate `id` values across folders report `duplicate-id` and reject all conflicting folders.

## Capability Resolution & Lifecycle

1. **Resolution**: `resolveCapabilities` validates that every capability referenced in `provides`/`requires` has a registered `CapabilityContract` (`unknown-capability`), checks `single` cardinality conflicts (`ambiguous-provider`), verifies providers exist (`missing-capability`), and uses `dependency-graph` (`DepGraph`) to detect cycles (`dependency-cycle`) and compute a deterministic topological `startOrder` (ties broken alphabetically by plugin `id`).
2. **Lifecycle**:
   - `initialize(ctx)`: Providers register implementations via `ctx.capabilities.provide(contract, impl)`. Providing an undeclared capability fails with `undeclared-capability`; omitting a declared capability fails with `capability-not-provided`.
   - `start(ctx)`: Started plugins may publish and subscribe to events. After all startable plugins start, the host emits `core.host.started`.
   - `stop(ctx)`: Called in reverse dependency order (`stopPlugin(id)` stops transitive dependents first). All event subscriptions of a stopped plugin are automatically unsubscribed.
   - `dispose(ctx)`: Stops running plugins if needed, then disposes all initialized plugins in reverse initialization order.
3. **Failure Isolation**: A plugin failing to load (`entry-load-failure`) or throwing in `initialize`/`start` (`lifecycle-failure`) transitions to `failed`, and its transitive dependents transition to `blocked`, while unrelated plugins continue running.

## Typed In-Memory Event Bus

- Events are defined with `defineEvent(id, zodSchema)`.
- Every published event is validated synchronously against its Zod schema (`invalid-event-payload` on failure) and wrapped in an immutable `EventEnvelope` (`id`, `type`, `payload`, `source`, `timestamp` from the injected `Clock`).
- Delivery uses RxJS `Subject` and `queueScheduler` to guarantee synchronous run-to-completion FIFO semantics: an event is delivered to all subscribers before any event published *during* a subscriber handler is dispatched.
- Subscriber exceptions are isolated and reported as `event-handler-failure` diagnostics without affecting the publisher or other subscribers.

## Host Observation and Description (Phase 9)

- **Permissions.** A manifest may declare `permissions`; the only value is `observe-host` (anything else: `invalid-manifest`). It grants `ctx.host`; without it every call throws `RidrsError('permission-denied')` ([ADR 0030](../decisions/0030-host-observation-permission.md)).
- **`ctx.host.observe({ onEvent, onDiagnostic })`.** `onEvent` gets every envelope synchronously at publish time, after validation and before queued delivery: the one global publish order, nested publishes included. Observers are read-only (publishing from one throws), a throwing observer becomes one `event-handler-failure`, observations end when the plugin stops. Composition roots use the same tap as `PluginHost.observe(owner, observer)`.
- **`ctx.host.describe()`.** The platform (from `PluginHostOptions.platform`), the plugin set (`id`, `version`, `types`, `provides`, `requires`, `state`), the disabled plugins, the capability resolution and `TEMPORAL_DEFAULTS`. `PluginHost.getProviders(contract)` lists the providers of a `multiple` capability for composition roots (the replay's configuration snapshot).
- The core still knows no concrete event, plugin or file: recording lives in `recording-session` ([recording-and-replay.md](recording-and-replay.md)).

## Logical Time, Turns and the Input Queue

- **Clock.** `ctx.clock` is the host's logical clock: `now()`, `scheduleAt`, `scheduleEvery`, `cancel`. `LiveClock` runs on a monotonic time source (`PluginHostOptions.timeSource`, `timers`), `ReplayClock` on the replay (`PluginHostOptions.replay`). A plugin's tasks are cancelled when it stops.
- **Turns.** Every task and every external input is one synchronous turn with one logical time; items run in `(logical time, tasks before inputs, sequence number)` order.
- **Inputs.** `ctx.inputs.accept` and `PluginHost.publishEvent` queue external inputs (`input: true`, `receivedAt`); `PluginHost.input(run)` runs a composition root's action as an input turn; `injectInput` and `advanceTo` drive a replay host. Publishing or writing a series outside a turn throws `outside-turn`, except publications of input-side plugins, which are accepted as inputs.
- **Envelopes** carry a global `seq`; ids and `ctx.ids` derive from the host's `runId` (in `describe()`).
- Details and the ordering rules: [time-and-scheduling.md](time-and-scheduling.md).

## Optional capabilities (Phase 8)

A manifest may list `optionalRequires`: the plugin starts after their providers when they are there and may access them (`ctx.capabilities.find` returns the provider or `undefined`; their series may be read), but a missing provider does not block it. `physics-engine` uses `physics.trainer-load` this way, `physics-trainer-load` the virtual gear ([ADR 0053](../decisions/0053-optional-capabilities.md)).
