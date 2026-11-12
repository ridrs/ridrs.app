// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BleDiscoveredPeripheral,
  type BleRoute,
  type DeviceBattery,
  type DeviceCandidate,
  type DeviceConnectionChangedPayload,
  type DeviceConnectionState,
  type DevicePart,
  deviceConnectionChangedEvent,
  deviceRawNotificationEvent,
  hexToBytes,
  normalizeBleUuid,
  type RememberedDevice,
} from '@ridrs/contracts';
import {
  type BlePeripheralLinkOptions,
  createLink,
  type FoundDevice,
  type LinkControl,
} from './link.ts';
import type { DeviceMemory, DevicePartsMemory } from './memory.ts';
import { registerDeviceLink } from './status.ts';

/** A packet of one part: the device it belongs to, and the part's own id. */
export interface DevicePartOf {
  /** The device the part belongs to; a part of a recording from before the parts is its own. */
  readonly deviceId: string;
  /** The part's id on its link: the id its raw inputs carry. */
  readonly partId: string;
  /** The part's name, as its raw inputs carry it. */
  readonly name: string;
  /** Which part it is; absent in recordings from before the parts. */
  readonly part?: DevicePart;
}

export interface BlePartsLinkOptions
  extends Omit<BlePeripheralLinkOptions, 'memory' | 'onNotification'> {
  /** The parts the device is made of, each a BLE device of its own with the same service. */
  readonly parts: readonly [DevicePart, ...DevicePart[]];
  /** Which part a device found is, when its advertising data tells; else `undefined`. */
  readonly partOf?: (peripheral: BleDiscoveredPeripheral) => DevicePart | undefined;
  /** What the device remembers across runs: all its parts in one entry. */
  readonly memory?: DevicePartsMemory;
  /** Raw notification bytes of any part, decoded in the turn of the raw input, live and on replay. */
  readonly onNotification: (
    device: DevicePartOf,
    packet: Uint8Array,
    characteristicUuid: string,
  ) => void;
}

export interface BlePartsLink {
  /** Unsubscribes, disconnects every part and publishes `disconnected`. */
  stop(): Promise<void>;
}

type Remembered = Extract<RememberedDevice, { state: 'chosen' }> & {
  readonly part?: DevicePart | undefined;
};

/** The most connected state of a device made of parts: connected only once every part is. */
function stateOf(reports: readonly DeviceConnectionChangedPayload[]): DeviceConnectionState {
  if (!reports.some((r) => r.deviceId !== '')) {
    return reports.some((r) => r.state === 'searching') ? 'searching' : 'disconnected';
  }
  if (reports.every((r) => r.state === 'connected')) {
    return 'connected';
  }
  if (reports.every((r) => r.state === 'disconnected')) {
    return 'disconnected';
  }
  return reports.some((r) => r.state === 'reconnecting') ? 'reconnecting' : 'connecting';
}

/**
 * One device made of several BLE devices, its parts (ADR 0089): a link per part, one status, one
 * remembered entry and one connection state for the device. Each part is found and connected like
 * a device of its own (`startBlePeripheralLink`), but no part is offered alone: the devices found
 * are offered as devices of all parts (the strongest of each part together), connecting and
 * forgetting take every part, and the device counts as `connected` only once every part is; until
 * then it is `connecting` or `reconnecting` and names the parts it waits for.
 *
 * The device takes the id of the part it found first and keeps it while it is remembered. Its
 * connection states (`device.connection-changed`) name the id of each part (`parts`): the raw
 * inputs carry those, and a replay maps them to the device.
 */
