// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BlePeripheralLink,
  loadDeviceMemory,
  startBlePeripheralLink,
} from '@ridrs/ble-peripheral';
import {
  type BleDiscoveredPeripheral,
  bleCentralCapability,
  type ControllerButton,
  controllerButtonsChangedEvent,
  definePlugin,
  deviceConnectionChangedEvent,
  type PluginContext,
  ZWIFT_RIDE_CONTROL_POINT_CHARACTERISTIC_UUID,
  ZWIFT_RIDE_NOTIFY_CHARACTERISTIC_UUID,
  ZWIFT_RIDE_SERVICE_UUID,
} from '@ridrs/contracts';
import { parseZwiftRidePacket, RIDE_ON } from './parser.ts';

/** The left and the right controller: two devices with the same name and service. */
const CONTROLLERS_PER_PAIR = 2;

interface ZwiftRideState {
  readonly links: BlePeripheralLink[];
  /** The buttons last published per device, to publish changes only. */
  readonly held: Map<string, readonly ControllerButton[]>;
}

const states = new WeakMap<PluginContext, ZwiftRideState>();

function publishButtons(
  ctx: PluginContext,
  state: ZwiftRideState,
  deviceId: string,
  buttons: readonly ControllerButton[],
): void {
  const previous = state.held.get(deviceId) ?? [];
  if (previous.length === buttons.length && previous.every((b, i) => b === buttons[i])) {
    return;
  }
  state.held.set(deviceId, buttons);
  ctx.events.publish(controllerButtonsChangedEvent, { deviceId, buttons: [...buttons] });
}

function handleNotification(
  ctx: PluginContext,
  state: ZwiftRideState,
  peripheral: BleDiscoveredPeripheral,
  packet: Uint8Array,
): void {
  const parsed = parseZwiftRidePacket(packet);
  if (!parsed.ok) {
    ctx.reportDiagnostic(
      'malformed-packet',
      `Malformed Zwift Ride packet from "${peripheral.name}" (${peripheral.peripheralId}): ${parsed.reason}`,
      { deviceId: peripheral.peripheralId },
    );
    return;
  }
  if (parsed.buttons) {
    publishButtons(ctx, state, peripheral.peripheralId, parsed.buttons);
  }
}

export default definePlugin({
  async start(ctx) {
    // Each link remembers its own controller.
    const memories = await Promise.all(
      Array.from({ length: CONTROLLERS_PER_PAIR }, (_, i) =>
        loadDeviceMemory(ctx, i === 0 ? 'device-controller' : `device-controller-${i + 1}`),
      ),
    );
    const state: ZwiftRideState = { links: [], held: new Map() };
    states.set(ctx, state);

    // Buttons held when the link goes are not held any more; nobody hears them being released.
    ctx.events.subscribe(deviceConnectionChangedEvent, ({ source, payload }) => {
      if (source === ctx.manifest.id && payload.state !== 'connected' && payload.deviceId) {
        publishButtons(ctx, state, payload.deviceId, []);
      }
    });

    // The left controller forwards the right one's buttons, not the other way round: only a
    // link to each hears every button. Each link takes a controller the other has not taken.
    const taken = new Set<string>();
    for (let i = 0; i < CONTROLLERS_PER_PAIR; i += 1) {
      state.links.push(
        startBlePeripheralLink({
          ctx,
          centrals: ctx.capabilities.getAll(bleCentralCapability),
          characteristic: {
            serviceUuid: ZWIFT_RIDE_SERVICE_UUID,
            characteristicUuid: ZWIFT_RIDE_NOTIFY_CHARACTERISTIC_UUID,
          },
          accept: (peripheral) => {
            if (taken.has(peripheral.peripheralId)) {
              return false;
            }
            taken.add(peripheral.peripheralId);
            return true;
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
          memory: memories[i],
          // Each link sees the raw packets of both (they are the plugin's inputs, also on
          // replay): one decodes them, or every packet would count twice.
          onNotification:
            i === 0
              ? (peripheral, packet) => handleNotification(ctx, state, peripheral, packet)
              : () => undefined,
        }),
      );
    }
  },

  async stop(ctx) {
    await Promise.all(states.get(ctx)?.links.map((link) => link.stop()) ?? []);
  },
});
