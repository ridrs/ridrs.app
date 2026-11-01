// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BleCentral,
  type BleConnection,
  type BleDiscoveredPeripheral,
  bleCentralCapability,
  type DeviceConnectionState,
  definePlugin,
  deviceConnectionChangedEvent,
  FTMS_SERVICE_UUID,
  INDOOR_BIKE_DATA_CHARACTERISTIC_UUID,
  measurementCadenceEvent,
  measurementPowerEvent,
  normalizeBleUuid,
  type PluginContext,
} from '@ridrs/contracts';
import pRetry from 'p-retry';
import { parseFtmsIndoorBikeData } from './parser.ts';

const RECONNECT_BACKOFF = {
  retries: Number.POSITIVE_INFINITY,
  factor: 2,
  minTimeout: 1000,
  maxTimeout: 30_000,
  randomize: false,
} as const;

interface TrainerSession {
  peripheral?: BleDiscoveredPeripheral;
  connection?: BleConnection;
  teardownConnection?: () => void;
}

const sessions = new WeakMap<PluginContext, TrainerSession>();

function publishState(
  ctx: PluginContext,
  peripheral: BleDiscoveredPeripheral | undefined,
  state: DeviceConnectionState,
): void {
  const deviceId = peripheral?.peripheralId ?? '';
  const deviceName = peripheral?.name ?? '';
  ctx.logger.info({ deviceId, deviceName, state }, `trainer connection state: ${state}`);
  ctx.events.publish(deviceConnectionChangedEvent, { deviceId, deviceName, state });
}

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

async function findTrainer(
  ctx: PluginContext,
  central: BleCentral,
): Promise<BleDiscoveredPeripheral | undefined> {
  for await (const peripheral of central.scan({
    serviceUuids: [FTMS_SERVICE_UUID],
    signal: ctx.signal,
  })) {
    if (peripheral.serviceUuids.some((uuid) => normalizeBleUuid(uuid) === FTMS_SERVICE_UUID)) {
      return peripheral;
    }
  }
  return undefined;
}

async function connectAndSubscribe(
  ctx: PluginContext,
  central: BleCentral,
  session: TrainerSession,
  peripheral: BleDiscoveredPeripheral,
): Promise<void> {
  const connection = await central.connect(peripheral.peripheralId, { signal: ctx.signal });

  try {
    const unsubscribe = await connection.subscribe(
      {
        serviceUuid: FTMS_SERVICE_UUID,
        characteristicUuid: INDOOR_BIKE_DATA_CHARACTERISTIC_UUID,
      },
      (packet) => {
        if (!ctx.signal.aborted) {
          handleIndoorBikeData(ctx, peripheral, packet);
        }
      },
    );
    const stopListening = connection.onDisconnected(() => {
      session.connection = undefined;
      session.teardownConnection = undefined;
      if (!ctx.signal.aborted) {
        publishState(ctx, peripheral, 'reconnecting');
        void reconnect(ctx, central, session, peripheral);
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
  publishState(ctx, peripheral, 'connected');
}

async function reconnect(
  ctx: PluginContext,
  central: BleCentral,
  session: TrainerSession,
  peripheral: BleDiscoveredPeripheral,
): Promise<void> {
  try {
    await pRetry(
      async (attemptNumber) => {
        // Attempt 1 stands for the connection that was just lost, so that the first real
        // reconnection attempt happens after the initial backoff delay.
        if (attemptNumber === 1) {
          throw new Error('connection lost');
        }
        await connectAndSubscribe(ctx, central, session, peripheral);
      },
      { ...RECONNECT_BACKOFF, signal: ctx.signal },
    );
  } catch (error) {
    if (!ctx.signal.aborted) {
      ctx.logger.error({ err: error }, 'trainer reconnection gave up unexpectedly');
    }
  }
}

async function run(ctx: PluginContext, central: BleCentral, session: TrainerSession) {
  publishState(ctx, undefined, 'searching');

  const peripheral = await findTrainer(ctx, central);
  if (!peripheral || ctx.signal.aborted) {
    return;
  }

  session.peripheral = peripheral;
  publishState(ctx, peripheral, 'connecting');

  try {
    await connectAndSubscribe(ctx, central, session, peripheral);
  } catch {
    if (!ctx.signal.aborted) {
      publishState(ctx, peripheral, 'reconnecting');
      await reconnect(ctx, central, session, peripheral);
    }
  }
}

export default definePlugin({
  start(ctx) {
    const central = ctx.capabilities.get(bleCentralCapability);
    const session: TrainerSession = {};
    sessions.set(ctx, session);

    void run(ctx, central, session).catch((error: unknown) => {
      if (!ctx.signal.aborted) {
        ctx.logger.error({ err: error }, 'trainer search failed');
      }
    });
  },

  async stop(ctx) {
    const session = sessions.get(ctx);
    if (!session) {
      return;
    }
    session.teardownConnection?.();
    session.teardownConnection = undefined;
    const connection = session.connection;
    session.connection = undefined;
    await connection?.disconnect();

    publishState(ctx, session.peripheral, 'disconnected');
  },
});
