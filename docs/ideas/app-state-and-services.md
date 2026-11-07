<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Proposal: App State and Services Beside the Simulation Bus

**Status: accepted on 2026-11-07, stages 0–4 built** ([ADR 0068](../decisions/0068-app-state-and-services-beside-the-bus.md); the architecture as built: [app-state-and-services.md](../architecture/app-state-and-services.md)). The route offers and the training plan use app state and services; the stage-0 scenarios of `tests/features/recording/continue-without-app-commands.feature` pass; AGENTS.md rule 13 names the channel rule. Recording, devices and the BLE bridge followed with the second brief (section 5.5; [ADR 0069](../decisions/0069-recording-devices-and-bridge-beside-the-bus.md), accepted with uncertainty and built on 2026-11-07): no app event is left on the bus.

## Summary

ridrs has one channel between plugins and between host and UI: the typed event bus. It was built for the simulation: one logical time per turn, every input recorded, every derived event replayable (rules 7, 10, 11; ADRs 0039, 0055). Since the training plan, the recovery offer and the video downloads, the same bus also carries **app state** (accounts, plans, catalogs, download progress) and **app commands** (connect, upload, download, delete). They do not belong there:

1. **Correctness.** A UI publication is always an input; inputs are recorded and re-executed when an interrupted ride continues (ADR 0057). A download, an upload to intervals.icu or a device command issued during the ride or in the 60 s before it would run again after a crash.
2. **Recording size.** App state is recorded with the ride: a video download during a ride writes up to about 100 copies of the whole route catalog into the journal.
3. **Missing primitives.** The UI has no request/response (errors come back as state, with no link to the request), no state per key (the whole catalog is sent for every percent), and the bridge replays only the latest envelope per event id (so a single aggregator plugin must exist).

**Proposal:** two more channels, both outside the turn queue and outside the recording, modelled on Home Assistant's state machine and services (with ROS 2's actions as the pattern for long work):

| Channel | What | Recorded | Example |
|---|---|---|---|
| **Simulation bus** (exists) | inputs and derived events of rides | yes | `activity.start-requested`, `measurement.power`, `physics.state-batch` |
| **App state** (new) | the current value of things, by key | no | `route.offer` / `video-source-vangestel/col-de-pennes` → the offer with its download progress |
| **Services** (new) | requests with an answer or an error | no | `route.fetch` { key } → resolves or rejects with a reason |

**Recommendation: build it** (section 9). Not because it is elegant: the journal must hold the ride and only the ride, and every further app feature (events, workouts, a second video source, cloud sync) would otherwise add more commands that a continued ride re-executes.

## 1. Facts (checked against the code on 2026-11-07)

