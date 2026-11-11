// SPDX-License-Identifier: AGPL-3.0-or-later

import { heartRateZonesSchema, powerZonesSchema } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { defaultHeartRateZones, defaultPowerZones, zoneBounds, zoneOf } from './zones.ts';

describe('default zones', () => {
  it('are valid zones of the athlete profile', () => {
    expect(powerZonesSchema.safeParse(defaultPowerZones()).success).toBe(true);
    expect(heartRateZonesSchema.safeParse(defaultHeartRateZones(170)).success).toBe(true);
  });

  it('keep heart rate bounds rising for a very low LTHR', () => {
    // 81 … 106 % of 5 bpm all round to 4 or 5: each bound moves up to stay above the one below.
    const bounds = defaultHeartRateZones(5).map((zone) => zone.upTo);
    expect(bounds).toEqual([4, 5, 6, 7, 8, 9, undefined]);
    expect(heartRateZonesSchema.safeParse(defaultHeartRateZones(5)).success).toBe(true);
  });

  it('are a new list each time, so that a caller may change its copy', () => {
    expect(defaultPowerZones()).not.toBe(defaultPowerZones());
  });
});

describe('zoneOf', () => {
  it('puts a value on a bound into the lower zone and above the last bound into the open one', () => {
    const zones = [{ upTo: 100 }, { upTo: 200 }, {}];
    expect(zoneOf(-5, zones)).toBe(1);
    expect(zoneOf(100, zones)).toBe(1);
    expect(zoneOf(100.01, zones)).toBe(2);
    expect(zoneOf(1000, zones)).toBe(3);
  });

  it('works with a single, open zone', () => {
    expect(zoneOf(42, [{}])).toBe(1);
  });
});

describe('zoneBounds', () => {
  const zones = defaultPowerZones();

  it('runs from the bound below to its own', () => {
    expect(zoneBounds(1, zones)).toEqual({ low: 0, high: 55 });
    expect(zoneBounds(2, zones)).toEqual({ low: 55, high: 75 });
    expect(zoneBounds(7, zones)).toEqual({ low: 150, high: undefined });
  });

  it('knows no zone 0, no zone past the last and no zone 2.5', () => {
    expect(zoneBounds(0, zones)).toBeUndefined();
    expect(zoneBounds(8, zones)).toBeUndefined();
    expect(zoneBounds(2.5, zones)).toBeUndefined();
  });
});
