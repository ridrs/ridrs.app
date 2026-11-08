<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# App State and Services

AGENTS.md rule 13: simulation on the bus, app state beside it. Two channels beside the simulation bus ([ADR 0068](../decisions/0068-app-state-and-services-beside-the-bus.md); the reasoning, references and alternatives: [the proposal](../ideas/app-state-and-services.md)). The bus carries the ride; app state carries the current value of the app's things by key; services carry the app's requests. Neither is recorded, replayed or re-executed when a ride continues.

## Which channel

**"Does a replay or a continued ride need it to reproduce the ride?"**

| Answer | Channel | Examples |
|---|---|---|
| Yes | simulation bus (`ctx.events`, `ctx.inputs`) | rider input that changes the ride (`activity.*-requested`, `drivetrain.shift-requested`, `trainer.erg-requested`), device data and connections, terrain and position, every derived event |
| No, a value | app state (`ctx.state`) | an offer and its download progress, an account, a plan |
| No, a request | a service (`ctx.services`, `ctx.call`) | download, remove, connect, upload |
| Both | the owner keeps it as app state or settings and **hands it to the ride as an input** | the garage's bicycle (`equipment.bicycle-changed`, ADR 0060) |

App state never reaches the simulation by any other path; a service that changes the ride must not exist (a provider that should change it publishes an input, as before). There is no order between the channels: a UI renders from the latest of each.

## App state

- **Topics** are `defineState(id, schema)` (`@ridrs/contracts`, `app-state.ts`). Composition roots register them (`PluginHostOptions.states`), like events; the core knows no concrete one. An unregistered topic in a manifest is `unknown-state` at start, and its plugin is blocked.
- **Keys** are strings; the first plugin that sets a key owns it until it removes it or stops (`state-key-owned` for anyone else, naming both plugins). Several plugins may own keys of one topic: the topic is the merge. For such topics, keys are `<plugin id>/<local id>` by convention.
- **Validation** on every `set`, once, in the writer: `invalid-state-value` with the paths of the issues.
- **Delivery** (`StateStore`, `packages/core/src/state-store.ts`): a watcher's first delivery is the snapshot (`changed` = every key, also when there is none), then the keys changed since its last delivery, each with its last value. All deliveries of a tick are coalesced into **one `queueMicrotask` flush**: never inside a turn, never inside the writer. Writes made during a delivery go into the next flush; a watcher that writes the topic it is receiving gets one `state-feedback` diagnostic. A listener that throws is an `event-handler-failure`.
- **Lifetime**: memory only. A stopped plugin's watches end and its keys are removed (delivered as removed); an owner that needs its state after a restart keeps it in its storage and sets it again at start.

## Services

- **Definitions** are `defineService(id, { request, response, keyedBy? })` (`services.ts`), registered by composition roots (`PluginHostOptions.services`). `keyedBy` names a topic; the request must then have `key: z.string()` (checked when the service is defined).
- **Routing** (`ServiceRegistry`, `packages/core/src/service-registry.ts`): a service without a key has one provider (two: `ambiguous-service` at start, both blocked); a keyed call goes to the owner of `request.key` in the topic (`unknown-key` if none). No provider, or one that stopped: `service-unavailable`. A service in `calls` without a provider blocks nobody.
- **Validation** of the request before the handler (`invalid-request`) and of the answer after it (`invalid-response`). A handler's `RidrsError` reaches the caller as it is; any other error becomes `service-failed` with its message.
- **Answers are quick**: a handler answers when the work is accepted. Long work is a call that starts it, state that reports it, and a call that cancels it. The handler runs after a microtask: never inside its caller or a turn.

## Who may use them

Only plugins of the types `transport`, `storage`, `ui`, `device`, `recording` and `export` (`APP_CHANNEL_TYPES`; ADR 0069 added the recorder and its exports, which a replay leaves out; settings keep `PERSISTENCE_TYPES`) declare and use them. **Device plugins run in a replay** (they decode recorded raw data): they may own state and provide services, but never declare `state.watches` or `services.calls` (`invalid-manifest`).

