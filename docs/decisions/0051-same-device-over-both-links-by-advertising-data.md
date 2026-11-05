<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0051: The Same Device over Both Links, by Name and Advertising Data

Status: accepted on 2026-11-05 (option 1, chosen by the maintainer) and implemented the same day, for [ADR 0046](0046-one-link-per-device-and-signal-strength.md).

## Context

[ADR 0046](0046-one-link-per-device-and-signal-strength.md) lists a device both links see once per link, each a device of its own. The device details group the two again: one box that names the device once, a line per link. The UI matched the two by name alone, which is weak where several devices share a name ("Wahoo HRM" in a studio).

No id is common to both links: the companion reports the device's address on Android, but macOS never reports a device's address; CoreBluetooth gives every device a UUID of its own on each Mac. Two options were looked at:

1. **Advertising data.** `tauri-plugin-blec` (0.18, `BleDevice.manufacturer_data`, `BleDevice.service_data`) reports it on macOS and Android, noble (`advertisement.manufacturerData`, `advertisement.serviceData`) on the desktop. No connection is needed. Not every device puts something unique there, and some change it with their state (a battery level, a counter).
2. **The serial number of the Device Information Service** (0x2A25): reliable where a device has one, but only readable over a connection, over both links; many trainers allow one or two connections. Of no use for the devices found.

## Decision

- **Option 1.** `BleDiscoveredPeripheral` carries optional `manufacturerData` (the company id as 4 lowercase hex digits → the bytes after it, as lowercase hex) and `serviceData` (the normalized service UUID → the bytes, as lowercase hex). Hex keeps it JSON, so the bridge and recordings carry it as is. blec, noble and the simulator report it.
- **Bridge protocol 1.2: `manufacturerData` and `serviceData` in `discovered`**, in the same version as `rssi` ([ADR 0046](0046-one-link-per-device-and-signal-strength.md)), since neither was released on its own. The companion sends all three only to a ridrs that said 1.2 or later in its `hello`: a ridrs with 1.1 rejects unknown fields (its messages are strict) and still gets its devices.
- **`SharedBleScan`** reports a device again once its advertising data brings a key not reported yet (data, like a name, may only come with a scan response), and once more the first time the bytes of a key change. Further changes are not reported: a device that counts in its advertisements would otherwise become an input many times a second.
- **The peripheral link decides, the UI shows.** The link keeps the advertising data of each device found, the first bytes per key, and marks a key whose bytes changed as changing. Two devices found are the same device when they were found over different links, both have the same, non-empty name, and no key both report has different bytes (keys marked changing on either side are left out). Keys only one side reports, or no data at all, decide nothing: then the name decides, as before. The pair must be unique: when one device matches more than one over the other link, none of them is paired.
- **`DeviceCandidate.sameDeviceAs`**: the id of the device found over the other link that is the same device. The device details group by it, not by name: a pair is one box that names the device once, the current device seen over the other link is a "Switch to" button in its card, next to Remove. Recordings without the field still parse; their devices are not grouped.
- Connecting stays per link ([ADR 0046](0046-one-link-per-device-and-signal-strength.md)): the pairing changes what the setup shows, never which device or link connects.

## Consequences

- Two devices of one name are told apart where their advertising data differs (a serial number or an address in the manufacturer data). Where it does not differ, or a device sends none, they stay paired by name only when there is one of the name on each link; otherwise they are listed apart.
- A device whose data changes between the moments the two links saw it, before either saw the change, is listed apart until one link reports the change.
- Which bytes of a manufacturer's data are an identity is known per manufacturer; reading them by manufacturer stays open until a device needs it.
- The companion and ridrs can be released apart: each speaks to the other in the older protocol's terms.