export function startBlePartsLink(options: BlePartsLinkOptions): BlePartsLink {
  const { ctx, kind, parts } = options;
  const count = parts.length;
  const partOf = (f: FoundDevice | undefined): DevicePart | undefined =>
    f ? options.partOf?.(f.peripheral) : undefined;

  const controls: LinkControl[] = [];
  const board = registerDeviceLink(ctx, kind, {
    connect: (deviceId) => connectRequested(deviceId),
    forget: () => forgetRequested(),
    discover: (active) => {
      for (const control of controls) {
        control.discover(active);
      }
    },
  });

  // ---- What the device remembers -----------------------------------------------------------

  const memory = options.memory;
  const initial = memory?.remembered;
  let forgotten = initial?.state === 'forgotten';
  /** The device's id: the id of the part found first, kept while it is remembered. */
  let deviceId = initial?.state === 'chosen' ? initial.deviceId : undefined;
  /** The part each link connected last. */
  const halves: (Remembered | undefined)[] = Array.from({ length: count }, () => undefined);
  if (initial?.state === 'chosen') {
    // A part named as one goes to that link; the others fill the links left in order.
    const free = new Set(halves.keys());
    const unnamed = initial.parts.filter((p) => {
      const at = p.part === undefined ? -1 : parts.indexOf(p.part);
      if (at === -1 || !free.has(at)) {
        return true;
      }
      free.delete(at);
      halves[at] = { state: 'chosen', ...p };
      return false;
    });
    for (const p of unnamed) {
      const [at] = free;
      if (at === undefined) {
        break;
      }
      free.delete(at);
      halves[at] = { state: 'chosen', ...p };
    }
  }
  let written = JSON.stringify(initial ?? null);
  const write = (value: Parameters<DevicePartsMemory['save']>[0]): void => {
    const json = JSON.stringify(value);
    if (json !== written) {
      written = json;
      memory?.save(value);
    }
  };

  const remember = (): void => {
    const known = halves.flatMap((h, i) =>
      h ? [{ part: labels()[i], route: h.route, peripheralId: h.peripheralId, name: h.name }] : [],
    );
    const id = deviceId ?? reports.find((r) => r?.deviceId)?.deviceId;
    if (id && known.length > 0) {
      write({ state: 'chosen', deviceId: id, parts: known });
    }
  };

  /** The memory a part's link reads and writes: its part of the device's entry. */
  const memoryOf = (i: number): DeviceMemory => ({
    remembered: forgotten ? { state: 'forgotten' } : halves[i] && toLink(halves[i]),
    save: (remembered) => {
      if (remembered.state === 'forgotten') {
        forgotten = true;
        halves.fill(undefined);
        write({ state: 'forgotten' });
        return;
      }
      forgotten = false;
      halves[i] = { ...remembered, part: labels()[i] };
      remember();
    },
  });

  // ---- What each part's link reports --------------------------------------------------------

  const reports: (DeviceConnectionChangedPayload | undefined)[] = Array.from({ length: count });
  const found: (readonly FoundDevice[])[] = Array.from({ length: count }, () => []);
  /** When each link reported its devices last: the freshest report of a device counts. */
  const foundAt: number[] = Array.from({ length: count }, () => 0);
  let reported = 0;
  const scanning: (readonly BleRoute[])[] = Array.from({ length: count }, () => []);
  const batteries: ({ readonly deviceId: string; readonly level: number } | undefined)[] =
    Array.from({ length: count });
  /** Devices found that a link took, by id: no other link takes them. */
  const takenBy = new Map<string, { readonly link: number; readonly part?: DevicePart }>();
  /** The devices offered, by id: the ids of their parts. */
  let offered = new Map<string, readonly string[]>();

  const held = (i: number): string => reports[i]?.deviceId ?? '';

  /** Every device found by any link, once, as the link that reported last saw it. */
  const allFound = (): FoundDevice[] => {
    const order: string[] = [];
    const freshest = new Map<string, { readonly device: FoundDevice; readonly at: number }>();
    for (const [i, devices] of found.entries()) {
      const at = foundAt[i] ?? 0;
      for (const device of devices) {
        const before = freshest.get(device.deviceId);
        if (!before) {
          order.push(device.deviceId);
        }
        if (!before || at > before.at) {
          freshest.set(device.deviceId, { device, at });
        }
      }
    }
    return order.flatMap((id) => {
      const entry = freshest.get(id);
      return entry ? [entry.device] : [];
    });
  };

  /**
   * Which part each link holds: the part its device advertises, else the part it was remembered
   * as, else the parts left in order.
   */
  const labels = (): DevicePart[] => {
    const all = allFound();
    const result: (DevicePart | undefined)[] = Array.from({ length: count });
    const free = new Set<DevicePart>(parts);
    const claim = (i: number, part: DevicePart | undefined): void => {
      if (part !== undefined && result[i] === undefined && free.has(part)) {
        result[i] = part;
        free.delete(part);
      }
    };
    for (let i = 0; i < count; i += 1) {
      claim(i, partOf(all.find((f) => f.deviceId === held(i))));
    }
    for (let i = 0; i < count; i += 1) {
      const device = all.find((f) => f.deviceId === held(i));
      const half = halves[i];
      if (device && half?.route === device.route && half.peripheralId === device.peripheralId) {
        claim(i, half.part);
      }
    }
    return result.map((part) => {
      if (part !== undefined) {
        return part;
      }
      const [next] = free;
      free.delete(next as DevicePart);
      return next as DevicePart;
    });
  };

  const isHalf = (half: Remembered | undefined, device: FoundDevice): boolean =>
    half?.route === device.route && half.peripheralId === device.peripheralId;

  /**
   * The part link `j` remembers: as its device advertises it once found, else as remembered, else
   * the part of the link's place (an entry from before the parts names none).
   */
  const rememberedPart = (j: number, half: Remembered | undefined): DevicePart | undefined => {
    if (!half) {
      return undefined;
    }
    const device = allFound().find((f) => isHalf(half, f));
    return partOf(device) ?? half.part ?? parts[j];
  };

  /**
   * Whether link `i` takes a device found: the part it remembers, else one no other link holds or
   * remembers, of a part no other link holds or remembers.
   */
  const accept =
    (i: number) =>
    (device: FoundDevice): boolean => {
      const owner = takenBy.get(device.deviceId);
      if (owner && owner.link !== i) {
        return false;
      }
      const part = partOf(device);
      if (!owner && !isHalf(halves[i], device)) {
        if (halves.some((h, j) => j !== i && isHalf(h, device))) {
          return false;
        }
        const others = [
          ...[...takenBy.values()].filter((t) => t.link !== i).map((t) => t.part),
          ...halves.map((h, j) => (j === i ? undefined : rememberedPart(j, h))),
        ];
        if (part !== undefined && others.includes(part)) {
          return false;
        }
      }
      take(device.deviceId, i, part);
      return true;
    };

  const take = (id: string, link: number, part: DevicePart | undefined): void => {
    for (const [other, t] of takenBy) {
      if (t.link === link) {
        takenBy.delete(other);
      }
    }
    takenBy.set(id, { link, ...(part === undefined ? {} : { part }) });
  };

  // ---- The device as one ---------------------------------------------------------------------

  /** The devices found, each with its parts: the strongest of each part together, per link. */
  const offers = (): { readonly id: string; readonly halves: readonly FoundDevice[] }[] => {
    const all = allFound();
    const firstFound = (group: readonly FoundDevice[]): FoundDevice =>
      group.reduce((a, b) => (all.indexOf(b) < all.indexOf(a) ? b : a));
    const result: { id: string; halves: FoundDevice[] }[] = [];
    const heldIds = reports.map((_, i) => held(i)).filter((id) => id !== '');
    if (heldIds.length > 0) {
      const own = heldIds.flatMap((id) => all.filter((f) => f.deviceId === id));
      if (own.length > 0) {
        result.push({ id: deviceId ?? firstFound(own).deviceId, halves: own });
      }
    }
    const rest = all.filter((f) => !heldIds.includes(f.deviceId));
    const routes = [...new Set(rest.map((f) => f.route))];
    for (const route of routes) {
      // The strongest first; devices without a signal follow in the order found.
      const pool = rest
        .filter((f) => f.route === route)
        .toSorted(
          (a, b) => (b.rssi ?? Number.NEGATIVE_INFINITY) - (a.rssi ?? Number.NEGATIVE_INFINITY),
        );
      while (pool.length > 0) {
        const group = pool.splice(0, 1);
        while (group.length < count) {
          const taken = group.map(partOf);
          const fits = (f: FoundDevice): boolean => {
            const part = partOf(f);
            return part === undefined || !taken.includes(part);
          };
          // A device that says which part it is beats one that does not.
          const next =
            pool.find((f) => fits(f) && partOf(f) !== undefined) ?? pool.find((f) => fits(f));
          if (!next) {
            break;
          }
          pool.splice(pool.indexOf(next), 1);
          group.push(next);
        }
        result.push({ id: firstFound(group).deviceId, halves: group });
      }
    }
    return result;
  };

  const publishFound = (): void => {
    const all = offers();
    offered = new Map(all.map((o) => [o.id, o.halves.map((h) => h.deviceId)]));
    const offerOf = (partId: string) =>
      all.find((o) => o.halves.some((h) => h.deviceId === partId));
    const candidates: DeviceCandidate[] = all.map((o) => {
      const signals = o.halves.flatMap((h) => (h.rssi === undefined ? [] : [h.rssi]));
      // The same device over the other link: one of its parts is a part of that one.
      const twin = o.halves
        .map((h) => (h.sameDeviceAs ? offerOf(h.sameDeviceAs) : undefined))
        .find((t) => t !== undefined && t.id !== o.id);
      const route = o.halves[0]?.route ?? 'local';
      return {
        deviceId: o.id,
        deviceName: o.halves.find((h) => h.deviceName !== '')?.deviceName ?? '',
        routes: [route],
        // A device of parts is as near as its farthest part.
        ...(signals.length > 0 ? { rssi: Math.min(...signals) } : {}),
        ...(twin ? { sameDeviceAs: twin.id } : {}),
      };
    });
    board.found(candidates);
  };

  /** The connection state published last, as JSON: only a change is published again. */
  let lastState = '';
  let lastStatus = '';

  const publishState = (): void => {
    const all = reports.filter((r): r is DeviceConnectionChangedPayload => r !== undefined);
    if (all.length < count) {
      return;
    }
    const ids = all.map((r) => r.deviceId);
    const first = ids.find((id) => id !== '');
    if (first !== undefined && deviceId === undefined) {
      deviceId = first;
    }
    const state = stateOf(all);
    const now = labels();
    const holding = first !== undefined;
    const routed = all.find((r) => r.deviceId !== '' && r.route) ?? all.find((r) => r.route);
    const connected = all.filter((r) => r.state === 'connected');
    const characteristics = [...new Set(connected.flatMap((r) => r.characteristics ?? []))];
    const payload: DeviceConnectionChangedPayload = {
      deviceId: holding ? (deviceId ?? first) : '',
      deviceName: all.find((r) => r.deviceId !== '' && r.deviceName !== '')?.deviceName ?? '',
      kind,
      state,
      ...(routed?.route ? { route: routed.route } : {}),
      ...(state === 'connected' && all.some((r) => r.characteristics) ? { characteristics } : {}),
      ...(holding
        ? {
            parts: ids.flatMap((id, i) =>
              id === '' ? [] : [{ part: now[i] as DevicePart, deviceId: id }],
            ),
          }
        : {}),
    };
    // While some parts are connected, the others are what the device waits for.
    const missing =
      (state === 'connecting' || state === 'reconnecting') && connected.length > 0
        ? parts.filter((part) => all.some((r, i) => now[i] === part && r.state !== 'connected'))
        : [];
    const json = JSON.stringify(payload);
    if (json !== lastState) {
      lastState = json;
      // Connection results come from BLE I/O: they enter the simulation as inputs.
      ctx.inputs.accept(deviceConnectionChangedEvent, payload);
    }
    const status = JSON.stringify([payload, missing]);
    if (status !== lastStatus) {
      lastStatus = status;
      // The app's view of the device is app state (ADR 0069).
      board.connection(payload, missing);
      publishBatteries();
    }
  };

  const publishBatteries = (): void => {
    const now = labels();
    const levels: DeviceBattery[] = parts.flatMap((part) => {
      const i = now.indexOf(part);
      const battery = batteries[i];
      return battery && held(i) === battery.deviceId ? [{ part, level: battery.level }] : [];
    });
    board.batteries(deviceId ?? '', levels);
  };

  // ---- What the rider asks -------------------------------------------------------------------

  /** Connects every part of a device offered; a part not found yet is taken once it is. */
  const connectRequested = (id: string): void => {
    const ids = offered.get(id);
    if (!ids) {
      return;
    }
    deviceId = id;
    forgotten = false;
    const assigned = new Map<number, string>();
    const rest: string[] = [];
    for (const partId of ids) {
      const holder = reports.findIndex((r) => r?.deviceId === partId);
      if (holder >= 0 && !assigned.has(holder)) {
        assigned.set(holder, partId);
      } else {
        rest.push(partId);
      }
    }
    for (const partId of rest) {
      const free = controls.findIndex((_, i) => !assigned.has(i));
      if (free >= 0) {
        assigned.set(free, partId);
      }
    }
    const all = allFound();
    for (const [i, control] of controls.entries()) {
      const partId = assigned.get(i);
      if (partId === undefined) {
        halves[i] = undefined;
        for (const [other, t] of takenBy) {
          if (t.link === i) {
            takenBy.delete(other);
          }
        }
        control.seek();
      } else {
        take(partId, i, partOf(all.find((f) => f.deviceId === partId)));
        control.connect(partId);
      }
    }
  };

  /** Lets every part go: no part connects on its own until a device setup opens again. */
  const forgetRequested = (): void => {
    if (!reports.some((r) => r?.deviceId)) {
      return;
    }
    forgotten = true;
    deviceId = undefined;
    takenBy.clear();
    halves.fill(undefined);
    write({ state: 'forgotten' });
    for (const control of controls) {
      control.forget();
    }
  };

  // ---- The links, one per part ---------------------------------------------------------------

  const links = parts.map((_, i) => {
    const started = createLink(
      {
        ...options,
        label: `${options.label} (part ${i + 1})`,
        memory: memoryOf(i),
        accept: accept(i),
        // The device decodes the raw inputs of all its parts once (below).
        decode: false,
        onNotification: () => undefined,
      },
      {
        state: (payload) => {
          reports[i] = payload;
          publishState();
          publishFound();
        },
        found: (devices) => {
          found[i] = devices;
          reported += 1;
          foundAt[i] = reported;
          publishFound();
          // A part's advertising data may tell which part it is only now.
          publishState();
        },
        scans: (routes) => {
          scanning[i] = routes;
          const all = (['local', 'companion'] as const).filter((route) =>
            scanning.some((r) => r.includes(route)),
          );
          board.scans(all);
        },
        battery: (partId, level) => {
          batteries[i] = { deviceId: partId, level };
          publishBatteries();
        },
      },
    );
    controls.push(started.control);
    return started.link;
  });
  publishState();
  publishFound();

  // ---- Decoding, live and on replay ------------------------------------------------------------

  /** The device each part belongs to, from the device's connection inputs (recorded too). */
  const deviceOfPart = new Map<string, { readonly deviceId: string; readonly part: DevicePart }>();
  ctx.events.subscribe(deviceConnectionChangedEvent, ({ source, payload }) => {
    if (source !== ctx.manifest.id) {
      return;
    }
    for (const { part, deviceId: partId } of payload.parts ?? []) {
      deviceOfPart.set(partId, { deviceId: payload.deviceId, part });
    }
  });
  const heard = new Set([
    normalizeBleUuid(options.characteristic.characteristicUuid),
    ...(options.optionalSubscriptions ?? []).map((t) => normalizeBleUuid(t.characteristicUuid)),
  ]);
  ctx.events.subscribe(deviceRawNotificationEvent, ({ source, payload }) => {
    if (source !== ctx.manifest.id || !heard.has(payload.characteristicUuid)) {
      return;
    }
    // A part of a recording from before the parts has no device: it stands for itself.
    const of = deviceOfPart.get(payload.deviceId);
    options.onNotification(
      {
        deviceId: of?.deviceId ?? payload.deviceId,
        partId: payload.deviceId,
        name: payload.deviceName,
        ...(of ? { part: of.part } : {}),
      },
      hexToBytes(payload.data),
      payload.characteristicUuid,
    );
  });

  return {
    async stop(): Promise<void> {
      await Promise.all(links.map((link) => link.stop()));
    },
  };
}

function toLink(half: Remembered): RememberedDevice {
  return { state: 'chosen', route: half.route, peripheralId: half.peripheralId, name: half.name };
}
