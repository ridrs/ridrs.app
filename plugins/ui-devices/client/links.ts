// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type DeviceKind,
  type DeviceStatus,
  deviceConnectService,
  deviceDiscoverService,
  deviceForgetService,
  deviceStatusState,
  mergeDeviceStatuses,
} from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { useEffect, useRef, useState } from 'react';

/** The status of every device link (the app state `device.status`, ADR 0069), by its key. */
export function useDeviceLinks(ctx: UiContext): ReadonlyMap<string, DeviceStatus> {
  const [links, setLinks] = useState<ReadonlyMap<string, DeviceStatus>>(new Map());
  useEffect(() => ctx.state.watch(deviceStatusState, ({ entries }) => setLinks(entries)), [ctx]);
  return links;
}

/** One status per kind, from every device link. */
export function useDevices(ctx: UiContext): readonly DeviceStatus[] {
  const links = useDeviceLinks(ctx);
  const [devices, setDevices] = useState<readonly DeviceStatus[]>([]);
  useEffect(() => setDevices(mergeDeviceStatuses(links.values())), [links]);
  return devices;
}

/** The keys of the links of a kind: a request of the rider goes to each of them. */
const keysOf = (links: ReadonlyMap<string, DeviceStatus>, kind: DeviceKind): string[] =>
  [...links].filter(([, status]) => status.kind === kind).map(([key]) => key);

/**
 * What the rider asks of the device plugins (services, ADR 0069): connect a device found, or
 * forget the device of a kind. Every link of the kind is asked; the one that found the device
 * takes it.
 */
export function useDeviceRequests(ctx: UiContext) {
  // Read when the rider asks, not when the component rendered: a request right after the
  // details opened still reaches every link.
  const links = useRef<ReadonlyMap<string, DeviceStatus>>(new Map());
  useEffect(
    () =>
      ctx.state.watch(deviceStatusState, ({ entries }) => {
        links.current = entries;
      }),
    [ctx],
  );
  const ask = (run: () => Promise<unknown>) =>
    run().catch((error: unknown) => ctx.logger.warn('A device request was refused', error));
  return {
    connect(kind: DeviceKind, deviceId: string): void {
      for (const key of keysOf(links.current, kind)) {
        ask(() => ctx.call(deviceConnectService, { key, deviceId }));
      }
    },
    forget(kind: DeviceKind): void {
      for (const key of keysOf(links.current, kind)) {
        ask(() => ctx.call(deviceForgetService, { key }));
      }
    },
  };
}

/**
 * While the component is mounted, every device link looks for devices (`device.discover`): each
 * link is told once it is there, and told again when the component goes.
 */
export function useDiscovery(ctx: UiContext): void {
  const links = useDeviceLinks(ctx);
  const told = useRef(new Set<string>());
  useEffect(() => {
    for (const key of links.keys()) {
      if (!told.current.has(key)) {
        told.current.add(key);
        ctx
          .call(deviceDiscoverService, { key, active: true })
          .catch((error: unknown) => ctx.logger.warn('A device link could not look for devices', error));
      }
    }
  }, [ctx, links]);
  useEffect(
    () => () => {
      for (const key of told.current) {
        ctx.call(deviceDiscoverService, { key, active: false }).catch(() => undefined);
      }
      told.current.clear();
    },
    [ctx],
  );
}
