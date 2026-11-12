<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0092: Device Kinds with Levels, Several Kinds per Device, the Companion as a Device

Status: **proposed** on 2026-11-12. Decisions marked *maintainer* were taken by the maintainer in the session of that day; decisions marked *proposed* are Claude's and wait for the maintainer's review. Amends [ADR 0046](0046-one-link-per-device-and-signal-strength.md), [ADR 0054](0054-plugin-settings-and-remembered-devices.md) and [ADR 0069](0069-recording-devices-and-bridge-beside-the-bus.md). The controller pair (one device of two halves, batteries per part) is decided in [ADR 0089](0089-a-device-made-of-several-parts.md); this ADR relies on it and does not repeat it.

## Context

Checked in the code on 2026-11-12 (`plugins/ui-devices`, `packages/contracts`, `plugins/transport-ble-bridge`):

- The driver side is already uniform: every device link sets one key of `device.status` (state, candidates, links scanning, battery, route), and the setup asks every link of a kind through `device.connect`, `device.forget` and `device.discover`.
- The kinds are `trainer | heart-rate | controller` (`deviceKindSchema`), one kind per link. **"Power Meter" exists only in the UI**: `describeDevices` shows the trainer's status in a power row (`devices.ts:196-209`). A power meter of its own has no place, and the power row says "Searching…" whenever the trainer does.
- The setup knows its kinds in code, not in a table: a `switch` for the proof of a row (watts, bpm, held buttons; `devices.ts:115-145`), the controller hidden until found (`devices.ts:186`), the controller pair exceptions (`setup.tsx:824-825`).
- The companion has a row of its own kind with its own states (`BridgeState`), tones, words and details (`devices.ts:302-351`, `setup.tsx:946-1000`). After 30 s of trying it says "Not reachable", although `bridge-link.ts` keeps trying every 5 s and connects on its own once the phone is there. The sensors say "Searching…" for as long as it takes.
- The name a searching row shows is only the device connected last **in this run** (`DeviceStatusBoard.lastName`); after a restart a remembered device is searched for without its name.
- `metric-source` takes the first device that delivers a value as the source, keeps it while it delivers, and falls back to the next one when it goes silent or disconnects.
- The bridge runs in every build of `apps/native` (macOS, Windows, Linux, Android, iOS); `apps/headless` leaves it out because its connector needs the Tauri runtime (`apps/headless/src/main.ts:121-128`).

## Decisions

### Kinds and levels

| # | Decision | By |
|---|---|---|
| 1 | The setup keeps **one table of kinds**: id, level, order, name and icon (i18n), and the reading that proves a connected row (watts, bpm, rpm, held buttons; none for the trainer and the companion). It replaces the `switch` and every `kind === …` in the setup. | proposed |
| 2 | **Levels.** Required: power. Recommended: trainer, heart rate, cadence (RPM), companion. Every other kind, including the controller and kinds the table does not know, is optional. | maintainer |
| 3 | **Required does not block and does not warn more than today.** Continue stays enabled; a ride never needs a device. Required and recommended rows may look exactly alike; no extra hint text. | maintainer |
| 4 | **Order:** power, trainer, heart rate, cadence, companion, then optional kinds in the order their first device was found. | maintainer |
| 5 | A kind the table does not know gets a generic row: its name from the device, a generic icon, "Connected" as its proof. | proposed |

### Which rows the setup shows

| # | Decision | By |
|---|---|---|
| 6 | A **required or recommended** row is always shown when a running plugin serves the kind. The companion row is shown wherever the bridge transport runs (every native build; not the headless host). | maintainer (companion), proposed (rule "a running plugin serves the kind") |
| 7 | **Every** row, of any level, is shown while a device of its kind is connected, found, or **remembered and not removed by the rider**. A remembered device that is not there shows its name and "Searching…": the rider sees that ridrs looks for it and connects it once found. | maintainer |
| 8 | To show 7 after a restart, the status carries the **remembered device's name** (from the settings document of ADR 0054), not only the name connected last in this run. | proposed |
| 9 | There is a **cadence driver** (Bluetooth Cycling Speed and Cadence, CSC) from the start, so cadence is a kind like power and needs no exception. | maintainer |

### Several kinds per device

