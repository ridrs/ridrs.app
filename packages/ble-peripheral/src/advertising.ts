// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BleDiscoveredPeripheral } from '@ridrs/contracts';

/**
 * A device's advertising data as seen so far, one entry per key (`m:` + company id for
 * manufacturer data, `s:` + service for service data): the bytes first seen as hex, or
 * `changing` once other bytes came for the key.
 */
export type Advertised = ReadonlyMap<string, string>;

const CHANGING = 'changing';

function keyed(p: BleDiscoveredPeripheral): [string, string][] {
  return [
    ...Object.entries(p.manufacturerData ?? {}).map(([k, v]) => [`m:${k}`, v] as [string, string]),
    ...Object.entries(p.serviceData ?? {}).map(([k, v]) => [`s:${k}`, v] as [string, string]),
  ];
}

/** What was seen after `p`: its new keys taken, keys whose bytes changed marked as changing. */
export function advertisedAfter(seen: Advertised | undefined, p: BleDiscoveredPeripheral) {
  const next = new Map(seen);
  for (const [key, bytes] of keyed(p)) {
    const before = next.get(key);
    next.set(key, before === undefined || before === bytes ? bytes : CHANGING);
  }
  return next;
}

/** Whether `p` brings a key not seen yet, or other bytes for a key not known as changing. */
export function advertisesNews(seen: Advertised, p: BleDiscoveredPeripheral): boolean {
  return keyed(p).some(([key, bytes]) => {
    const before = seen.get(key);
    return before === undefined || (before !== CHANGING && before !== bytes);
  });
}

/**
 * Whether two devices' data tell them apart: a key both have, neither changing, with other bytes.
 * Keys only one of them has, and changing ones, tell nothing.
 */
export function advertisedApart(a: Advertised, b: Advertised): boolean {
  for (const [key, bytes] of a) {
    const other = b.get(key);
    if (other !== undefined && bytes !== CHANGING && other !== CHANGING && bytes !== other) {
      return true;
    }
  }
  return false;
}
