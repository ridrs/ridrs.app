// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BleCentral,
  type BleCharacteristicTarget,
  type BleConnection,
  type BleDiscoveredPeripheral,
  type BleRoute,
  bytesToHex,
  type DeviceConnectionState,
  type DeviceKind,
  deviceCandidatesChangedEvent,
  deviceConnectionChangedEvent,
  deviceConnectRequestedEvent,
  deviceDisconnectRequestedEvent,
  deviceDiscoveryRequestedEvent,
  deviceRawNotificationEvent,
  deviceRouteRequestedEvent,
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

/** The direct link first: the companion carries a device only when this device cannot. */
const ROUTE_ORDER: readonly BleRoute[] = ['local', 'companion'];

/**
 * How long a device that only the companion saw waits for this device's Bluetooth to see it too,
 * before it connects through the companion: the direct link is always preferred.
 */
const DIRECT_LINK_WAIT_MS = 2000;

export interface BlePeripheralLinkOptions {
  readonly ctx: PluginContext;
  /** Every `ble.central`: this device's Bluetooth and the companion, each its own link. */
  readonly centrals: readonly BleCentral[];
  /** The service to scan for and the characteristic to subscribe to. */
  readonly characteristic: BleCharacteristicTarget;
  /** Kind of device for log messages, e.g. "trainer". */
  readonly label: string;
  /** What the device is for; every connection state carries it. */
  readonly kind: DeviceKind;
  /**
   * Whether to take a found device. Several links of one plugin share out devices that look
   * alike this way; a device is taken once this returns true. Every device by default.
   */
  readonly accept?: (peripheral: BleDiscoveredPeripheral) => boolean;
  /**
   * Written once on every connection, after subscribing, for devices that only start notifying
   * when greeted. The connection counts as `connected` only once it is written.
   */
  readonly handshake?: {
    readonly characteristic: BleCharacteristicTarget;
    readonly data: Uint8Array;
  };
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

/**
 * One physical device, seen over one or both links. Its id is the one the first link reported,
 * and it keeps it when it moves to the other link, so measurements name one device throughout.
 */
interface Sighting {
  readonly deviceId: string;
  readonly name: string;
  readonly serviceUuids: readonly string[];
  /** The device's id on each link that saw it. */
  readonly ids: Map<BleRoute, string>;
}

/** What the link is after: the first device found, a device the rider chose, or nothing. */
type Want = 'first' | 'chosen' | 'off';

interface Connected {
  readonly route: BleRoute;
  readonly connection: BleConnection;
  readonly teardown: () => void;
}

function routeOf(central: BleCentral): BleRoute {
  return central.route ?? 'local';
}

function asPeripheral(sighting: Sighting): BleDiscoveredPeripheral {
  return {
    peripheralId: sighting.deviceId,
    name: sighting.name,
    serviceUuids: sighting.serviceUuids,
  };
}

/**
 * The connection lifecycle shared by device plugins: scan for one service over every link,
 * connect to the first device found over every link that sees it (one that only the companion
 * saw waits a moment for this device's Bluetooth), subscribe to one characteristic, reconnect
 * each link with backoff, and publish every state as `device.connection-changed` and every
 * device found as `device.candidates-changed`. Only the data of one link is used: the direct
 * one, unless the rider chose the companion, and the other one while it is lost. The rider can
 * connect another device found, disconnect it, or choose whose data is used; these choices last
 * for this run. Ends when the plugin's abort signal fires.
 */
export function startBlePeripheralLink(options: BlePeripheralLinkOptions): BlePeripheralLink {
  const { ctx, characteristic, label, kind } = options;
  const serviceUuid = normalizeBleUuid(characteristic.serviceUuid);
  const characteristicUuid = normalizeBleUuid(characteristic.characteristicUuid);
  const centrals = new Map<BleRoute, BleCentral>();
  for (const central of options.centrals) {
    centrals.set(routeOf(central), central);
  }

  const sightings: Sighting[] = [];
  const scans = new Map<BleRoute, AbortController>();
  let want: Want = 'first';
  let chosen: Sighting | undefined;
  /** The device's connections, one per link at most. */
  const connections = new Map<BleRoute, Connected>();
  /** The connection attempts in flight, per link. */
  const attempts = new Map<BleRoute, AbortController>();
  /** Whose data is used while the device is connected over both links. */
  let preferred: BleRoute = 'local';
  /** The link whose data was used last; connection states name it. */
  let lastRoute: BleRoute | undefined;
  let state: DeviceConnectionState = 'searching';
  /** Open device setups; while there is one, every link keeps looking for devices. */
  let discovery = 0;
  /** Running while a device only the companion saw waits for the direct link. */
  let directLinkWait: ReturnType<typeof setTimeout> | undefined;

  /** The link whose data is used: the preferred one while connected, else any connected one. */
  const activeRoute = (): BleRoute | undefined =>
    connections.has(preferred) ? preferred : ROUTE_ORDER.find((r) => connections.has(r));

  const publishState = (next: DeviceConnectionState): void => {
    state = next;
    const deviceId = chosen?.deviceId ?? '';
    const deviceName = chosen?.name ?? '';
    const route = activeRoute() ?? lastRoute;
    lastRoute = route;
    const connectedRoutes = ROUTE_ORDER.filter((r) => connections.has(r));
    ctx.logger.info(
      { deviceId, deviceName, state, route, connectedRoutes },
      `${label} connection state: ${state}`,
    );
    // Connection results come from BLE I/O: they enter the simulation as inputs.
    ctx.inputs.accept(deviceConnectionChangedEvent, {
      deviceId,
      deviceName,
      kind,
      state,
      ...(route ? { route } : {}),
      ...(chosen ? { connectedRoutes } : {}),
    });
  };

  const publishCandidates = (): void => {
    ctx.inputs.accept(deviceCandidatesChangedEvent, {
      kind,
      devices: sightings.map((s) => ({
        deviceId: s.deviceId,
        deviceName: s.name,
        routes: ROUTE_ORDER.filter((route) => s.ids.has(route)),
      })),
    });
  };

  /**
   * A link scans while there is no device yet, while the device setup is open, or while it has
   * not seen the device: then it can carry the device too.
   */
  const scanNeeded = (route: BleRoute): boolean => {
    if (ctx.signal.aborted) {
      return false;
    }
    if (discovery > 0) {
      return true;
    }
    return want !== 'off' && !chosen?.ids.has(route);
  };

  const reconcileScans = (): void => {
    for (const [route, central] of centrals) {
      const running = scans.get(route);
      const needed = scanNeeded(route);
      if (needed && !running) {
        startScan(route, central);
      } else if (!needed && running) {
        scans.delete(route);
        running.abort();
      }
    }
  };

  const startScan = (route: BleRoute, central: BleCentral): void => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    ctx.signal.addEventListener('abort', abort, { once: true });
    scans.set(route, controller);
    void (async () => {
      for await (const peripheral of central.scan({
        serviceUuids: [serviceUuid],
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) {
          break;
        }
        // Centrals may report more than asked for: never take another plugin's device.
        if (peripheral.serviceUuids.some((uuid) => normalizeBleUuid(uuid) === serviceUuid)) {
          sighted(route, peripheral);
        }
      }
    })()
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !ctx.signal.aborted) {
          ctx.logger.error({ err: error, route }, `${label} search failed`);
        }
      })
      .finally(() => {
        ctx.signal.removeEventListener('abort', abort);
        if (scans.get(route) === controller) {
          scans.delete(route);
        }
      });
  };

  /**
   * One device seen over one link. The same device over the other link has another id; it is
   * the same device when the kind (the service scanned for) and the advertised name agree.
   */
  const sighted = (route: BleRoute, peripheral: BleDiscoveredPeripheral): void => {
    const known =
      sightings.find((s) => s.ids.get(route) === peripheral.peripheralId) ??
      (peripheral.name
        ? sightings.find((s) => !s.ids.has(route) && s.name === peripheral.name)
        : undefined);
    if (known?.ids.get(route) === peripheral.peripheralId) {
      return;
    }
    if (known) {
      known.ids.set(route, peripheral.peripheralId);
    } else {
      sightings.push({
        deviceId: peripheral.peripheralId,
        name: peripheral.name,
        serviceUuids: peripheral.serviceUuids.map(normalizeBleUuid),
        ids: new Map([[route, peripheral.peripheralId]]),
      });
    }
    publishCandidates();
    if (known && known === chosen) {
      // The device is seen over another link: it connects there too.
      reconcileScans();
      connectAll('first');
    }
    if (want !== 'first' || chosen) {
      return;
    }
    if (route === 'companion' && centrals.has('local')) {
      // The direct link is preferred: it gets a moment to see the device too.
      directLinkWait ??= setTimeout(() => {
        directLinkWait = undefined;
        chooseFirst();
      }, DIRECT_LINK_WAIT_MS);
      return;
    }
    chooseFirst();
  };

  /** Connects the first device found that the plugin takes, the ones seen directly first. */
  const chooseFirst = (): void => {
    if (ctx.signal.aborted || want !== 'first' || chosen) {
      return;
    }
    const seenDirectly = sightings.filter((s) => s.ids.has('local'));
    const waiting = directLinkWait !== undefined;
    const order = waiting ? seenDirectly : [...seenDirectly, ...sightings];
    const first = order.find((s) => options.accept?.(asPeripheral(s)) ?? true);
    if (!first) {
      return;
    }
    clearTimeout(directLinkWait);
    directLinkWait = undefined;
    chosen = first;
    publishState('connecting');
    reconcileScans();
    connectAll('first');
  };

  const connectAndSubscribe = async (
    sighting: Sighting,
    route: BleRoute,
    central: BleCentral,
    id: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const connection = await central.connect(id, { signal });
    let teardown: (() => void) | undefined;

    try {
      const unsubscribe = await connection.subscribe(characteristic, (packet) => {
        // Only the data of the link in use counts; the other link stands by.
        if (!ctx.signal.aborted && activeRoute() === route) {
          // The bytes are an input; they are decoded in the input's turn (below).
          ctx.inputs.accept(deviceRawNotificationEvent, {
            deviceId: sighting.deviceId,
            deviceName: sighting.name,
            serviceUuid,
            characteristicUuid,
            data: bytesToHex(packet),
            receivedAt: ctx.clock.now(),
          });
        }
      });
      const stopListening = connection.onDisconnected(() => {
        const current = connections.get(route);
        if (current?.connection !== connection) {
          return;
        }
        current.teardown();
        connections.delete(route);
        if (!ctx.signal.aborted && want !== 'off') {
          // The data of the other link is used while this one reconnects.
          publishState(connections.size > 0 ? 'connected' : 'reconnecting');
          reconcileScans();
          connectRoute(route, 'lost');
        }
      });
      teardown = () => {
        stopListening();
        unsubscribe();
      };
      if (options.handshake) {
        await connection.write(options.handshake.characteristic, options.handshake.data);
      }
    } catch (error) {
      teardown?.();
      await connection.disconnect().catch(() => undefined);
      throw error;
    }

    if (signal.aborted || ctx.signal.aborted) {
      teardown();
      await connection.disconnect();
      return;
    }
    connections.set(route, { route, connection, teardown });
    publishState('connected');
    reconcileScans();
  };

  /** Connects the chosen device over every link that saw it and does not hold it yet. */
  const connectAll = (why: 'first' | 'rider'): void => {
    for (const route of ROUTE_ORDER) {
      if (chosen?.ids.has(route) && !connections.has(route) && !attempts.has(route)) {
        connectRoute(route, why);
      }
    }
  };

  /**
   * Connects the chosen device over one link, over and over with backoff until it works. After a
   * loss the first real attempt comes after the initial backoff delay.
   */
  const connectRoute = (route: BleRoute, why: 'first' | 'lost' | 'rider'): void => {
    const sighting = chosen;
    const central = centrals.get(route);
    const id = sighting?.ids.get(route);
    if (!sighting || !central || !id) {
      return;
    }
    attempts.get(route)?.abort();
    const controller = new AbortController();
    attempts.set(route, controller);
    const abort = () => controller.abort();
    ctx.signal.addEventListener('abort', abort, { once: true });
    void pRetry(
      async (attemptNumber) => {
        // Attempt 1 stands for the connection that was just lost.
        if (why === 'lost' && attemptNumber === 1) {
          throw new Error('connection lost');
        }
        await connectAndSubscribe(sighting, route, central, id, controller.signal);
      },
      {
        ...RECONNECT_BACKOFF,
        signal: controller.signal,
        onFailedAttempt: () => {
          if (state === 'connecting' && connections.size === 0 && !controller.signal.aborted) {
            publishState('reconnecting');
            reconcileScans();
          }
        },
      },
    )
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          ctx.logger.error({ err: error, route }, `${label} reconnection gave up unexpectedly`);
        }
      })
      .finally(() => {
        ctx.signal.removeEventListener('abort', abort);
        if (attempts.get(route) === controller) {
          attempts.delete(route);
        }
      });
  };

  /** Ends every connection the link holds and the attempts in flight. */
  const release = async (): Promise<void> => {
    for (const controller of attempts.values()) {
      controller.abort();
    }
    attempts.clear();
    const current = [...connections.values()];
    connections.clear();
    for (const { teardown } of current) {
      teardown();
    }
    await Promise.all(
      current.map(({ connection }) => connection.disconnect().catch(() => undefined)),
    );
  };

  const connectRequested = (deviceId: string): void => {
    const sighting = sightings.find((s) => s.deviceId === deviceId);
    if (!sighting) {
      return;
    }
    // Several links of one plugin share out the devices: a device another one holds stays there.
    if (sighting !== chosen && !(options.accept?.(asPeripheral(sighting)) ?? true)) {
      return;
    }
    const same = sighting === chosen && connections.size > 0;
    want = 'chosen';
    if (same) {
      return;
    }
    if (sighting !== chosen) {
      preferred = 'local';
    }
    void release().then(() => {
      if (ctx.signal.aborted) {
        return;
      }
      chosen = sighting;
      publishState('connecting');
      reconcileScans();
      connectAll('rider');
    });
  };

  /** Only changes whose data is used: nothing connects or disconnects. */
  const routeRequested = (route: BleRoute): void => {
    preferred = route;
    if (connections.has(route)) {
      publishState(state);
    }
  };

  const disconnectRequested = (): void => {
    want = 'off';
    void release().then(() => {
      if (!ctx.signal.aborted) {
        publishState('disconnected');
        reconcileScans();
      }
    });
  };

  // The rider's requests and the open device setups are UI events.
  ctx.events.subscribe(deviceConnectRequestedEvent, ({ payload }) => {
    if (payload.kind === kind) {
      connectRequested(payload.deviceId);
    }
  });
  ctx.events.subscribe(deviceRouteRequestedEvent, ({ payload }) => {
    if (payload.kind === kind) {
      routeRequested(payload.route);
    }
  });
  ctx.events.subscribe(deviceDisconnectRequestedEvent, ({ payload }) => {
    if (payload.kind === kind) {
      disconnectRequested();
    }
  });
  ctx.events.subscribe(deviceDiscoveryRequestedEvent, ({ payload }) => {
    discovery = Math.max(0, discovery + (payload.active ? 1 : -1));
    reconcileScans();
  });

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

  publishState('searching');
  reconcileScans();

  return {
    async stop(): Promise<void> {
      clearTimeout(directLinkWait);
      directLinkWait = undefined;
      for (const scan of scans.values()) {
        scan.abort();
      }
      scans.clear();
      await release();
      publishState('disconnected');
    },
  };
}