| Manifest | Grants | Without it |
|---|---|---|
| `state.owns: [topic]` | `ctx.state.set`, `remove`, `get`, `entries` | `undeclared-state` |
| `state.watches: [topic]` | `ctx.state.watch`, `get`, `entries` | `undeclared-state` |
| `services.provides: [service]` | `ctx.services.provide` | `undeclared-service` |
| `services.calls: [service]` | `ctx.services.call` | `undeclared-service` (rejects) |
| `ui.state: [topic]` (ui plugins) | the client's `ctx.state.watch` | `undeclared-state`; the bridge: `state-not-allowed` |
| `ui.calls: [service]` (ui plugins) | the client's `ctx.call` | `undeclared-service`; the bridge: `call-not-allowed` |

A simulation plugin that declares `state` or `services` is `invalid-manifest`; one that calls `ctx.state` or `ctx.services` gets `permission-denied`. `tests/unit/app-channels.test.ts` checks every manifest under `plugins/`.

## Host and UI

- **`PluginHost`**: `getState(topicId)`, `callService(serviceId, request, caller?)`, `provideService(owner, service, handler)` (a composition root provides a service itself, e.g. `recording.continue`, which only the root can do; ADR 0069), `observeCalls(owner, observer)` (every finished call, read-only), `observeState(owner, observer)` (every write as it happens, read-only: tests and roots), `watchState(owner, topicId, listener)` (coalesced deliveries: the bridge).
- **`UiBridge`** (`@ridrs/ui-sdk`): `watchState(topicId, listener)` sends `StateUpdate` messages (`{ snapshot, values, removed }`: the first one the snapshot, then the changes) and `call(serviceId, request)` resolves with the answer or rejects with the `RidrsError` (code and message). Both are shaped as messages, so a remote bridge can carry them later. The in-process bridge checks the registry's `state` and `calls` unions and ends its watches on `dispose()`.
- **`UiContext`**: `ctx.state.watch(topic, listener)` rebuilds the `StateView` from the bridge's messages (values checked against the topic; invalid ones dropped with a warning) and `ctx.call(service, request)`; both limited to the plugin's own `ui.state` / `ui.calls` and released with the component.

## Recording, replay and continuation

The recorder observes the bus ([recording-and-replay.md](recording-and-replay.md), "What the journal holds"; since ADR 0069 no app event is left on it); app state and services are not on it, so they never enter a journal, a replay or a continued ride. Proven by `tests/features/core/app-state.feature` ("The recording of a ride during which state was written holds none of it") and `tests/features/core/services.feature` ("A call made during a ride is not made again when the ride continues").

## Topics and services today

| Owner | Topics (key) | Services (keyed by) | Clients |
|---|---|---|---|
| `ui-settings` | `app.language` (`app`, ADR 0072) | `app.set-language` | every UI plugin |
| `ui-landscape-demo` | `route.offer` (`ui-landscape-demo/demo-course`) | — | `ui-area-ride` |
| `video-source-vangestel` | `route.offer` (`video-source-vangestel/<route>`) | `route.fetch`, `route.cancel`, `route.remove` (`route.offer`) | `ui-area-ride`, `ui-world-video` |
| `planner-intervals-icu` | `training.account`, `training.plan` (`intervals.icu`), `training.upload` (session id); watches `recording.ride` | `training.connect`, `training.disconnect`, `training.refresh`, `training.upload` (`training.account`) | `ui-training-plan`, `ui-debriefing` |
| `recording-session` | `recording.ride`, `recording.recoverable` (session) | `recording.finish` (`recording.recoverable`), `recording.delete` (`recording.ride`) | `ui-debriefing`, `ui-tile-ride-start`, `ui-ride-recovery`, `export-fit`, `planner-intervals-icu` |
| native composition root | — | `recording.continue` (`provideService`) | `ui-ride-recovery` |
| `export-fit` | `export.fit` (session); watches `recording.ride` | — | `ui-debriefing`, `ui-tile-ride-start` |
| device plugins (`@ridrs/ble-peripheral`) | `device.status` (`<plugin id>/<kind>/<n>`) | `device.connect`, `device.forget`, `device.discover` (`device.status`) | `ui-devices` |
| `transport-ble-bridge` | `bridge.state`, `bridge.companions`, `bridge.pairing` (plugin id) | `bridge.pair`, `bridge.connect`, `bridge.disconnect`, `bridge.forget` | `ui-devices`, `ui-bridge-pairing` |

## What lives where

| Thing | Channel |
|---|---|
| Rider input that changes the ride, device data and connections, terrain, derived events | simulation bus |
| Settings documents (ADR 0054/0059) | `ctx.settings` |
| App values by key | app state |
| App requests | services |
| Values both use (the garage's bicycle) | settings or app state, handed to the ride as an input |
