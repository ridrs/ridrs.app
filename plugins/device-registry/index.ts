// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BleRoute,
  type DeviceCandidate,
  type DeviceKind,
  type DeviceStatus,
  definePlugin,
  deviceCandidatesChangedEvent,
  deviceConnectionChangedEvent,
  deviceKindSchema,
  deviceScanChangedEvent,
  deviceStatusChangedEvent,
  type PluginContext,
} from '@ridrs/contracts';

interface Registry {
  readonly byKind: Map<DeviceKind, DeviceStatus>;
  readonly candidates: Map<DeviceKind, readonly DeviceCandidate[]>;
  /** The name of the device of each kind connected last in this run. */
  readonly lastNames: Map<DeviceKind, string>;
  /** Per kind, the links each device plugin scans over: several plugins may look for a kind. */
  readonly scans: Map<DeviceKind, Map<string, readonly BleRoute[]>>;
  /** Until it starts, the registry only collects: `start` publishes the whole picture. */
  started: boolean;
}

/** The links over which any device plugin looks for the kind, each once, in the order named. */
function scanning(scans: Registry['scans'], kind: DeviceKind): BleRoute[] | undefined {
  const bySource = scans.get(kind);
  return bySource ? [...new Set([...bySource.values()].flat())] : undefined;
}

const registries = new WeakMap<PluginContext, Registry>();

function publish(ctx: PluginContext, registry: Registry): void {
  const { byKind, candidates, lastNames, scans, started } = registry;
  if (!started) {
    return;
  }
  const devices = deviceKindSchema.options.flatMap((kind) => {
    const status = byKind.get(kind);
    const found = candidates.get(kind);
    const looking = scanning(scans, kind);
    // Without a device, the one connected last names the kind.
    const last = status?.deviceName === '' ? lastNames.get(kind) : undefined;
    return status
      ? [
          {
            ...status,
            ...(last ? { lastDeviceName: last } : {}),
            ...(found ? { candidates: [...found] } : {}),
            ...(looking ? { scanning: looking } : {}),
          },
        ]
      : [];
  });
  ctx.events.publish(deviceStatusChangedEvent, { devices });
}

/**
 * One status per kind of device, from the connection states of all device plugins, with the
 * devices of that kind they found and the links over which they look for more. Screens that
 * open later get the whole picture from the latest status, not just the device that changed last.
 */
export default definePlugin({
  // Subscribes in initialize so that states published while device plugins start are not missed.
  initialize(ctx) {
    const registry: Registry = {
      byKind: new Map(),
      candidates: new Map(),
      lastNames: new Map(),
      scans: new Map(),
      started: false,
    };
    registries.set(ctx, registry);
    const { byKind } = registry;

    ctx.events.subscribe(deviceConnectionChangedEvent, ({ payload }) => {
      if (!payload.kind) {
        return;
      }
      const known = byKind.get(payload.kind);
      // A state without a device keeps the last name, but "searching": the device was let go.
      const named = payload.deviceId !== '' || !known || payload.state === 'searching';
      const route = payload.route ?? (named ? undefined : known.route);
      if (payload.state === 'connected' && payload.deviceName !== '') {
        registry.lastNames.set(payload.kind, payload.deviceName);
      }
      byKind.set(payload.kind, {
        kind: payload.kind,
        deviceId: named ? payload.deviceId : known.deviceId,
        deviceName: named ? payload.deviceName : known.deviceName,
        state: payload.state,
        ...(route ? { route } : {}),
      });
      publish(ctx, registry);
    });

    ctx.events.subscribe(deviceCandidatesChangedEvent, ({ payload }) => {
      registry.candidates.set(payload.kind, payload.devices);
      if (byKind.has(payload.kind)) {
        publish(ctx, registry);
      }
    });

    ctx.events.subscribe(deviceScanChangedEvent, ({ source, payload }) => {
      const bySource = registry.scans.get(payload.kind) ?? new Map<string, readonly BleRoute[]>();
      bySource.set(source, payload.routes);
      registry.scans.set(payload.kind, bySource);
      if (byKind.has(payload.kind)) {
        publish(ctx, registry);
      }
    });
  },

  start(ctx) {
    const registry = registries.get(ctx);
    if (registry) {
      registry.started = true;
      publish(ctx, registry);
    }
  },
});
