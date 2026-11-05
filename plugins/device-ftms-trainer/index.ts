// SPDX-License-Identifier: AGPL-3.0-or-later

import { type BlePeripheralLink, startBlePeripheralLink } from '@ridrs/ble-peripheral';
import {
  activityStateChangedEvent,
  type BleCharacteristicTarget,
  type BleDiscoveredPeripheral,
  bleCentralCapability,
  configSnapshotCapability,
  definePlugin,
  deviceConnectionChangedEvent,
  deviceRawReadEvent,
  deviceRawWriteFailedEvent,
  FITNESS_MACHINE_CONTROL_POINT_CHARACTERISTIC_UUID,
  FITNESS_MACHINE_FEATURE_CHARACTERISTIC_UUID,
  FTMS_SERVICE_UUID,
  hexToBytes,
  INDOOR_BIKE_DATA_CHARACTERISTIC_UUID,
  measurementCadenceEvent,
  measurementPowerEvent,
  type PluginContext,
  physicsStateBatchEvent,
  SUPPORTED_POWER_RANGE_CHARACTERISTIC_UUID,
  trainerCommandEvent,
  trainerControlChangedEvent,
  trainerTargetPowerEvent,
} from '@ridrs/contracts';
import { CONTROL_DEFAULTS, FtmsTrainerControl } from './control.ts';
import { encodeCommand } from './control-point.ts';
import { parseFtmsIndoorBikeData } from './parser.ts';

const links = new WeakMap<PluginContext, BlePeripheralLink>();

const CONTROL_POINT: BleCharacteristicTarget = {
  serviceUuid: FTMS_SERVICE_UUID,
  characteristicUuid: FITNESS_MACHINE_CONTROL_POINT_CHARACTERISTIC_UUID,
};

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

/**
 * An FTMS trainer: a sensor of power and cadence, and, when it offers a control point, a trainer
 * ridrs controls (ADR 0056). Everything it decides comes from inputs (the connection, the read
 * Feature, the trainer's answers, the target power) and from the physics' step batches, so a
 * replay decides the same without a trainer.
 */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(configSnapshotCapability, {
      section: ctx.manifest.id,
      snapshot: () => JSON.parse(JSON.stringify(CONTROL_DEFAULTS)),
    });
  },

  start(ctx) {
    const control = new FtmsTrainerControl({
      now: () => ctx.clock.now(),
      send: (device, command) => {
        ctx.events.publish(trainerCommandEvent, { deviceId: device.deviceId, command });
        links.get(ctx)?.write(device, CONTROL_POINT, encodeCommand(command), {
          withResponse: true,
        });
      },
      controlChanged: (payload) => ctx.events.publish(trainerControlChangedEvent, payload),
      failed: (message, details) => ctx.reportDiagnostic('trainer-command-failed', message, details),
      lost: (message, details) => ctx.reportDiagnostic('trainer-control-lost', message, details),
    });

    ctx.events.subscribe(deviceRawReadEvent, ({ source, payload }) => {
      if (source === ctx.manifest.id) {
        control.readResult(
          payload.characteristicUuid,
          payload.data === undefined ? undefined : hexToBytes(payload.data),
        );
      }
    });
    ctx.events.subscribe(deviceConnectionChangedEvent, ({ source, payload }) => {
      if (source !== ctx.manifest.id) {
        return;
      }
      if (payload.state === 'connected') {
        control.connected(
          { deviceId: payload.deviceId, deviceName: payload.deviceName },
          payload.characteristics ?? [],
        );
      } else {
        control.disconnected();
      }
    });
    ctx.events.subscribe(deviceRawWriteFailedEvent, ({ source, payload }) => {
      if (source === ctx.manifest.id) {
        control.writeFailed(hexToBytes(payload.data), payload.reason);
      }
    });
    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      if (payload.state === 'running') {
        control.rideStarted();
      } else if (payload.state === 'finished') {
        control.rideFinished();
      }
    });
    ctx.events.subscribe(trainerTargetPowerEvent, ({ payload }) => {
      control.targetPower(payload.watts);
    });
    // A derived event of the physics, not a physics input: the load the trainer should feel.
    ctx.events.subscribe(physicsStateBatchEvent, ({ payload }) => {
      control.loaded(payload.samples.at(-1)?.trainerLoad);
    });

    links.set(
      ctx,
      startBlePeripheralLink({
        ctx,
        centrals: ctx.capabilities.getAll(bleCentralCapability),
        characteristic: {
          serviceUuid: FTMS_SERVICE_UUID,
          characteristicUuid: INDOOR_BIKE_DATA_CHARACTERISTIC_UUID,
        },
        optionalSubscriptions: [CONTROL_POINT],
        reads: [
          {
            serviceUuid: FTMS_SERVICE_UUID,
            characteristicUuid: FITNESS_MACHINE_FEATURE_CHARACTERISTIC_UUID,
          },
          {
            serviceUuid: FTMS_SERVICE_UUID,
            characteristicUuid: SUPPORTED_POWER_RANGE_CHARACTERISTIC_UUID,
          },
        ],
        label: 'trainer',
        kind: 'trainer',
        onNotification: (peripheral, packet, characteristicUuid) => {
          if (characteristicUuid === FITNESS_MACHINE_CONTROL_POINT_CHARACTERISTIC_UUID) {
            control.response(packet);
          } else {
            handleIndoorBikeData(ctx, peripheral, packet);
          }
        },
      }),
    );
  },

  async stop(ctx) {
    await links.get(ctx)?.stop();
  },
});
