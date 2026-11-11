// SPDX-License-Identifier: AGPL-3.0-or-later

import { defaultPowerZones } from '@ridrs/workout';
import { describe, expect, it } from 'vitest';
import { withAddedZone, withoutZone, zonesProblem } from './zones.tsx';

describe('zone editing', () => {
  it('accepts the defaults and refuses falling bounds', () => {
    expect(zonesProblem(defaultPowerZones())).toBeUndefined();
    expect(zonesProblem([{ upTo: 80 }, { upTo: 70 }, {}])).toBe('Upper bounds must rise');
    expect(zonesProblem([{ upTo: 80 }, {}, {}])).toBe('Only the last zone is open');
  });

  it('adds a zone below the open one and stops at ten', () => {
    const added = withAddedZone(defaultPowerZones(), 10, 100);
    expect(added).toHaveLength(8);
    expect(added[6]?.upTo).toBe(160);
    expect(zonesProblem(added)).toBeUndefined();
    let zones = added;
    for (let i = 0; i < 5; i++) zones = withAddedZone(zones, 10, 100);
    expect(zones).toHaveLength(10);
  });

  it('removes a zone and keeps the last one open', () => {
    const zones = defaultPowerZones();
    expect(withoutZone(zones, 6).at(-1)?.upTo).toBeUndefined();
    expect(withoutZone(zones, 2)).toHaveLength(6);
    expect(withoutZone([{}], 0)).toHaveLength(1);
  });
});
