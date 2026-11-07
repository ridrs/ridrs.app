<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0069: Recording, Devices and the BLE Bridge Beside the Bus

Status: **accepted with uncertainty** on 2026-11-07 by the maintainer, **built** the same day (stages 0–5, see "Implementation"; the hand test in the native app is open) ("implement everything as recommended, document the decisions as uncertain"), with the implementation brief `ridrs_elephant/prompts/15-recording-devices-bridge-beside-the-bus.md`. Builds on [ADR 0068](0068-app-state-and-services-beside-the-bus.md) and AGENTS.md rule 13. Each decision below names its confidence, the counter-proposal that was weighed, and what would make us revisit it.

## Context

After ADR 0068, 22 app events are still on the simulation bus (`packages/contracts/src/app-events.test.ts`): recording, devices and the BLE bridge. They are recorded with a ride and its 60-s pre-roll and re-executed when an interrupted ride continues. Checked in the code on 2026-11-07:

- `recording.completed` is published after a ride is sealed; when the next ride starts within 60 s it lies in that ride's pre-roll, and a continued ride delivers it again: `export-fit` writes the FIT file again, `planner-intervals-icu` loads the plan again.
- `device.connect-requested`, `device.forget-requested` and `device.discovery-requested` reach the shared BLE link (`packages/ble-peripheral/src/link.ts`) of every device plugin; re-executed, a continued ride forgets or reconnects a device.
- `bridge.pairing-offer` carries the pairing secret (`ridrs://pair?…&s=<secret>`): every offer during a ride or its pre-roll is written into the journal.
- `device-registry` (type `device-registry`) only merges the device plugins' events into `device.status-changed`, because the UI bridge replays only the latest envelope per event id (the reason `route-catalog` existed).
- The host already treats `recording` and `export` as the input side (`INPUT_SIDE_TYPES`, `plugin-host.ts`), and a replay leaves them out (`NOT_REPLAYED_TYPES`, `replay.ts`). Device plugins and `device-registry` run in a replay: they decode recorded raw data.
- The native app's composition root continues a ride on `recording.continue-requested`; only a plugin can provide a service so far.

### Evidence (stage 0, 2026-11-07)

Three scenarios of `tests/features/recording/continue-without-app-commands.feature` (tagged `@wip` until their stage) fail as predicted:

