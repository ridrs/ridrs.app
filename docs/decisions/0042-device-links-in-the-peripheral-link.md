<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0042: Direct and Companion Links at Once, Chosen in the Peripheral Link

This device's Bluetooth (the **direct** link) and the companion bridge run at the same time. `ble.central` changes from `single` to `multiple`: `transport-ble-tauri` (or `transport-ble-noble`) and `transport-ble-bridge` each provide one, and a central names its link with the optional `route` (`local` when absent, `companion` for the bridge). Device plugins pass all of them to `@ridrs/ble-peripheral`'s link, which decides which link carries a device:

- **One device over two links.** The link scans over every central. Two sightings are one device when the service scanned for (the kind) and the advertised name agree. The device keeps the id of its first sighting, so measurements name one device even when it moves to the other link.
- **Every link that sees it, direct data first.** The device connects over every link that sees it (if the device takes several connections), and keeps scanning a link that has not seen it yet. Only the data of one link is used: the direct one, unless the rider chose the companion; the other connection stands by and its notifications are dropped before they become inputs. A device that only the companion saw waits 2 s for the direct link before it connects through the companion.
- **Failover, always on.** When the link in use is lost, the data of the other link is used at once, and the lost link reconnects with backoff. There is no option to switch this off.
- **The first device found connects.** Others of the same kind are listed as candidates in `device.candidates-changed`. While the device setup is open (`device.discovery-requested`), the link keeps scanning, so devices switched on later show up as well.
- **The rider's choices**: `device.connect-requested` (another candidate, or the same device again), `device.disconnect-requested` (the device stays disconnected until connected again) and `device.route-requested` (whose data is used while the device is connected over both links; nothing connects or disconnects).

`device.connection-changed` names the link in use (`route`) and the connected links (`connectedRoutes`); the `device-registry` adds both and the candidates to `device.status-changed`. The UI (`ui-devices`) shows them in a device's details.

**Removed:** the transport switch: `ble.transport-requested`, `BleTransport`, `apps/native/src/transport-choice.ts`, the Rust commands `ble_transport_get` / `ble_transport_set` and the WebView restart. A `ble-transport` file left by earlier builds is ignored.

**Not chosen:** a `ble-router` plugin that provides the one `ble.central` on top of a new `ble.route` capability, as proposed in [docs/ux-draft](../ux-draft/README.md). It separates concerns more cleanly, but every test fixture, the replay's inert central and the device plugins' manifests would change, and there is still only one consumer of the routing: the link. If a second consumer appears, the merging and the route choice can move out of the link without changing the events.

**Not yet:** the choices last for this run only. **Persisting them (the chosen device per kind, the chosen link, a disconnect) is open** until ridrs has a storage design for settings. A device that takes only one connection is carried by one link; the other link keeps retrying it with backoff. Duplicate detection by name merges two identical devices without a serial in their names; splitting them is not offered yet.