- **The bus** delivers synchronously, run-to-completion, FIFO; every envelope is zod-validated (`packages/core/src/event-bus.ts`). Publications of input-side plugins outside a turn, and every publication through the UI bridge (`host.publishEvent('ui-bridge', …)`), enter the input queue (`input: true`).
- **The recorder** (`recording-session`) observes every published event (`ctx.host.observe`) and writes every one during a ride plus a 60-s pre-roll (`plugins/recording-session/index.ts`, `onEvent`).
- **A replay** leaves out plugins of the types `transport`, `storage`, `recording`, `export` and `ui` and injects every recorded input; inputs nobody listens to do nothing (`docs/architecture/recording-and-replay.md`).
- **Continuing a ride** (`packages/replay/src/continue.ts`) starts **every** plugin and injects **every** input of the committed journal (`recordedInputs`: `input === true`), live, before going on. So every recorded app command reaches its handler again:
  - `route.fetch-requested` → `video-source-vangestel` downloads again (a running download restarts, a removed route comes back);
  - `training.upload-requested` (the debriefing's Upload, if a new ride started within 60 s) → `planner-intervals-icu` uploads the activity again, with no check (`index.ts`, line 191);
  - `training.connect-requested` → the browser sign-in opens again;
  - `recording.delete-requested`, `device.forget-requested`, `device.connect-requested`, `bridge.*-requested` → run again;
  - the results of asynchronous app work, accepted as inputs (`training.plan-changed`, `training.account-changed`, `route.offers-changed`), are injected **after** the fresh host published its current values, so the UI shows the recorded, older state.

  Reproduced on 2026-11-07 (stage 0): a download and an upload request arrive twice, ten app events end up in the recording ([ADR 0068](../decisions/0068-app-state-and-services-beside-the-bus.md), "Evidence").
- **App traffic today:** 68 event types in `@ridrs/contracts`. 8 UI plugins use app-state or app-command events: `ui-area-ride`, `ui-world-video` (route.\*), `ui-training-plan`, `ui-debriefing` (training.\*, recording.\*), `ui-ride-recovery`, `ui-tile-ride-start` (recording.\*), `ui-devices`, `ui-bridge-pairing` (device.\* / bridge.\* commands and status).
- **Precedent for a channel beside the bus:** settings documents (`ctx.settings`, ADR 0054/0059) already pass the bridge without the bus, restricted by plugin type and manifest field.
- **Workarounds the missing channel caused** (V1/V2 of the video sources): the aggregator `route-catalog` exists because the bridge replays one envelope per event id; `route.offers-changed {}` is a signal to re-read a capability; the whole catalog goes out for every percent of a download; the video world keys its effect on `JSON.stringify` of the offer's files so another download's progress does not reload the ride's route.

## 2. Requirements

1. The journal contains what a replay or a continued ride needs, and nothing a continued ride must not do again.
2. The UI sees the current value of app things, per key, with only changes after the first snapshot.
3. The UI can ask a host plugin to do something and learns whether it worked, with a reason.
4. Long work (downloads, uploads, sign-ins) reports progress and can be cancelled.
5. Plugins stay small and do not know each other (rule 5); the manifest says what a plugin owns, provides, watches and calls (rule 6).
6. Simulation code cannot read app state or call services: determinism stays (rules 7, 11).
7. The same contracts work in-process (today) and over a remote bridge (the `UiBridge` port foresees a WebSocket gateway).
8. Headless first (rule 4): the host side works and is testable without a UI.

## 3. Reference architectures

| Reference | What it shows | Taken over |
|---|---|---|
| **Home Assistant** core: event bus, state machine, service registry, timer ([core](https://developers.home-assistant.io/docs/architecture/core/)); WebSocket `subscribe_events`, `subscribe_entities` (snapshot, then changed fields), `call_service` with an optional response ([API](https://developers.home-assistant.io/docs/api/websocket)); Lovelace cards get `setConfig` and `hass` ([custom card](https://developers.home-assistant.io/docs/lovelace_custom_card)) | state and events are different things; a UI watches state by key; commands are service calls | app state by key, services, snapshot-then-changes delivery |
| **ROS 2** topics, services, actions (goal, feedback, result, cancel; client-made goal ids) ([design](https://design.ros2.org/articles/actions.html)); rosbag2 records chosen topics, with exclusions | long work as its own pattern; recording by channel | long work = call + state + cancel call; the journal records the simulation channel only |
| **VS Code** extension host, contribution points, webviews that only talk by messages and read local files through URIs the extension issues ([principles](https://vscode-docs1.readthedocs.io/en/latest/extensionAPI/patterns-and-principles/)) | isolated UI parts | UI plugins keep no capabilities; resources by URL from the owner (as `availability.files` already does) |
| **Grafana** plugins: frontend plus optional backend, connected by query, resource and health calls ([backend plugins](https://grafana.com/developers/plugin-tools/key-concepts/backend-plugins/)) | a plugin's UI calls its own backend | services provided by a plugin's host side, called by UI parts |
| **Backends for Frontends** (Sam Newman; [Azure pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends)) | a backend shaped for one UI | no extra layer: in one process, a host plugin that owns state *is* the BFF of its UI |
| **Microkernel / plug-in architecture** (Richards & Ford, *Fundamentals of Software Architecture*, ch. 12/13; Birsan, ACM Queue 3(2), 2005) | small core, contracts, "plug-in hell" | core stays generic: it validates and routes, never interprets |
| **Deterministic simulation** (Fiedler, [Fix Your Timestep](https://gafferongames.com/post/fix_your_timestep/), [Deterministic Lockstep](https://gafferongames.com/post/deterministic_lockstep/)) | record inputs only, never derived or foreign state | the journal is the simulation's inputs; app state never enters it |
| **CQRS / event sourcing** (Fowler, Young) | commands vs queries; read models are projections | services are commands, app state is the read model |

## 4. The architecture

```text
                 ┌──────────────────────────── host (one process) ─────────────────────────────┐
 UI plugins      │                                                                             │
 (UiContext)     │  simulation bus ── turns, inputs, recorded ──► physics, metrics, activity  │
  ctx.events ◄───┼──► events (allow-list ui.events)                                            │
  ctx.state  ◄───┼─── app state store ◄── ctx.state.set (owner: input-side host plugins)       │
  ctx.call   ────┼──► service registry ──► ctx.services.provide (input-side host plugins)     │
  URLs       ────┼──────────────────────────────────────────────► ridrs-media://, bundle      │
                 │                                                                             │
                 │  recorder ── observes the simulation bus only (unchanged)                   │
                 └─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Which channel: one test

**"Does a replay or a continued ride need it to reproduce the ride?"**

- Yes → **simulation bus** (as today): rider input that changes the ride (`activity.*-requested`, `drivetrain.shift-requested`, `trainer.erg-requested`), device data and connections, terrain and position, the frozen bicycle, every derived event.
- No → **app state** (a value) or **services** (a request).
- **Both** (an app value that the ride uses, e.g. the garage's bicycle): the owner keeps it as app state or settings and **hands it to the ride as an input**, as the garage already does (`equipment.bicycle-changed`, ADR 0060). App state never flows into the simulation by any other path.

### 4.2 App state

A **state definition** names a topic and the schema of its values. Values live under string keys; one key has exactly one owner.

```ts
// @ridrs/contracts (Apache-2.0)
export const routeOfferState = defineState('route.offer', routeOfferSchema);
//                                          topic id      value schema (zod)

// a host plugin (manifest: "state": { "owns": ["route.offer"] })
ctx.state.set(routeOfferState, 'video-source-vangestel/col-de-pennes', offer); // validated, owned
ctx.state.remove(routeOfferState, 'video-source-vangestel/col-de-pennes');

// a UI plugin (manifest: "ui": { "state": ["route.offer"] })
ctx.state.watch(routeOfferState, ({ entries, changed }) => render(entries));
```

Rules:

- **Ownership.** The first plugin that sets a key owns it until it removes it or stops; another plugin setting it throws `state-key-owned`. A stopped plugin's keys are removed (like its subscriptions). Several plugins may own keys of the same topic: the topic is the merge (no aggregator plugin).
- **Validation.** Every `set` is validated against the topic's schema; an invalid value throws in the writer (a bug is visible where it is made, not silently dropped by a consumer).
- **Delivery.** A watcher gets the full snapshot at once (`changed` = every key), then the keys changed since its last delivery, **coalesced per microtask** (the last value of a key wins). A writer may set progress as often as it likes; watchers see at most one change per key per tick.
- **Who.** Only plugins of the input-side types (`transport`, `storage`, `device`, `ui`; the list of ADR 0054) may own, watch or provide: simulation plugins (`physics`, `metric`, `activity`, `control`, …) get `permission-denied`, as for settings. Every topic a plugin owns or watches is declared in its manifest (`state.owns`, `state.watches`, `ui.state`); undeclared use throws `undeclared-state`.
- **Not recorded, not replayed.** The store is beside the bus: the recorder never sees it; a replay host has no input-side plugins; a continued ride's plugins rebuild their state from their storage at start, as they do on every start.
- **Not persistent.** The store is memory. An owner that needs its state across restarts keeps it in its storage (app files, media, secrets) and sets it again at start.

### 4.3 Services

A **service definition** names a request and a response schema.

```ts
export const routeFetchService = defineService('route.fetch', {
  request: z.object({ key: z.string() }).strict(),
  response: z.object({}).strict(),
  keyedBy: routeOfferState, // routed to the owner of request.key in route.offer
});

// provider (manifest: "services": { "provides": ["route.fetch"] })
ctx.services.provide(routeFetchService, async ({ key }) => {
  downloads.start(key); // long work goes on; progress is state
  return {};
});

// caller: a UI plugin (manifest: "ui": { "calls": ["route.fetch"] })
try {
  await ctx.call(routeFetchService, { key: offer.id });
} catch (error) {
  showError(error); // RidrsError: unknown-key, service-unavailable, invalid-request, or the provider's reason
}
```

Rules:

- **Routing.** A service without `keyedBy` has exactly one provider (two: `ambiguous-service` at resolution, both blocked, like a `single` capability). A keyed service may be provided by several plugins; a call goes to the owner of `request.key` in the named topic, `unknown-key` if none.
- **Validation** of request and response at the registry; a handler's rejection reaches the caller with its message.
- **Answers are quick.** A handler answers when the work is accepted, not when it is done. **Long work** is a call that starts it, state that reports it (`fetching`, `received`, `failed` with a reason) and a call that cancels it: ROS 2's action, built from the two primitives. A separate action primitive is not built until a use case needs more (rule 3).
- **Who:** as for state. Services may call services (declared in `services.calls`).
- **Not recorded.** A service that changes the ride must not exist: a ride is changed by inputs. A host plugin whose service result should enter the ride publishes an input, as today.

### 4.4 The UI side

- **Manifest** (`ui` section): `state: [topic ids]`, `calls: [service ids]`, next to `events`.
- **UiContext:** `ctx.state.watch(def, listener)`, `ctx.call(def, request)`.
- **UiBridge port:** `watchState(topicId, listener)` and `call(serviceId, request)`; the in-process bridge enforces the registry's allow-lists like it does for events. A remote bridge maps them onto messages as Home Assistant does (`subscribe` → snapshot then changes; `call` → result or error by request id).
- **Resources:** files stay URLs that their owner issues (the offer's `availability.files`, `ridrs-media://`). A `ctx.resources` port is not needed yet.

### 4.5 The host side

- **Manifest** (top level): `state: { owns, watches }`, `services: { provides, calls }`; `invalid-manifest` for a plugin type outside the input side.
- **PluginContext:** `ctx.state` (`set`, `remove`, `get`, `entries`, `watch`), `ctx.services` (`provide`, `call`).
- **PluginHost** (composition roots, tests): `getState(topicId)`, `callService(serviceId, request)`, `observeState(owner, listener)`.
- **Core** stays generic: `state-store.ts` and `service-registry.ts` validate, route and deliver; they never interpret a topic.

### 4.6 Recording, replay and continuation

The mechanism does not change: the recorder observes the bus, the replay injects inputs. What changes is what is on the bus: after the migration it carries no app commands and no app state, so a continued ride re-executes only rider inputs and device data. The remaining app events are listed in section 6.4 and leave the bus in a second step.

## 5. Examples: what it means for our plugins

### 5.1 Route offers and downloads (V1/V2 of the video sources)

| Today | After |
|---|---|
| capability `route.offers` (multiple); aggregator `route-catalog`; events `route.catalog-changed`, `route.offers-changed` | topic `route.offer`; every provider sets its offers' keys |
| `route.fetch-requested`, `route.remove-requested` events; failure only as `availability.failed` | services `route.fetch`, `route.remove`, keyed by `route.offer`; a refused request rejects; download failures stay state |
| whole catalog for every percent; video world dedups by `JSON.stringify` | one key per change, coalesced; the video world watches its route's key |

```ts
// ui-landscape-demo (host side)
ctx.state.set(routeOfferState, 'ui-landscape-demo/demo-course', demoCourseOffer());

// video-source-vangestel (host side)
for (const offer of catalogOffers(catalog, thumbnail)) ctx.state.set(routeOfferState, offer.id, offer);
const downloads = new VideoDownloads(downloadables(catalog), (id) =>
  ctx.state.set(routeOfferState, id, offerWith(id, downloads.availability(id))), // only the changed offer
);
ctx.services.provide(routeFetchService, async ({ key }) => void downloads.fetch(key));
ctx.services.provide(routeRemoveService, ({ key }) => downloads.remove(key));

// ui-area-ride (client)
ctx.state.watch(routeOfferState, ({ entries }) => setOffers([...entries.values()]));
onDownload = () => ctx.call(routeFetchService, { key: offer.id }).catch(showError);
```

`route-catalog`, `route.offers`, `route.catalog-changed`, `route.offers-changed`, `route.fetch-requested` and `route.remove-requested` go away. A download during a ride leaves no trace in the journal.

### 5.2 Training plan and activity upload

| Today (events) | After |
|---|---|
| `training.account-changed`, `training.plan-changed` (inputs of async work, recorded) | topics `training.account`, `training.plan` (key: the service, `intervals.icu`) |
| `training.connect-/disconnect-/refresh-requested` | services `training.connect`, `training.disconnect`, `training.refresh`, keyed by `training.account`: a second planner (another service) plugs in by owning its account key |
| `training.upload-requested` / `training.upload-changed` | service `training.upload` { key: service, sessionId, file }; topic `training.upload` (key: sessionId) for progress and result |

The duplicate upload after a continued ride cannot happen: the request is not an input. The secret test "no event contains the token" extends to "no state value contains the token".

### 5.3 The video world

`ui-world-video` watches `route.offer` and reads the key of its ride's route (from `activity.state-changed`, a simulation event, unchanged). It reloads only when that key's `files` change. Its sensor role (`ui.terrain-observed`, `ui.position-observed`) stays on the bus: the ride needs it.

### 5.4 What stays as it is

- `activity-session`, physics, metrics, devices' data, controls, the HUD widgets, the landscapes' sensor events: simulation.
- The garage: settings plus the input `equipment.bicycle-changed` (the "both" rule of 4.1).
- Settings documents: already their own channel.

### 5.5 Second step (separate brief)

| Plugin(s) | App events today | After |
|---|---|---|
| `recording-session`, `export-fit`, `ui-ride-recovery`, `ui-tile-ride-start`, `ui-debriefing` | `recording.recoverable-changed`, `.completed`, `.failed`, `.deleted`, `export.fit-written`; `recording.continue-/finish-/delete-requested` | topic `recording.ride` (key: session); services `recording.continue`, `.finish`, `.delete`; `export-fit` watches the topic for completed rides |
| `device-registry`, device and transport plugins, `ui-devices` | `device.candidates-changed`, `.scan-changed`, `.status-changed`, `.battery-changed`; `device.connect-/forget-/discovery-requested` | topics `device.candidate`, `device.status`; services `device.connect`, `.forget`, `.discover`. `device.connection-changed` and raw data stay inputs |
| `transport-ble-bridge`, `ui-bridge-pairing`, `ui-devices` | `bridge.*` | topics `bridge.companion`, `bridge.state`; services `bridge.pair`, `.connect`, `.disconnect`, `.forget` |

Devices need care: their commands lead to connection inputs. The command leaves the journal; the connection it causes stays in it.

`recording-session` (type `recording`) and `export-fit` (type `export`) are not input-side types. The second brief decides whether these two types join the list of 4.2 (they are left out of replays already, like the input side) or whether their app state moves to a small storage-type plugin.

## 6. Problems the change could cause, and their answers

| # | Risk | How likely / how bad | Answer |
|---|---|---|---|
| 1 | **Determinism leak:** a simulation plugin reads app state or calls a service | would silently break replays | runtime `permission-denied` by plugin type (precedent ADR 0054); manifest validation; a unit test like rule 11's that physics/metric/activity manifests declare no state or services |
| 2 | **"Both" data** taken from state into a ride without an input | replay differs | rule 4.1, written into AGENTS.md rule 11's neighbourhood; the garage is the worked example |
| 3 | **No order between channels:** a UI sees `route.offer` ready before or after an event | wrong UI for a tick | documented: no cross-channel order; UI code renders from the latest of each; no simulation decision depends on it (1) |
| 4 | **Migration breadth:** 8 UI plugins, 6 host plugins, ~25 event types, their Cucumber steps | large diff, broken tests | stages with green suites after each; routes and training first (stage 2, 3), recording and devices in a second brief |
| 5 | **Remaining app commands** re-executed on continuation until the second step | the bug of section 1 for recording/device/bridge commands | stage 0's scenarios cover routes and training; the second brief starts with the same scenarios for its events; until then the known cases are listed in the ADR |
| 6 | **Ownership conflicts** (two providers, same key) | a provider throws | keys are `<pluginId>/<local>` by convention for multi-provider topics; the error names both plugins |
| 7 | **Keyed routing** surprises (calls to a key that disappeared) | a rejected call | `unknown-key` is an ordinary rejection; the UI shows it; tests cover it |
| 8 | **Re-entrancy:** a watcher sets state during delivery | loops | delivery is coalesced on a microtask; writes during delivery go to the next one; a watcher may not set the topic it watches (diagnostic) |
| 9 | **Validation cost** of large values (an offer with a 64-point sparkline) | CPU per write | one key per write (not the whole catalog); measured in a unit test with 1000 writes |
| 10 | **Host swap** on continuation (native app re-composes host and bridge) | UI watches the old store | the shell is remounted with the new bridge today; watches are re-created like subscriptions |
| 11 | **Tests** use `world.tapped` (events) for app checks | steps need new taps | `PluginHost.observeState` and a `world.stateOf(topic)` helper; the token-secrecy step checks state too |
| 12 | **Remote bridge** later: state deltas and calls over a socket | design drift | the port is message-shaped from the start (watch → snapshot + changes; call → id, result/error) |
| 13 | **Two ways to do one thing** during the migration | confusion | the ADR names the rule of 4.1; dependency-cruiser cannot see it, so a contract test lists the app events still on the bus and must shrink to empty in the second brief |
| 14 | **Scope creep** (persistence, sync, history in the store) | a second database | the store is memory only (4.2); persistence stays with the owners (ADR 0052 domains) |

None of these blocks the design; 1, 2 and 5 need the tests named.

## 7. Alternatives considered

| Alternative | What it fixes | Why not alone |
|---|---|---|
| **A. Flag app events** `defineEvent(id, schema, { journal: false })`: the recorder skips them, continuation never injects them | the bug and the recording size | leaves no request/response, no state per key, no aggregator removal; a flag every new event author must remember, on the channel built for determinism |
| **B. Finer events** (`route.offer-changed` per offer) and a bridge that replays per (event, source) | catalog size, aggregator | journal and continuation bug unchanged |
| **C. A BFF layer** (separate service or plugin type for UI data) | shapes data for the UI | in one process it adds a hop and a concept; a state-owning host plugin already is its UI's backend |
| **D. A global client store** (Redux-like, or CRDT sync) | UI state handling | solves the UI half only; the host's ownership and the journal stay as they are |

A is the cheapest fix of the bug and stays a fallback if the maintainer declines the proposal; it should not be built in addition.

## 8. Effort

Stage 0 (reproduce) and 1 (core, contracts, bridge, SDK, test support): the larger part, about one agent session. Stage 2 (routes) and 3 (training): one session together. Second brief (recording, devices, bridge): one to two sessions. Documentation and ADR within each.

## 9. Recommendation

**Worth it, and necessary before further app features.** The decisive argument is requirement 1: a continued ride re-executes app commands today (section 1), and each new app feature built on the bus adds more of them. Alternative A would fix that narrowly, but the platform's goal (small, interchangeable plugins; new content as plugins) depends on the two primitives the UI lacks, request/response and state per key, and A provides neither. The design follows proven references (Home Assistant, ROS 2), reuses existing rules (input-side types, manifest allow-lists, inputs for "both" data) and leaves the simulation untouched.

Build it in the stages of the brief, routes and training first; leave recording, devices and the bridge to a second brief that starts right after.
