<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# UI/UX draft: startup, onboarding, devices and companion

Status: **draft for review**. Nothing here is implemented. This page records the decisions so far and the rules behind them. The clickable prototype starts at [index.html](index.html): open it in a browser, no build needed. Every page has a state switcher and a note explaining each state. The prototype is for discussion only. It is not app code and belongs to no package.

## Decisions

1. **Connect with option C.** Remembered devices reconnect automatically at app start. New devices are searched for during first-time setup or when the rider asks.
2. **Setup connects everything by itself.** If a kind has exactly one candidate, it connects. A *conflict* is resolved **inline in the same screen**, never in a popup. A conflict means two physical devices for one kind: two heart rate straps, or a power meter plus the trainer's own power. Nothing for that kind connects until the rider picks; the other rows keep connecting.
3. **Reconnecting added devices is a must.** A remembered device is retried with backoff at start and during a ride, without any screen.
4. **Setup collapses** into a **device indicator** on Main once nothing is unresolved. When everything is connected, it does so on its own after 3 s, and "Stay here" cancels that.
5. **A device discovered later** only adds an amber **badge** to the indicator: no toast, no sound.
6. **A ride never needs a device.** "Start ride" lives on Main and is never blocked. The Setup button is "Continue" or "Done".
7. **During a ride** a lost device shows a small banner and a grey widget, and the ride continues.
8. **A companion phone is added, not switched to** (new in this revision). Devices seen by this machine and by the companion are merged, and duplicates are shown once. Devices on this machine are preferred, and the rider can make the companion the preferred link per device or as the default.

## Review of the first draft: what changed and why

| Finding | Change |
|---|---|
| The "new device" toast on Main contradicted decision 5. | Badge only. The new device appears as a "Review" row when the indicator is opened. |
| The device picker was hard-wired to heart rate, and the power row had a chevron that led nowhere. | One generic **Device** page per kind. Rows without anything to open have no chevron. The power row opens only once a second power source exists. |
| Power conflict was not designed. | Setup state "Power conflict": a power meter versus the trainer's power, using the same inline pick. |
| "Finish ride" was one tap away: sweaty fingers, towels. | **Hold 1 s to finish**, with a progress fill. |
| Collapse from Setup to Main was only described, not shown. | Setup "All connected" counts down 3 s, and Main "From setup" animates the indicator in. |
| Menu → Devices opened Main without the rows. | It opens Main with the indicator expanded. |
| Skipped setup left three grey dots. | The indicator becomes "Set up your devices" and leads to Setup. |
| "Not found" was a dead end on a companion setup. | Retry, add a companion phone, or continue. |
| Bluetooth denied had only "settings" or "without devices". | It also offers "Use a companion phone instead". |
| Accessibility. | Status texts use `role=status` and `aria-live`; the pickers are radio groups with keyboard support; there is a focus ring; signal bars have labels; icons are `aria-hidden`. Colour is never the only signal: ✓, ⚠ and text always accompany it. |

## Companion phone: additive, merged, local first

Today ([ble-bridge.md](../architecture/ble-bridge.md)) the rider chooses **either** this device's Bluetooth **or** the companion. `ble.central` has one provider, the other transport's plugins are disabled, and a switch restarts the WebView. The new concept drops that switch.

**Terms**
- **Route**: a link that can see and connect devices. This machine's Bluetooth is one route, and each paired companion is another.
- **Physical device**: one trainer or strap. It can be seen by several routes at once.
- **Duplicate**: one physical device seen by two routes. It is merged into one entry with two route chips: "This Mac" and "also Pixel 8".

**Duplicate detection.** The same device has different ids per route: macOS reports a CoreBluetooth UUID per host, while Android reports the address. So ids cannot be compared directly. Two sightings are treated as the same device when all of these hold:
1. They are the same kind (they offer the same service, for example `180d` or FTMS).
2. They have the same advertised local name (for example "KICKR 1234" or "Polar H10 A1B2"; these usually carry a serial suffix).
3. Their manufacturer data, if either side has it, does not contradict.

Once merged, the registry **remembers the pair of route ids** for that device. Later sightings match by id, not by name.

- **False merge** (two identical trainers without suffixes in one room): "These are two different trainers" on the Device page splits them, and the split is remembered.
- **False split** (one route sees no name): the device shows twice until the name arrives. This is harmless.

**Which route carries a device**
1. Default: **this machine first**. The companion carries a device only when this machine cannot see it, for example because it is out of range.
2. Per device, the rider can choose **"Pixel 8 first"**. A global default with the same two choices sits in Connection settings.
3. **Failover** is on by default and can be switched off. If the carrying route loses the device and the other route sees it, ridrs reconnects over the other route, during a ride too. A cyan info banner shows for 5 s.
4. **No flapping.** A working connection is never moved to the preferred route. Preference only applies when connecting or reconnecting.
5. Failover is always the **same physical device**. ridrs never silently swaps one strap for another.

**A physical constraint.** Most BLE peripherals accept one central and stop advertising while connected. So the other route usually can't see a connected device, and it doesn't need to: failover happens after the link is lost, when the device advertises again, and the remembered route ids recognise it.

## Startup sequence

