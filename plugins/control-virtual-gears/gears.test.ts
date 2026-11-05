// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { GEAR_DEFAULTS, gearRatios, shifted, shiftOf } from './gears.ts';

describe('the gear table (ADR 0055)', () => {
  const ratios = gearRatios();

  it('has 24 gears from 34 × 34 to 53 × 11', () => {
    expect(ratios).toHaveLength(24);
    expect(ratios[0]).toBeCloseTo(1, 12);
    expect(ratios[23]).toBeCloseTo(53 / 11, 12);
  });

  it('steps evenly, about 7 % per gear', () => {
    const steps = ratios.slice(1).map((r, i) => r / (ratios[i] ?? 1));
    for (const step of steps) {
      expect(step).toBeCloseTo(1.07076, 5);
    }
  });

  it('starts in gear 12, a little easier than the real gear 34 × 14', () => {
    expect(GEAR_DEFAULTS.startGear).toBe(12);
    expect(ratios[11]).toBeCloseTo(2.1213, 4);
    expect(ratios[13]).toBeCloseTo(34 / 14, 1);
  });
});

describe('shifting', () => {
  it('shifts once per press, not while held', () => {
    expect(shiftOf([], ['shift-up-right'])).toBe(1);
    expect(shiftOf(['shift-up-right'], ['shift-up-right'])).toBe(0);
    expect(shiftOf(['shift-up-right'], [])).toBe(0);
    expect(shiftOf([], ['shift-down-left'])).toBe(-1);
    expect(shiftOf([], ['shift-up-left', 'a'])).toBe(1);
  });

  it('stays within 1 and 24', () => {
    expect(shifted(24, 1)).toBe(24);
    expect(shifted(1, -1)).toBe(1);
    expect(shifted(12, 3)).toBe(15);
  });
});
