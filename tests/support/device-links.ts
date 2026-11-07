// SPDX-License-Identifier: AGPL-3.0-or-later

// ADR 0069: the app's view of device links is the app state `device.status`; the rider's requests
// are the services `device.connect`, `device.forget` and `device.discover`. The test device plugin
// keeps its links with the same board as the real ones; the steps read the merged status.

import assert from 'node:assert/strict';
import { type DeviceStatusBoard, registerDeviceLink } from '@ridrs/ble-peripheral';
import {
  type DeviceConnectionChangedPayload,
  type DeviceKind,
  type DeviceStatus,
  deviceConnectionChangedEvent,
  deviceConnectService,
  deviceDiscoverService,
  deviceForgetService,
  deviceStatusState,
  mergeDeviceStatuses,
  type PluginContext,
} from '@ridrs/contracts';
import type { RidrsWorld } from './world.ts';

/** The manifest fields of a test device plugin: it keeps device links like a real one. */
export const TEST_DEVICE_CHANNELS = {
  state: { owns: [deviceStatusState.id] },
  services: {
    provides: [deviceConnectService.id, deviceForgetService.id, deviceDiscoverService.id],
  },
} as const;

const boards = new WeakMap<PluginContext, Map<DeviceKind, DeviceStatusBoard>>();

function contextOf(world: RidrsWorld, pluginId: string): PluginContext {
  const ctx = world.ensureHost().getPluginContext(pluginId);
  assert.ok(ctx, `Expected context for plugin "${pluginId}"`);
  return ctx;
}

/** The test device's link of a kind; what the rider asks of it is kept as a service call. */
export function testDeviceLink(world: RidrsWorld, pluginId: string, kind: DeviceKind) {
  const ctx = contextOf(world, pluginId);
  let links = boards.get(ctx);
  if (!links) {
    links = new Map();
    boards.set(ctx, links);
  }
  let board = links.get(kind);
  if (!board) {
    const asked = (service: string, request: Record<string, unknown>) => {
      const calls = world.serviceCalls.get(pluginId) ?? [];
      calls.push({ service, request: { kind, ...request } });
      world.serviceCalls.set(pluginId, calls);
    };
    board = registerDeviceLink(ctx, kind, {
      connect: (deviceId) => asked(deviceConnectService.id, { deviceId }),
      forget: () => asked(deviceForgetService.id, {}),
      discover: (active) => asked(deviceDiscoverService.id, { active }),
    });
    links.set(kind, board);
  }
  return board;
}

/**
 * A test device reports a connection state from outside the host: an external input, and, with
 * a kind, the status of its link of that kind.
 */
export async function reportConnection(
  world: RidrsWorld,
  pluginId: string,
  payload: DeviceConnectionChangedPayload,
): Promise<void> {
  contextOf(world, pluginId).inputs.accept(deviceConnectionChangedEvent, payload);
  if (payload.kind) {
    testDeviceLink(world, pluginId, payload.kind).connection(payload);
  }
  await world.flushState();
}

/** One status per kind, from every device link of the host. */
export function deviceStatuses(world: RidrsWorld): DeviceStatus[] {
  return mergeDeviceStatuses(
    world.ensureHost().getState(deviceStatusState.id).values() as Iterable<DeviceStatus>,
  );
}

/** The keys of the device links of a kind: a request of the rider goes to each of them. */
function keysOf(world: RidrsWorld, kind: DeviceKind): string[] {
  return [...world.ensureHost().getState(deviceStatusState.id)]
    .filter(([, status]) => (status as DeviceStatus).kind === kind)
    .map(([key]) => key);
}

/** The rider asks, as the UI does: one call per link of the kind (or per link, for discovery). */
export async function riderCalls(
  world: RidrsWorld,
  service: typeof deviceConnectService | typeof deviceForgetService,
  kind: DeviceKind,
  request: Record<string, unknown> = {},
): Promise<void> {
  for (const key of keysOf(world, kind)) {
    await world
      .ensureHost()
      .callService(service.id, { key, ...request }, { pluginId: 'ui-bridge' });
  }
  await world.flushState();
}

/** Every device link looks for devices (`active`) or stops, as an open device setup asks. */
export async function riderDiscovers(world: RidrsWorld, active: boolean): Promise<void> {
  for (const key of world.ensureHost().getState(deviceStatusState.id).keys()) {
    await world
      .ensureHost()
      .callService(deviceDiscoverService.id, { key, active }, { pluginId: 'ui-bridge' });
  }
  await world.flushState();
}

/** What the rider asked of the test devices' links, by service, oldest first. */
export function asked(world: RidrsWorld, service: string): Record<string, unknown>[] {
  return [...world.serviceCalls.values()]
    .flat()
    .filter((call) => call.service === service)
    .map((call) => {
      const { active: _active, ...request } = call.request as Record<string, unknown>;
      return request;
    });
}