| Scenario | Failure |
|---|---|
| A device forgotten during the ride is not forgotten again when the ride continues | `"test-services" received "device.forget-requested" 2 times: once in the ride, again when it continued` |
| A pairing just before the ride is neither recorded nor done again when the ride continues | `The recording holds "483920"` (the pairing code, from the pre-roll) |
| The FIT file of a ride saved just before the next one is not written again when that ride continues | `"recordings/ride-….fit" was written 2 times` (`recording.completed` lies in the next ride's pre-roll as an input) |

## Decisions

| # | Decision | Confidence | Counter-proposal weighed | Revisit when |
|---|---|---|---|---|
| E1 | The plugin types allowed to use app state and services are `transport`, `storage`, `ui`, `device`, `recording`, `export` (`APP_CHANNEL_TYPES`; settings keep `PERSISTENCE_TYPES`). | ~90 % | A small `storage` plugin holds the ride state. Rejected: `recording-session` would still have to tell it, through the bus or a service: the same permission. | A `recording` or `export` plugin turns out to run in a replay. |
| E2 | `device-registry` is dissolved. Every device plugin owns one key `<plugin id>/<kind>` of the topic `device.status`; `ui-devices` merges per kind (scans of several plugins, the name connected last). | ~75 % | Change its type to `device` and keep it as an aggregator. Rejected: it would mix connection events from the bus with lists from the state, for a purpose (the bridge's replay rule) that is gone. | The merge in the UI grows beyond a small pure function, or a second consumer of the merged status appears. |
| E3 | `recording.completed`, `.failed`, `.deleted` become the topic `recording.ride` (key: the session). `export-fit` reconciles instead of reacting: it exports every saved ride whose FIT file is not there yet and owns `export.fit` (key: the session). | ~80 % | `recording-session` calls a service `export.fit` after sealing. Rejected: the recorder would know the exporter, and the planner and the UI need the state anyway. | Reconciling at a restart of `export-fit` costs noticeable time (it reads the recordings directory once per delivery). |
| E4 | Device commands are services keyed by `device.status` (`device.connect`, `device.forget`, `device.discover`); candidates, scans, battery and status are state; `device.connection-changed` and raw data stay inputs. Device plugins (they run in a replay) may own state and provide services but may not watch state or call services. | ~75 % | Open device setups as state that device plugins watch. Rejected: plugins that run in a replay would read app state (rule 13). | The shared link needs app state to decide something inside a turn. |
| E5 | A composition root provides a service itself: `PluginHost.provideService(owner, service, handler)`, like `subscribeEvent`. The native root provides `recording.continue`. | ~75 % | Keep `recording.continue-requested` as the one app event on the bus (it never reaches a journal: the old host and its pre-roll are dropped). Rejected: the rule would have an exception and the list would not become empty. | A second root-level provider appears that should rather be a plugin. |
| E6 | One brief in stages, as brief 14: stage 0 shows the problem, then core, recording, devices, bridge, then the empty list. | ~85 % | Three separate briefs. Rejected: more overhead; the areas meet only in `ui-devices`. | — |

## Consequences

- No app event is left on the bus; `app-events.test.ts` keeps only the simulation's requests and changes, and fails for any new `*-requested` or `*-changed` event outside that list.
- The pairing secret, device lists and ride results no longer enter a journal.
- `device.status-changed` disappears from recordings: replays of older recordings still hold it, and a replay lists it as not compared (no plugin publishes it any more).
- The uncertain points are named above; the brief's stages carry scenarios for each of them.

## Implementation

- **Stage 0 (2026-11-07):** the three scenarios above; the probe `test-services` (type `device`) counts events; `MemoryAppFiles.writes` counts whole-file writes.
- **Stage 1, core (2026-11-07):** `APP_CHANNEL_TYPES` (`manifest.ts`; `PERSISTENCE_TYPES` stays for settings); a `device` plugin may not declare `state.watches` or `services.calls` (it runs in a replay); `PluginHost.provideService(owner, service, handler)` for composition roots. Scenarios in `app-state.feature` and `services.feature`, manifest unit tests.
- **Stage 2, recording (2026-11-07):** topics `recording.ride`, `recording.recoverable`, `export.fit`; services `recording.continue` (provided by the native root), `recording.finish`, `recording.delete`; the eight recording and export events are gone. `export-fit` reconciles (`saved` without a FIT file in the app files → export; `deleted` → remove; a FIT file already there is only named, `records` absent). `planner-intervals-icu` reloads when a ride becomes `saved`. `ui-ride-recovery`, `ui-debriefing` and the ride-saved tile watch and call. Step texts that named an event (`the latest "recording.completed" event names that file …`, `the latest "export.fit-written" event …`) now name the state (`the latest "recording.ride" state …`), with the same checks. New scenario "A restarted FIT export writes no file again"; the stage-0 FIT scenario passes without `@wip`.
- **Stage 3, devices (2026-11-07):** `device-status.ts` (contracts): topic `device.status`, services `device.connect`, `device.forget`, `device.discover` (keyed by it), `mergeDeviceStatuses` (one status per kind: the most connected link stands for the kind, devices found and links scanning of all its links). The seven device app events are gone; `plugins/device-registry` is deleted. `@ridrs/ble-peripheral`: `DeviceStatusBoard` (the registry's former logic, per link) and `registerDeviceLink` (key `<plugin id>/<kind>/<n>`: Zwift Ride runs two links of one kind; the plugin provides the services once and routes by key). `ui-devices` watches `device.status` and asks every link of a kind; it reads the keys when the rider asks (a request right after the details opened was lost otherwise, found by a UI scenario). Replays get `states`/`services` (`ReplayOptions`, the recording CLI): device plugins run there and own their keys. Test device probes keep links with the same board (`tests/support/device-links.ts`). The stage-0 device scenario passes without `@wip`.
- **Stage 4, BLE bridge (2026-11-07):** topics `bridge.state`, `bridge.companions` (one value with the list, under the plugin's id: simpler than a key per companion as the brief had it; the list is small and changes rarely) and `bridge.pairing` (removed when no offer is open; it holds the secret); services `bridge.pair`, `bridge.connect`, `bridge.disconnect`, `bridge.forget` (one provider). The seven bridge events are gone. `ui-bridge-pairing` and `ui-devices` watch and call. UI device scenarios get a stand-in `test-bridge` for the companion (`device-details.feature`, Background). Found on the way: `ui-bridge-pairing` rendered into the slot's container; closing the slot while React rendered deferred its unmount past the shell's emptying of the container (`removeChild` errors in `ride-over-bridge.feature`, the scenarios still passed). It now renders into an element of its own. The stage-0 pairing scenario passes without `@wip`: the code no longer reaches the journal.
- **Stage 5, finish (2026-11-07):** `app-events.test.ts` lists only the simulation's requests and changes; no app event is left on the bus, and of the devices only the connection and the raw data are events. Docs: recording-and-replay.md, app-state-and-services.md, devices-and-metrics.md, ble-bridge.md, ui-and-activity.md, fit-export.md. All suites green (625 unit tests, 569 + 237 scenarios, native bundle).

## Residual uncertainty after building

- **E2/E4:** `mergeDeviceStatuses` replaces the registry's "latest event wins" by "most connected link wins". The scenarios agree; with two Zwift Ride controllers in different states the shown one may differ from before.
- **E4:** `ui-devices` reads the link keys when the rider asks; a request before the first delivery of `device.status` (a fraction of a millisecond after mount) finds no link and is dropped.
- **E5:** the native root's `provideService` is checked by `continue-a-ride-in-native-app.feature`; a second root-level provider would need the same care for `ambiguous-service`.
- **Test timing:** `trainer-control-replay.feature` ("A ride with shifting and ERG replays identically") timed out twice in full runs while waiting for its recording (`waitForIo`, then 2000 I/O turns); on its own it needs about 600, late in the full suite up to 1730. Whether this work made sealing slower could not be measured against the state before (nothing is committed). The harness limit is 5000 turns now; if the count keeps growing, the cause is worth finding.
- **Hand test:** device setup, pairing, a saved ride with its FIT file, deleting a ride and continuing an interrupted ride are not yet checked in `pnpm --filter @ridrs/native tauri dev`.
