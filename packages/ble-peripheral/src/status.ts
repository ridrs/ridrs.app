// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BleRoute,
  type DeviceBattery,
  type DeviceCandidate,
  type DeviceConnectionChangedPayload,
  type DeviceKind,
  type DevicePart,
  type DeviceStatus,
  deviceConnectService,
  deviceDiscoverService,
  deviceForgetService,
  deviceStatusState,
  type PluginContext,
} from '@ridrs/contracts';

/** What the rider asks of one link (ADR 0069: services, never in a journal). */
export interface DeviceLinkCommands {
  connect(deviceId: string): void;
  forget(): void;
  discover(active: boolean): void;
}

/**
 * The status of one device link as the app shows it: its key of the app state `device.status`
 * (ADR 0069), built from its connection states, the devices it found, the links it scans over and
 * the battery levels its device told. Once the link reported its first connection state, every
 * change sets the key; until then, nothing is shown.
 */
export class DeviceStatusBoard {
  private status: DeviceStatus | undefined;
  private candidates: readonly DeviceCandidate[] | undefined;
  private scanning: readonly BleRoute[] | undefined;
  private battery:
    | { readonly deviceId: string; readonly levels: readonly DeviceBattery[] }
    | undefined;
  /** The parts a device made of several waits for, while others are connected. */
  private missing: readonly DevicePart[] = [];
  /** The name of the device connected last in this run. */
  private lastName: string | undefined;

  constructor(
    private readonly ctx: PluginContext,
    readonly kind: DeviceKind,
    readonly key: string,
  ) {}

  /** A connection state; a device made of several parts names the parts it waits for. */
  connection(
    payload: DeviceConnectionChangedPayload,
    missingParts: readonly DevicePart[] = [],
  ): void {
    this.missing = missingParts;
    const known = this.status;
    // A state without a device keeps the last name, but "searching": the device was let go.
    const named = payload.deviceId !== '' || !known || payload.state === 'searching';
    const route = payload.route ?? (named ? undefined : known.route);
    if (payload.state === 'connected' && payload.deviceName !== '') {
      this.lastName = payload.deviceName;
    }
    this.status = {
      kind: this.kind,
      deviceId: named ? payload.deviceId : known.deviceId,
      deviceName: named ? payload.deviceName : known.deviceName,
      state: payload.state,
      ...(route ? { route } : {}),
    };
    this.publish();
  }

  found(candidates: readonly DeviceCandidate[]): void {
    this.candidates = candidates;
    this.publish();
  }

  scans(routes: readonly BleRoute[]): void {
    this.scanning = routes;
    this.publish();
  }

  /** The battery levels device `deviceId` told: one per part that told it, or one without part. */
  batteries(deviceId: string, levels: readonly DeviceBattery[]): void {
    this.battery = { deviceId, levels };
    this.publish();
  }

  private publish(): void {
    const status = this.status;
    if (!status || this.ctx.signal.aborted) {
      return;
    }
    // Only the device that told them has the levels: another device of the kind may have none.
    const levels = this.battery?.deviceId === status.deviceId ? this.battery.levels : [];
    // Without a device, the one connected last names the kind.
    const last = status.deviceName === '' ? this.lastName : undefined;
    this.ctx.state.set(deviceStatusState, this.key, {
      ...status,
      ...(last ? { lastDeviceName: last } : {}),
      ...(this.candidates ? { candidates: [...this.candidates] } : {}),
      ...(this.scanning ? { scanning: [...this.scanning] } : {}),
      ...(levels.length > 0 ? { batteries: levels.map((b) => ({ ...b })) } : {}),
      ...(this.missing.length > 0 ? { missingParts: [...this.missing] } : {}),
    });
  }
}

/** Per plugin: its links by key; the plugin provides the device services once for all of them. */
const linksOf = new WeakMap<PluginContext, Map<string, DeviceLinkCommands>>();

/**
 * A new link of the plugin: its key of `device.status` is `<plugin id>/<kind>/<n>`, n counting the
 * plugin's links of that kind from 1. The plugin's manifest declares `state.owns: ["device.status"]`
 * and `services.provides` for `device.connect`, `device.forget` and `device.discover`.
 */
export function registerDeviceLink(
  ctx: PluginContext,
  kind: DeviceKind,
  commands: DeviceLinkCommands,
): DeviceStatusBoard {
  let links = linksOf.get(ctx);
  if (!links) {
    const known = new Map<string, DeviceLinkCommands>();
    links = known;
    linksOf.set(ctx, known);
    const link = (key: string): DeviceLinkCommands => {
      const found = known.get(key);
      if (!found) {
        throw new Error(`No device link "${key}"`);
      }
      return found;
    };
    ctx.services.provide(deviceConnectService, ({ key, deviceId }) => {
      link(key).connect(deviceId);
      return {};
    });
    ctx.services.provide(deviceForgetService, ({ key }) => {
      link(key).forget();
      return {};
    });
    ctx.services.provide(deviceDiscoverService, ({ key, active }) => {
      link(key).discover(active);
      return {};
    });
  }
  const prefix = `${ctx.manifest.id}/${kind}/`;
  const n = [...links.keys()].filter((key) => key.startsWith(prefix)).length + 1;
  const key = `${prefix}${n}`;
  links.set(key, commands);
  return new DeviceStatusBoard(ctx, kind, key);
}