```text
App launch
 ├─ first run? ─ yes ─► Onboarding: Welcome ► Bluetooth ► Rider ► Setup(first) ─┐
 │               no                                                            │
 ├─ Bluetooth missing? ─► card in Setup: settings · use a companion · continue  │
 └─► Setup: remembered devices reconnect over every route; new ones searched ◄─┘
        ├─ conflict ─► inline pick
        └─ nothing unresolved ─► (3 s when all connected) ─► Main with indicator
Main ─► Start ride ─► Activity ─(hold 1 s)─► Ride saved ─► Main
```

## Pages and menu

| Page | Purpose | Prototype |
|---|---|---|
| Setup | Connect, inline conflict pick, collapse | [setup.html](setup.html) |
| Onboarding 1 to 3 (step 4 is Setup) | First start only, skippable | [1](onboarding-1-welcome.html), [2](onboarding-2-bluetooth.html), [3](onboarding-3-rider.html) |
| Main | Start ride and the device indicator (arrival, badge, open, companion, offline, none) | [main.html](main.html) |
| Device | Per kind: current device, connect via, merged duplicate, other devices, new device, search | [device.html](device.html) |
| Add companion | QR or code (pairing unchanged), then what was merged and what is new | [companion-add.html](companion-add.html) |
| Activity | HUD, lost device, route failover, companion offline, hold to finish | [activity.html](activity.html) |
| Ride saved | Summary and files | [ride-saved.html](ride-saved.html) |
| Menu: Devices, Rider, Connection, Rides, About | | [menu.html](menu.html), [rider](settings-rider.html), [connection](settings-connection.html), [rides](rides.html), [about](about.html) |

## Device indicator

There is one dot per kind (Trainer, Power, Heart rate) and one per paired companion. A small phone icon on a dot means the companion carries that device.

- Green: connected.
- Cyan, pulsing: connecting or searching.
- Amber: missing, or the companion is offline.
- Amber badge: a new device was seen.

Tapping the indicator opens the same rows as Setup.

## Device row states

Not set up, Searching, Connecting, Connected, Reconnecting, Not found, Choose (conflict), Needs Bluetooth, From trainer (power).

Each row also carries **route chips**: "This Mac", "via Pixel 8", "also …" for a merged duplicate, and a dashed border when the route was pinned by the rider.

## Architecture implications (proposal, needs ADRs)

```text
transport-ble-tauri / -noble ─┐ ble.route (multiple)
transport-ble-bridge ─────────┤
                              ▼
                         ble-router ── ble.central (single) ──► device-ftms-trainer, device-heart-rate
                         merge, route choice, failover            (unchanged interface)
                              ▲ device.route-* events
                         device-registry (headless): kinds, conflicts, remembered devices + route ids,
                         preferences (storage.app-files)
                              ▲ events
              ui-devices-setup (screen) · ui-device-indicator (Main slot) · ui-device-page (screen)
```

- **Both transports run at once.** Each provides a new capability `ble.route` (`cardinality: 'multiple'`, which the core already supports) instead of `ble.central`. The route reports its kind (`local` or `companion`) and its label.
- **New `ble-router`** provides the one `ble.central`. It merges the sightings of all routes into **logical peripherals**, connects over the chosen route and fails over. Device plugins keep using `ble.central` and see stable logical ids.
- **New `device-registry`** owns what the rider sees: the kind per device, conflicts, the chosen device per kind, remembered devices with their route ids, and per-device or default route preferences.
- Device plugins **connect to a given id** instead of the first one found, and report candidates.
- **Removed:** `ble.transport-requested`, the transport choice file and its Rust commands, `TRANSPORT_PLUGINS` in `apps/native/src/compose.ts`, and the WebView restart. Migration: a stored `bridge` choice becomes the default "Companion first".
- **Contract additions**, each tied to a use case here:
  - `kind` on `device.connection-changed`
  - `device.discovered`, `device.select-requested`, `device.selection-changed` (including conflicts)
  - `device.route-changed`, `device.route-preference-requested`, `device.split-requested`

  These touch the recording format and replay, so check compatibility first.
- **Determinism:** sightings, route changes and failover enter through `ctx.inputs`; the rider's choices are UI events; logical ids come from `ctx.ids` and are persisted; time comes from `ctx.clock`.
- **ADRs needed:** the router and multi-route model, the duplicate-detection key, the registry persistence format, and the heading font (Exo 2 or Orbitron, OFL, bundled for offline use).

## Roadmap

1. **Registry and contracts (this machine only).** Cucumber first:
   - a remembered device reconnects;
   - a single candidate connects;
   - two straps need a choice, and nothing connects before it;
   - the choice is remembered;
   - a later device shows a badge.
2. **Setup screen, indicator, Device page, Main changes, `initialScreen`.** Update the scenarios that assume the app starts on Main.
3. **Multi-route (companion additive).** Cucumber first on the simulated network:
   - duplicates are merged;
   - local is preferred;
   - "companion first" is honoured;
   - failover keeps the same device;
   - no flapping;
   - a false merge can be split.

   Then `ble.route`, `ble-router`, and removing the transport switch.
4. **Onboarding, Rider and Connection settings.**
5. **Rides list.**

## Still open

- Is "a hint (later)" the badge described here?
- Search timeout per row: 15 s suggested, then "Not found" and a background search.
- How is this machine labelled ("This Mac", or the host name)? Phones have names already.
- Should failover during a ride be on by default? Suggested yes. It changes the source mid-ride, but it is the same device, so the data stays consistent.
- Is a power meter plugin in scope? Until there is one, the power row only says "From trainer".
- Font choice and license check.
