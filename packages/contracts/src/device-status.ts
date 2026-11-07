// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineState } from './app-state.ts';
import {
  type DeviceCandidate,
  type DeviceConnectionState,
  type DeviceStatus,
  deviceKindSchema,
  deviceStatusSchema,
} from './events.ts';
import { defineService } from './services.ts';

/**
 * The status of every device link (ADR 0069): one key per link of a device plugin,
 * `<plugin id>/<kind>/<n>`, owned by that plugin. App state: it never enters a journal; a
 * connection itself does, as the input `device.connection-changed`.
 */
export const deviceStatusState = defineState('device.status', deviceStatusSchema);

const linkRequest = z.object({ key: z.string().min(1) }).strict();
const done = z.object({}).strict();

/** The rider connects a device found by the link: another one, or the same one after it was forgotten. */
export const deviceConnectService = defineService('device.connect', {
  request: linkRequest.extend({ deviceId: z.string().min(1) }).strict(),
  response: done,
  keyedBy: deviceStatusState,
});

/** The rider forgets the link's device: no device connects on its own until a setup opens again. */
export const deviceForgetService = defineService('device.forget', {
  request: linkRequest,
  response: done,
  keyedBy: deviceStatusState,
});

/** A device setup opened (`active`) or closed: while one is open, the link keeps looking for devices. */
export const deviceDiscoverService = defineService('device.discover', {
  request: linkRequest.extend({ active: z.boolean() }).strict(),
  response: done,
  keyedBy: deviceStatusState,
});

/** Which status of a kind stands for it when several links report one: the most connected. */
const RANK: Readonly<Record<DeviceConnectionState, number>> = {
  connected: 4,
  reconnecting: 3,
  connecting: 2,
  searching: 1,
  disconnected: 0,
};

/**
 * One status per kind, in kind order, from the statuses of every link (the values of
 * `device.status` in key order). Of several links of a kind the most connected one stands for it
 * (the first of equals); the devices found and the links scanning are those of all of them.
 */
export function mergeDeviceStatuses(statuses: Iterable<DeviceStatus>): DeviceStatus[] {
  const byKind = new Map<string, DeviceStatus[]>();
  for (const status of statuses) {
    byKind.set(status.kind, [...(byKind.get(status.kind) ?? []), status]);
  }
  return deviceKindSchema.options.flatMap((kind) => {
    const all = byKind.get(kind);
    if (!all) {
      return [];
    }
    const best = all.reduce((a, b) => (RANK[b.state] > RANK[a.state] ? b : a));
    const found = all.flatMap((s) => s.candidates ?? []);
    const seen = new Set<string>();
    const candidates: DeviceCandidate[] = found.filter((c) => {
      const id = `${c.deviceId}|${c.routes.join()}`;
      const first = !seen.has(id);
      seen.add(id);
      return first;
    });
    const scanning = [...new Set(all.flatMap((s) => s.scanning ?? []))];
    const anyCandidates = all.some((s) => s.candidates !== undefined);
    const anyScanning = all.some((s) => s.scanning !== undefined);
    const { candidates: _c, scanning: _s, ...rest } = best;
    return [
      {
        ...rest,
        ...(anyCandidates ? { candidates } : {}),
        ...(anyScanning ? { scanning } : {}),
      },
    ];
  });
}
