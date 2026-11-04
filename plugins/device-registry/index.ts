// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type DeviceCandidate,
  type DeviceKind,
  type DeviceStatus,
  definePlugin,
  deviceCandidatesChangedEvent,
  deviceConnectionChangedEvent,
  deviceKindSchema,
  deviceStatusChangedEvent,
  type PluginContext,
} from '@ridrs/contracts';

interface Registry {
  readonly byKind: Map<DeviceKind, DeviceStatus>;
  readonly candidates: Map<DeviceKind, readonly DeviceCandidate[]>;
}

const registries = new WeakMap<PluginContext, Registry>();

function publish(ctx: PluginContext, { byKind, candidates }: Registry): void {
  const devices = deviceKindSchema.options.flatMap((kind) => {
    const status = byKind.get(kind);
    const found = candidates.get(kind);
    return status ? [found ? { ...status, candidates: [...found] } : status] : [];
  });
  ctx.events.publish(deviceStatusChangedEvent, { devices });
}

/**
 * One status per kind of device, from the connection states of all device plugins, with the
 * devices of that kind they found. Screens that open later get the whole picture from the latest
 * status, not just the device that changed last.
 */
export default definePlugin({
  // Subscribes in initialize so that states published while device plugins start are not missed.
  initialize(ctx) {
    const registry: Registry = { byKind: new Map(), candidates: new Map() };
    registries.set(ctx, registry);
    const { byKind } = registry;

    ctx.events.subscribe(deviceConnectionChangedEvent, ({ payload }) => {
      if (!payload.kind) {
        return;
      }
      const known = byKind.get(payload.kind);
      // States without a device ("searching" again, "disconnected" at stop) keep the last name.
      const named = payload.deviceId !== '' || !known;
      const route = payload.route ?? (named ? undefined : known.route);
      byKind.set(payload.kind, {
        kind: payload.kind,
        deviceId: named ? payload.deviceId : known.deviceId,
        deviceName: named ? payload.deviceName : known.deviceName,
        state: payload.state,
        ...(route ? { route } : {}),
        ...(payload.connectedRoutes ? { connectedRoutes: payload.connectedRoutes } : {}),
      });
      publish(ctx, registry);
    });

    ctx.events.subscribe(deviceCandidatesChangedEvent, ({ payload }) => {
      registry.candidates.set(payload.kind, payload.devices);
      if (byKind.has(payload.kind)) {
        publish(ctx, registry);
      }
    });
  },

  start(ctx) {
    const registry = registries.get(ctx);
    if (registry) {
      publish(ctx, registry);
    }
  },
});
