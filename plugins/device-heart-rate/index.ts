// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BleDiscoveredPeripheral,
  bleCentralCapability,
  definePlugin,
  HEART_RATE_MEASUREMENT_CHARACTERISTIC_UUID,
  HEART_RATE_SERVICE_UUID,
  measurementHeartRateEvent,
  type PluginContext,
} from '@ridrs/contracts';
import { type BlePeripheralLink, startBlePeripheralLink } from '@ridrs/ble-peripheral';
import { parseHeartRateMeasurement } from './parser.ts';

const links = new WeakMap<PluginContext, BlePeripheralLink>();

function handleHeartRateMeasurement(
  ctx: PluginContext,
  peripheral: BleDiscoveredPeripheral,
  packet: Uint8Array,
): void {
  const receivedAt = ctx.clock.now();
  const parsed = parseHeartRateMeasurement(packet);

  if (!parsed.ok) {
    ctx.reportDiagnostic(
      'malformed-packet',
      `Malformed Heart Rate Measurement packet from "${peripheral.name}" (${peripheral.peripheralId}): ${parsed.reason}`,
      { deviceId: peripheral.peripheralId },
    );
    return;
  }
  if (parsed.heartRateBpm === undefined) {
    return;
  }

  // Heart Rate Measurements carry no timestamp: receive time is the only honest time we have.
  ctx.events.publish(measurementHeartRateEvent, {
    deviceId: peripheral.peripheralId,
    value: parsed.heartRateBpm,
    measuredAt: receivedAt,
    receivedAt,
    timestampOrigin: 'receive',
  });
}

export default definePlugin({
  start(ctx) {
    links.set(
      ctx,
      startBlePeripheralLink({
        ctx,
        central: ctx.capabilities.get(bleCentralCapability),
        characteristic: {
          serviceUuid: HEART_RATE_SERVICE_UUID,
          characteristicUuid: HEART_RATE_MEASUREMENT_CHARACTERISTIC_UUID,
        },
        label: 'heart-rate sensor',
        onNotification: (peripheral, packet) =>
          handleHeartRateMeasurement(ctx, peripheral, packet),
      }),
    );
  },

  async stop(ctx) {
    await links.get(ctx)?.stop();
  },
});
