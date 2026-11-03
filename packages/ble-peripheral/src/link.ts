// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BleCentral,
  type BleCharacteristicTarget,
  type BleConnection,
  type BleDiscoveredPeripheral,
  bytesToHex,
  type DeviceConnectionState,
  deviceConnectionChangedEvent,
  deviceRawNotificationEvent,
  hexToBytes,
  normalizeBleUuid,
  type PluginContext,
} from '@ridrs/contracts';
import pRetry from 'p-retry';

const RECONNECT_BACKOFF = {
  retries: Number.POSITIVE_INFINITY,
  factor: 2,
  minTimeout: 1000,
  maxTimeout: 30_000,
  randomize: false,
} as const;

export interface BlePeripheralLinkOptions {
  readonly ctx: PluginContext;
  readonly central: BleCentral;
  /** The service to scan for and the characteristic to subscribe to. */
  readonly characteristic: BleCharacteristicTarget;
  /** Kind of device for log messages, e.g. "trainer". */
  readonly label: string;
  /**
   * Raw notification bytes; decoding stays with the device plugin. Every packet is published as
   * `device.raw-notification` first, malformed ones too.
   */
  readonly onNotification: (peripheral: BleDiscoveredPeripheral, packet: Uint8Array) => void;
}

export interface BlePeripheralLink {
  /** Unsubscribes, disconnects and publishes `disconnected`. */
  stop(): Promise<void>;
}

interface LinkSession {
  peripheral?: BleDiscoveredPeripheral;
  connection?: BleConnection;
  teardownConnection?: () => void;
}

/**
 * The connection lifecycle shared by device plugins: scan for one service, connect to the first
 * device found, subscribe to one characteristic, reconnect with backoff, and publish every state
 * as `device.connection-changed`. Ends when the plugin's abort signal fires.
 */
export function startBlePeripheralLink(options: BlePeripheralLinkOptions): BlePeripheralLink {
  const { ctx, central, characteristic, label } = options;
  const serviceUuid = normalizeBleUuid(characteristic.serviceUuid);
  const characteristicUuid = normalizeBleUuid(characteristic.characteristicUuid);
  const session: LinkSession = {};

  const publishState = (
    peripheral: BleDiscoveredPeripheral | undefined,
    state: DeviceConnectionState,
  ): void => {
    const deviceId = peripheral?.peripheralId ?? '';
    const deviceName = peripheral?.name ?? '';
    ctx.logger.info({ deviceId, deviceName, state }, `${label} connection state: ${state}`);
    // Connection results come from BLE I/O: they enter the simulation as inputs.
    ctx.inputs.accept(deviceConnectionChangedEvent, { deviceId, deviceName, state });
  };

  const findPeripheral = async (): Promise<BleDiscoveredPeripheral | undefined> => {
    for await (const peripheral of central.scan({
      serviceUuids: [serviceUuid],
      signal: ctx.signal,
    })) {
      // Centrals may report more than asked for: never take another plugin's device.
      if (peripheral.serviceUuids.some((uuid) => normalizeBleUuid(uuid) === serviceUuid)) {
        return peripheral;
      }
    }
    return undefined;
  };

  const connectAndSubscribe = async (peripheral: BleDiscoveredPeripheral): Promise<void> => {
    const connection = await central.connect(peripheral.peripheralId, { signal: ctx.signal });

    try {
      const unsubscribe = await connection.subscribe(characteristic, (packet) => {
        if (!ctx.signal.aborted) {
          // The bytes are an input; they are decoded in the input's turn (below).
          ctx.inputs.accept(deviceRawNotificationEvent, {
            deviceId: peripheral.peripheralId,
            deviceName: peripheral.name,
            serviceUuid,
            characteristicUuid,
            data: bytesToHex(packet),
            receivedAt: ctx.clock.now(),
          });
        }
      });
      const stopListening = connection.onDisconnected(() => {
        session.connection = undefined;
        session.teardownConnection = undefined;
        if (!ctx.signal.aborted) {
          publishState(peripheral, 'reconnecting');
          void reconnect(peripheral);
        }
      });
      session.connection = connection;
      session.teardownConnection = () => {
        stopListening();
        unsubscribe();
      };
    } catch (error) {
      await connection.disconnect().catch(() => undefined);
      throw error;
    }

    if (ctx.signal.aborted) {
      session.teardownConnection?.();
      session.teardownConnection = undefined;
      session.connection = undefined;
      await connection.disconnect();
      return;
    }
    publishState(peripheral, 'connected');
  };

  const reconnect = async (peripheral: BleDiscoveredPeripheral): Promise<void> => {
    try {
      await pRetry(
        async (attemptNumber) => {
          // Attempt 1 stands for the connection that was just lost, so that the first real
          // reconnection attempt happens after the initial backoff delay.
          if (attemptNumber === 1) {
            throw new Error('connection lost');
          }
          await connectAndSubscribe(peripheral);
        },
        { ...RECONNECT_BACKOFF, signal: ctx.signal },
      );
    } catch (error) {
      if (!ctx.signal.aborted) {
        ctx.logger.error({ err: error }, `${label} reconnection gave up unexpectedly`);
      }
    }
  };

  const run = async (): Promise<void> => {
    publishState(undefined, 'searching');

    const peripheral = await findPeripheral();
    if (!peripheral || ctx.signal.aborted) {
      return;
    }

    session.peripheral = peripheral;
    publishState(peripheral, 'connecting');

    try {
      await connectAndSubscribe(peripheral);
    } catch {
      if (!ctx.signal.aborted) {
        publishState(peripheral, 'reconnecting');
        await reconnect(peripheral);
      }
    }
  };

  // Decoding runs in the turn of the raw input, live and on replay alike: a replay injects the
  // recorded raw inputs with this plugin as their source.
  ctx.events.subscribe(deviceRawNotificationEvent, ({ source, payload }) => {
    if (source !== ctx.manifest.id || payload.characteristicUuid !== characteristicUuid) {
      return;
    }
    options.onNotification(
      {
        peripheralId: payload.deviceId,
        name: payload.deviceName,
        serviceUuids: [payload.serviceUuid],
      },
      hexToBytes(payload.data),
    );
  });

  void run().catch((error: unknown) => {
    if (!ctx.signal.aborted) {
      ctx.logger.error({ err: error }, `${label} search failed`);
    }
  });

  return {
    async stop(): Promise<void> {
      session.teardownConnection?.();
      session.teardownConnection = undefined;
      const connection = session.connection;
      session.connection = undefined;
      await connection?.disconnect();

      publishState(session.peripheral, 'disconnected');
    },
  };
}
