// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BleCentral,
  type BleCharacteristicTarget,
  type BleConnection,
  type BleDiscoveredPeripheral,
  type BleRoute,
  type BleWriteOptions,
  bytesToHex,
  type DeviceConnectionState,
  type DeviceKind,
  deviceCandidatesChangedEvent,
  deviceConnectionChangedEvent,
  deviceConnectRequestedEvent,
  deviceDiscoveryRequestedEvent,
  deviceForgetRequestedEvent,
  deviceRawNotificationEvent,
  deviceRawReadEvent,
  deviceRawWriteEvent,
  deviceRawWriteFailedEvent,
  deviceScanChangedEvent,
  hexToBytes,
  normalizeBleUuid,
  type PluginContext,
} from '@ridrs/contracts';
import pRetry from 'p-retry';
import {
  type Advertised,
  advertisedAfter,
  advertisedApart,
  advertisesNews,
} from './advertising.ts';

const RECONNECT_BACKOFF = {
  retries: Number.POSITIVE_INFINITY,
  factor: 2,
  minTimeout: 1000,
  maxTimeout: 30_000,
  randomize: false,
} as const;

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
   * Characteristics a device may not have (a control point), subscribed on every connection
   * after the main one; a failed one is left out. Their notifications and indications are raw
   * notifications like the main one's; `connected` names the ones subscribed (`characteristics`).
   */
  readonly optionalSubscriptions?: readonly BleCharacteristicTarget[];
  /**
   * Read on every connection before it counts as `connected`; each result, a failure too, enters
   * as a `device.raw-read` input.
   */
  readonly reads?: readonly BleCharacteristicTarget[];
  /**
   * Raw notification bytes; decoding stays with the device plugin. Every packet is published as
   * `device.raw-notification` first, malformed ones too.
   */
  readonly onNotification: (
    peripheral: BleDiscoveredPeripheral,
    packet: Uint8Array,
    characteristicUuid: string,
  ) => void;
}

export interface BlePeripheralLink {
  /**
   * Writes to the connected device, in a turn: publishes `device.raw-write` at once, then writes
   * when a connection is there (a replay has none). A failed write enters as a
   * `device.raw-write-failed` input.
   */
  write(
    device: { readonly deviceId: string; readonly deviceName: string },
    target: BleCharacteristicTarget,
    data: Uint8Array,
    options?: BleWriteOptions,
  ): void;
  /** Unsubscribes, disconnects and publishes `disconnected`. */
  stop(): Promise<void>;
}

/**
 * A device seen over one link. A device both links see is two devices, one per link: the rider
 * switches links by connecting the other one.
 */
interface Sighting {
  /** The id the device is known by in ridrs: the link's own id, unless the other link has it. */
  readonly deviceId: string;
  readonly route: BleRoute;
  /** The device's id on its link. */
  readonly peripheralId: string;
  /** Empty until the link reports it: some devices only send it in a scan response. */
  name: string;
  readonly serviceUuids: readonly string[];
  /** The signal strength the link last reported, in dBm. */
  rssi: number | undefined;
  /** Its advertising data as the link reported it: tells devices of one name apart. */
  advertised: Advertised;
}

/**
 * What the link is after: the first device found, a device the rider chose, or none on its own
 * since the rider forgot the device, until a device setup opens again.
 */
type Want = 'first' | 'chosen' | 'none';

interface Connected {
  readonly route: BleRoute;
  readonly connection: BleConnection;
  readonly teardown: () => void;
}

