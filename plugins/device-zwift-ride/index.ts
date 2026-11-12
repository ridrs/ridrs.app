// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BlePartsLink,
  type DevicePartOf,
  loadDevicePartsMemory,
  startBlePartsLink,
} from '@ridrs/ble-peripheral';
import {
  type BleDiscoveredPeripheral,
  bleCentralCapability,
  type ControllerButton,
  controllerButtonSchema,
  controllerButtonsChangedEvent,
  type DevicePart,
  definePlugin,
  deviceConnectionChangedEvent,
  type PluginContext,
  ZWIFT_MANUFACTURER_ID,
  ZWIFT_RIDE_CONTROL_POINT_CHARACTERISTIC_UUID,
  ZWIFT_RIDE_LEFT,
  ZWIFT_RIDE_NOTIFY_CHARACTERISTIC_UUID,
  ZWIFT_RIDE_RIGHT,
  ZWIFT_RIDE_SERVICE_UUID,
} from '@ridrs/contracts';
import { parseZwiftRidePacket, RIDE_ON } from './parser.ts';

interface ZwiftRideState {
  link?: BlePartsLink;
  /** The buttons each controller of a pair holds down, by the pair and the controller's id. */
  readonly held: Map<string, Map<string, readonly ControllerButton[]>>;
  /** The buttons last published per pair, to publish changes only. */
  readonly published: Map<string, readonly ControllerButton[]>;
}

const states = new WeakMap<PluginContext, ZwiftRideState>();

/**
 * Which controller of the pair a device found is: the first byte of Zwift's manufacturer data is
 * its device type (ADR 0089). A device that does not say is either.
 */
function sideOf(peripheral: BleDiscoveredPeripheral): DevicePart | undefined {
  const type = Number.parseInt(peripheral.manufacturerData?.[ZWIFT_MANUFACTURER_ID]?.slice(0, 2) ?? '', 16);
  return type === ZWIFT_RIDE_LEFT ? 'left' : type === ZWIFT_RIDE_RIGHT ? 'right' : undefined;
}

/**
 * Publishes what the pair holds down: the buttons held on either controller, in the order of the
 * contract. The left controller forwards the right one's buttons too: a button held on both
 * counts once.
 */
function publishButtons(ctx: PluginContext, state: ZwiftRideState, deviceId: string): void {
  const held = new Set([...(state.held.get(deviceId)?.values() ?? [])].flat());
  const buttons = controllerButtonSchema.options.filter((b) => held.has(b));
  const previous = state.published.get(deviceId) ?? [];
  if (previous.length === buttons.length && previous.every((b, i) => b === buttons[i])) {
    return;
  }
  state.published.set(deviceId, buttons);
  ctx.events.publish(controllerButtonsChangedEvent, { deviceId, buttons });
}

function handleNotification(
  ctx: PluginContext,
  state: ZwiftRideState,
  device: DevicePartOf,
  packet: Uint8Array,
): void {
  const parsed = parseZwiftRidePacket(packet);
  if (!parsed.ok) {
    ctx.reportDiagnostic(
      'malformed-packet',
      `Malformed Zwift Ride packet from "${device.name}" (${device.partId}): ${parsed.reason}`,
      { deviceId: device.partId },
    );
    return;
  }
  if (parsed.buttons) {
    const pair = state.held.get(device.deviceId) ?? new Map();
    pair.set(device.partId, parsed.buttons);
    state.held.set(device.deviceId, pair);
    publishButtons(ctx, state, device.deviceId);
  }
}

export default definePlugin({
  async start(ctx) {
    // One entry for the pair; the entries of the two links from before the pair are merged once.
    const memory = await loadDevicePartsMemory(ctx, 'device-controller', ['device-controller-2']);
    const state: ZwiftRideState = { held: new Map(), published: new Map() };
    states.set(ctx, state);

    // Buttons held when the pair is not connected any more are not held any more: nobody hears
    // them being released. The controller still there tells its buttons again.
    ctx.events.subscribe(deviceConnectionChangedEvent, ({ source, payload }) => {
      if (source === ctx.manifest.id && payload.state !== 'connected' && payload.deviceId) {
        state.held.delete(payload.deviceId);
        publishButtons(ctx, state, payload.deviceId);
      }
    });

    // The pair is one device of two controllers: the left one forwards the right one's buttons,
    // not the other way round, so both are connected.
    state.link = startBlePartsLink({
      ctx,
      centrals: ctx.capabilities.getAll(bleCentralCapability),
      characteristic: {
        serviceUuid: ZWIFT_RIDE_SERVICE_UUID,
        characteristicUuid: ZWIFT_RIDE_NOTIFY_CHARACTERISTIC_UUID,
      },
      handshake: {
        characteristic: {
          serviceUuid: ZWIFT_RIDE_SERVICE_UUID,
          characteristicUuid: ZWIFT_RIDE_CONTROL_POINT_CHARACTERISTIC_UUID,
        },
        data: RIDE_ON,
      },
      label: 'Zwift Ride controller',
      kind: 'controller',
      parts: ['left', 'right'],
      partOf: sideOf,
      memory,
      // The raw packets are the plugin's inputs, also on replay: decoded once per packet.
      onNotification: (device, packet) => handleNotification(ctx, state, device, packet),
    });
  },

  async stop(ctx) {
    await states.get(ctx)?.link?.stop();
  },
});
