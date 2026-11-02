// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BleDiscoveredPeripheral,
  bleCentralCapability,
  definePlugin,
  FTMS_SERVICE_UUID,
  INDOOR_BIKE_DATA_CHARACTERISTIC_UUID,
  measurementCadenceEvent,
  measurementPowerEvent,
  type PluginContext,
} from '@ridrs/contracts';
import { type BlePeripheralLink, startBlePeripheralLink } from '@ridrs/ble-peripheral';
import { parseFtmsIndoorBikeData } from './parser.ts';

const links = new WeakMap<PluginContext, BlePeripheralLink>();

function handleIndoorBikeData(
  ctx: PluginContext,
  peripheral: BleDiscoveredPeripheral,
  packet: Uint8Array,
): void {
  const receivedAt = ctx.clock.now();
  const parsed = parseFtmsIndoorBikeData(packet);

  if (!parsed.ok) {
    ctx.reportDiagnostic(
      'malformed-packet',
      `Malformed FTMS Indoor Bike Data packet from "${peripheral.name}" (${peripheral.peripheralId}): ${parsed.reason}`,
      { deviceId: peripheral.peripheralId },
    );
    return;
  }

  // FTMS packets carry no measurement timestamp: receive time is the only honest time we have.
  const stamp = {
    deviceId: peripheral.peripheralId,
    measuredAt: receivedAt,
    receivedAt,
    timestampOrigin: 'receive',
  } as const;

  if (parsed.data.powerWatts !== undefined) {
    ctx.events.publish(measurementPowerEvent, { ...stamp, value: parsed.data.powerWatts });
  }
  if (parsed.data.cadenceRpm !== undefined) {
    ctx.events.publish(measurementCadenceEvent, { ...stamp, value: parsed.data.cadenceRpm });
  }
}

export default definePlugin({
  start(ctx) {
    links.set(
      ctx,
      startBlePeripheralLink({
        ctx,
        central: ctx.capabilities.get(bleCentralCapability),
        characteristic: {
          serviceUuid: FTMS_SERVICE_UUID,
          characteristicUuid: INDOOR_BIKE_DATA_CHARACTERISTIC_UUID,
        },
        label: 'trainer',
        onNotification: (peripheral, packet) => handleIndoorBikeData(ctx, peripheral, packet),
      }),
    );
  },

  async stop(ctx) {
    await links.get(ctx)?.stop();
  },
});