/** A connection attempt in flight: over which link, and how to call it off. */
interface Attempt {
  readonly route: BleRoute;
  readonly controller: AbortController;
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
 * connect to the first device found (one seen directly first, then the strongest signal; a device
 * the companion saw waits a moment for this device's Bluetooth), subscribe to one characteristic,
 * reconnect over the same link with backoff, and publish every state as
 * `device.connection-changed` and every device found, one per link that sees it, as
 * `device.candidates-changed`. The rider can connect another device found, the same one over the
 * other link too, or forget it: then no device connects on its own until a device setup opens
 * again. These choices last for this run. Ends when the plugin's abort signal fires.
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
  let connected: Connected | undefined;
  let attempt: Attempt | undefined;
  /** The link that carried the device last; connection states name it. */
  let lastRoute: BleRoute | undefined;
  /** The state published last; published again when the device's name arrives. */
  let lastState: DeviceConnectionState = 'searching';
  /** Open device setups; while there is one, every link keeps looking for devices. */
  let discovery = 0;
  /** Devices the plugin took: it takes each once, so a forgotten one can come back. */
  const taken = new Set<Sighting>();
  /** Running while a device only the companion saw waits for the direct link. */
  let directLinkWait: ReturnType<typeof setTimeout> | undefined;

  const takes = (sighting: Sighting): boolean => {
    if (!taken.has(sighting) && (options.accept?.(asPeripheral(sighting)) ?? true)) {
      taken.add(sighting);
    }
    return taken.has(sighting);
  };

  const publishState = (
    state: DeviceConnectionState,
    characteristics?: readonly string[],
  ): void => {
    const deviceId = chosen?.deviceId ?? '';
    const deviceName = chosen?.name ?? '';
    const route = connected?.route ?? attempt?.route ?? lastRoute;
    lastRoute = route;
    lastState = state;
    ctx.logger.info({ deviceId, deviceName, state, route }, `${label} connection state: ${state}`);
    // Connection results come from BLE I/O: they enter the simulation as inputs.
    ctx.inputs.accept(deviceConnectionChangedEvent, {
      deviceId,
      deviceName,
      kind,
      state,
      ...(route ? { route } : {}),
      ...(characteristics ? { characteristics: [...characteristics] } : {}),
    });
  };

  /** The same device over the other link: same name, nothing in their data tells them apart. */
  const alike = (a: Sighting, b: Sighting): boolean =>
    a.route !== b.route &&
    a.name !== '' &&
    a.name === b.name &&
    !advertisedApart(a.advertised, b.advertised);

  /** The one device over the other link that is this one, when it is the only one either way. */
  const twinOf = (sighting: Sighting): Sighting | undefined => {
    const [twin, ...more] = sightings.filter((o) => alike(sighting, o));
    if (!twin || more.length > 0) {
      return undefined;
    }
    return sightings.filter((o) => alike(twin, o)).length === 1 ? twin : undefined;
  };

  const publishCandidates = (): void => {
    ctx.inputs.accept(deviceCandidatesChangedEvent, {
      kind,
      devices: sightings.map((s) => {
        const twin = twinOf(s);
        return {
          deviceId: s.deviceId,
          deviceName: s.name,
          routes: [s.route],
          ...(s.rssi === undefined ? {} : { rssi: s.rssi }),
          ...(twin ? { sameDeviceAs: twin.deviceId } : {}),
        };
      }),
    });
  };

  /** The links named as scanning last; published again only when they change. */
  let scanning = '';

  /** The links that scan now: a scan ended or failed is no longer one of them. */
  const publishScans = (): void => {
    const routes = [...scans.keys()];
    if (routes.join() === scanning) {
      return;
    }
    scanning = routes.join();
    // Whether a scan runs depends on BLE I/O: it enters the simulation as an input.
    ctx.inputs.accept(deviceScanChangedEvent, { kind, routes });
  };

  /**
   * Every link scans while a device setup is open, or while there is no device yet and the rider
   * did not forget the device.
   */
  const scanNeeded = (): boolean =>
    !ctx.signal.aborted && (discovery > 0 || (!chosen && want !== 'none'));

  const reconcileScans = (): void => {
    for (const [route, central] of centrals) {
      const running = scans.get(route);
      const needed = scanNeeded();
      if (needed && !running) {
        startScan(route, central);
      } else if (!needed && running) {
        scans.delete(route);
        running.abort();
      }
    }
    publishScans();
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
          if (!ctx.signal.aborted) {
            publishScans();
          }
        }
      });
  };

  /** One device seen over one link; over the other link, the same device is another one. */
  const sighted = (route: BleRoute, peripheral: BleDiscoveredPeripheral): void => {
    const known = sightings.find(
      (s) => s.route === route && s.peripheralId === peripheral.peripheralId,
    );
    if (known) {
      // Seen again: only its name, when it had none yet, and its signal can be news.
      let news = false;
      if (!known.name && peripheral.name) {
        named(known, peripheral.name);
        news = true;
      }
      if (peripheral.rssi !== undefined && known.rssi !== peripheral.rssi) {
        known.rssi = peripheral.rssi;
        news = true;
      }
      if (advertisesNews(known.advertised, peripheral)) {
        known.advertised = advertisedAfter(known.advertised, peripheral);
        news = true;
      }
      if (news) {
        publishCandidates();
      }
      return;
    }
    // Requests name a device by id alone: one the other link uses already takes the link's name.
    const idTaken = sightings.some((s) => s.deviceId === peripheral.peripheralId);
    sightings.push({
      deviceId: idTaken ? `${route}:${peripheral.peripheralId}` : peripheral.peripheralId,
      route,
      peripheralId: peripheral.peripheralId,
      name: peripheral.name,
      serviceUuids: peripheral.serviceUuids.map(normalizeBleUuid),
      rssi: peripheral.rssi,
      advertised: advertisedAfter(undefined, peripheral),
    });
    publishCandidates();
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

  /** A device seen without its name took it. */
  const named = (sighting: Sighting, name: string): void => {
    sighting.name = name;
    if (sighting === chosen) {
      // The connection states carry the name.
      publishState(lastState);
    }
  };

  /**
   * Connects the best device found that the plugin takes: the ones seen directly first, then the
   * strongest signal, then the first found.
   */
  const chooseFirst = (): void => {
    if (ctx.signal.aborted || want !== 'first' || chosen) {
      return;
    }
    const waiting = directLinkWait !== undefined;
    const order = sightings
      .filter((s) => !waiting || s.route === 'local')
      .toSorted(
        (a, b) =>
          Number(b.route === 'local') - Number(a.route === 'local') ||
          (b.rssi ?? Number.NEGATIVE_INFINITY) - (a.rssi ?? Number.NEGATIVE_INFINITY),
      );
    const first = order.find(takes);
    if (!first) {
      return;
    }
    clearTimeout(directLinkWait);
    directLinkWait = undefined;
    chosen = first;
    connect('first');
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
    const subscribed: string[] = [];

    try {
      const raw =
        (target: BleCharacteristicTarget) =>
        (packet: Uint8Array): void => {
          if (!ctx.signal.aborted && connected?.connection === connection) {
            // The bytes are an input; they are decoded in the input's turn (below).
            ctx.inputs.accept(deviceRawNotificationEvent, {
              deviceId: sighting.deviceId,
              deviceName: sighting.name,
              serviceUuid: normalizeBleUuid(target.serviceUuid),
              characteristicUuid: normalizeBleUuid(target.characteristicUuid),
              data: bytesToHex(packet),
              receivedAt: ctx.clock.now(),
            });
          }
        };
      const unsubscribes = [await connection.subscribe(characteristic, raw(characteristic))];
      const stopListening = connection.onDisconnected(() => {
        if (connected?.connection !== connection) {
          return;
        }
        connected.teardown();
        connected = undefined;
        if (!ctx.signal.aborted) {
          // Lost: the same link tries again; ridrs never switches links on its own.
          connect('lost');
        }
      });
      teardown = () => {
        stopListening();
        for (const unsubscribe of unsubscribes) {
          unsubscribe();
        }
      };
      for (const target of options.optionalSubscriptions ?? []) {
        try {
          unsubscribes.push(await connection.subscribe(target, raw(target)));
          subscribed.push(normalizeBleUuid(target.characteristicUuid));
        } catch (error) {
          ctx.logger.info(
            { err: error, characteristic: target.characteristicUuid },
            `${label} has no ${target.characteristicUuid}`,
          );
        }
      }
      for (const target of options.reads ?? []) {
        // Read results come from BLE I/O: they enter the simulation as inputs.
        const result = await connection.read(target).then(
          (data) => ({ data: bytesToHex(data) }),
          (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
        );
        ctx.inputs.accept(deviceRawReadEvent, {
          deviceId: sighting.deviceId,
          deviceName: sighting.name,
          serviceUuid: normalizeBleUuid(target.serviceUuid),
          characteristicUuid: normalizeBleUuid(target.characteristicUuid),
          ...result,
          receivedAt: ctx.clock.now(),
        });
      }
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
    connected = { route, connection, teardown };
    publishState('connected', options.optionalSubscriptions ? subscribed : undefined);
    reconcileScans();
  };

  /**
   * Connects the chosen device over its link, over and over with backoff until it works. After a
   * loss the first real attempt comes after the initial backoff delay.
   */
  const connect = (why: 'first' | 'lost' | 'rider'): void => {
    const sighting = chosen;
    const route = sighting?.route;
    const central = route && centrals.get(route);
    if (!sighting || !route || !central) {
      return;
    }
    const id = sighting.peripheralId;
    attempt?.controller.abort();
    const controller = new AbortController();
    const current: Attempt = { route, controller };
    attempt = current;
    publishState(why === 'lost' ? 'reconnecting' : 'connecting');
    reconcileScans();
    const abort = () => controller.abort();
    ctx.signal.addEventListener('abort', abort, { once: true });
    let failed = false;
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
          if (!failed && why !== 'lost' && !controller.signal.aborted) {
            failed = true;
            publishState('reconnecting');
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
        if (attempt === current) {
          attempt = undefined;
        }
      });
  };

  /** Ends the connection the link holds and the attempt in flight. */
  const release = async (): Promise<void> => {
    attempt?.controller.abort();
    attempt = undefined;
    const current = connected;
    connected = undefined;
    if (current) {
      current.teardown();
      await current.connection.disconnect().catch(() => undefined);
    }
  };

  const connectRequested = (deviceId: string): void => {
    const sighting = sightings.find((s) => s.deviceId === deviceId);
    // Several links of one plugin share out the devices: a device another one holds stays there.
    if (!sighting || !takes(sighting)) {
      return;
    }
    want = 'chosen';
    if (sighting === chosen && (connected || attempt)) {
      return;
    }
    void release().then(() => {
      if (ctx.signal.aborted) {
        return;
      }
      chosen = sighting;
      connect('rider');
    });
  };

  /** Lets the device go: no device connects on its own until a device setup opens again. */
  const forgetRequested = (): void => {
    if (!chosen) {
      return;
    }
    want = 'none';
    chosen = undefined;
    void release().then(() => {
      // The rider may have connected a device meanwhile.
      if (ctx.signal.aborted || chosen) {
        return;
      }
      lastRoute = undefined;
      publishState(discovery > 0 ? 'searching' : 'disconnected');
      reconcileScans();
    });
  };

  /** A device setup opened: after a forgotten device, the best device found connects again. */
  const discoveryStarted = (): void => {
    if (want !== 'none') {
      return;
    }
    want = 'first';
    if (!chosen) {
      publishState('searching');
    }
    chooseFirst();
  };

  /** The last device setup closed: with the device forgotten, the link stops looking. */
  const discoveryEnded = (): void => {
    if (want === 'none' && !chosen && lastState === 'searching') {
      publishState('disconnected');
    }
  };

  // The rider's requests and the open device setups are UI events.
  ctx.events.subscribe(deviceConnectRequestedEvent, ({ payload }) => {
    if (payload.kind === kind) {
      connectRequested(payload.deviceId);
    }
  });
  ctx.events.subscribe(deviceForgetRequestedEvent, ({ payload }) => {
    if (payload.kind === kind) {
      forgetRequested();
    }
  });
  ctx.events.subscribe(deviceDiscoveryRequestedEvent, ({ payload }) => {
    const before = discovery;
    discovery = Math.max(0, discovery + (payload.active ? 1 : -1));
    if (before === 0 && discovery > 0) {
      discoveryStarted();
    } else if (before > 0 && discovery === 0) {
      discoveryEnded();
    }
    reconcileScans();
  });

  // Decoding runs in the turn of the raw input, live and on replay alike: a replay injects the
  // recorded raw inputs with this plugin as their source.
  const heard = new Set([
    characteristicUuid,
    ...(options.optionalSubscriptions ?? []).map((t) => normalizeBleUuid(t.characteristicUuid)),
  ]);
  ctx.events.subscribe(deviceRawNotificationEvent, ({ source, payload }) => {
    if (source !== ctx.manifest.id || !heard.has(payload.characteristicUuid)) {
      return;
    }
    options.onNotification(
      {
        peripheralId: payload.deviceId,
        name: payload.deviceName,
        serviceUuids: [payload.serviceUuid],
      },
      hexToBytes(payload.data),
      payload.characteristicUuid,
    );
  });

  publishState('searching');
  reconcileScans();

  const write = (
    device: { readonly deviceId: string; readonly deviceName: string },
    target: BleCharacteristicTarget,
    data: Uint8Array,
    writeOptions?: BleWriteOptions,
  ): void => {
    const written = {
      // The device as the caller knows it from its inputs: a replay has no connection to ask.
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      serviceUuid: normalizeBleUuid(target.serviceUuid),
      characteristicUuid: normalizeBleUuid(target.characteristicUuid),
      data: bytesToHex(data),
    };
    ctx.events.publish(deviceRawWriteEvent, {
      ...written,
      withResponse: writeOptions?.withResponse ?? false,
      writtenAt: ctx.clock.now(),
    });
    const connection =
      connected && chosen?.deviceId === device.deviceId ? connected.connection : undefined;
    if (!connection) {
      return;
    }
    connection.write(target, data, writeOptions).catch((error: unknown) => {
      if (!ctx.signal.aborted) {
        // The failure is the result of BLE I/O: it enters as an input before anyone reports it.
        ctx.inputs.accept(deviceRawWriteFailedEvent, {
          ...written,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    });
  };

  return {
    write,
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