| # | Decision | By |
|---|---|---|
| 10 | A driver declares **a list of kinds per device**, not one kind per link: an FTMS trainer `trainer, power, cadence`, a power meter `power` (and `cadence` when it measures it), a CSC sensor `cadence`. A device found has its *possible* kinds (from its advertised services); a connected device has its *confirmed* kinds (from what it really delivers, cf. the optional characteristics of `device.connection-changed`). A kind that is not confirmed leaves that row. | maintainer (several kinds), proposed (possible/confirmed) |
| 11 | New kinds in `deviceKindSchema`: `power`, `cadence`, `companion`. Old recordings with one `kind` read as a list of one. | proposed |
| 12 | **One device, several rows.** A connected device shows in the row of every kind it serves. The details of a row list every device found that can serve the kind, from every driver. Connecting a device from one row fills all its rows. | maintainer |
| 13 | **The source of a kind:** the device that delivered first wins and stays while it delivers, as `metric-source` already does. A power meter connected before a trainer stays the power source. The row shows the device that is the source now. | maintainer |
| 14 | **Remove in a row removes the device from that kind only** (e.g. the trainer is no longer a power source) and is remembered per kind. The device stays connected for its other kinds; only Remove in its last row disconnects it. | maintainer |
| 15 | Removing a device from a kind changes which values of the ride count. It must therefore **reach the ride as an input** (AGENTS.md rule 13), so a replay and a continued ride give the same result; the remembered choice itself stays machine configuration (ADR 0054). How (an input event, or the driver not publishing the kind) is decided in the implementation. | proposed, **to check** |

### The companion: a link and a device

| # | Decision | By |
|---|---|---|
| 16 | The companion plugin is **both a link and a device**. As a link nothing changes. As a device it sets an ordinary key of `device.status` with the kind `companion`: candidates are the companions found in the network (mDNS), `discover` looks for them, `connect` connects with the stored pairing or starts pairing, `forget` forgets the pairing. The bridge logic in `bridge-link.ts` stays. | maintainer (both), proposed (mapping) |
| 17 | **States**: `unpaired` → `searching`; `connecting`, `connected`, `reconnecting` stay; `unreachable` → **`searching`** with its reason and tip; a pause → `disconnected` ("by ridrs" / "on the phone"); `rejected` → `disconnected` ("wrong code"). The 30 s only decide when the tip appears. | proposed |
| 18 | **Reason and tip** become optional fields of every device status, usable by sensors too (e.g. a flat battery). | proposed |
| 19 | A driver may **contribute an area to its details**. It replaces the companion's pairing slot `setup/companion`; later e.g. a trainer's calibration. | proposed |
| 20 | The companion is never found over the `companion` link itself. | proposed |
| 21 | `bridge.state` stays for its other readers (`overLinksInReach`, the reconnect in the device details); only the setup moves to the device status. | proposed |

### What stays

| # | Decision | By |
|---|---|---|
| 22 | The trainer's control fact (ERG, simulation) in its details stays: the trainer is a known kind. | proposed |
| 23 | The heart rate row's thoughts stay: UI only, never the ride. | proposed |

## Consequences

- `CompanionRow`, `describeCompanion`, `BRIDGE_TONES`, the `bridgeStates` words and most of `CompanionDetails` go; the companion is one entry of the table.
- `describeDevices` loses its power-shows-the-trainer logic (the `own` counts); `mergeDeviceStatuses` groups by every kind a status serves.
- `device.forget` names the kind it removes the device from; `device.connect` may name the row it came from.
- The remembered device per kind of ADR 0054 becomes the remembered device per link with the kinds removed from it.
- Specs to change where behaviour changes: `tests/features/ui/device-details.feature` (companion "Not reachable" → "Searching…"), `tests/features/bridge/bridge-control.feature` (the state shown after 30 s), `tests/features/devices/device-status.feature`, `tests/features/ui/device-setup-proof.feature`. The alt text of the devices screenshot in `web/src/landing.js:547` changes with it.

## Order of work

1. This ADR, reviewed by the maintainer.
2. The controller pair ([ADR 0089](0089-a-device-made-of-several-parts.md)): done, merged on 2026-11-12.
3. Several kinds per device and the table of kinds, with the power row as its first user (10–15, 1–8).
4. The cadence driver (9).
5. The companion as a device (16–21).

## Open

- 15: how removing a device from a kind enters the ride.
- 6: whether a kind no running plugin serves should still show a row (proposed: no).
- On a phone, ridrs connects its devices directly; whether the companion row should be left out there is not decided (today it is shown).
