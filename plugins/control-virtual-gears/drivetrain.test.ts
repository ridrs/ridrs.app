// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Drivetrain, ShiftMode } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { drivetrainRatios, type GearPosition, ratioAt, shiftDrivetrain, teethAt } from './drivetrain.ts';

/** Shimano Di2 2 × 12, 50-34 / 11-34, with the shift map found for ADR 0060. */
const di2 = (mode: ShiftMode): Drivetrain => ({
  id: 'shimano-di2-2x12-50-34-11-34',
  chainrings: [34, 50],
  sprockets: [34, 30, 27, 24, 21, 19, 17, 15, 14, 13, 12, 11],
  shifting: {
    mode,
    semiSynchroCompensation: 2,
    fullSynchro: { toLarge: { fromRear: 7, toRear: 5 }, toSmall: { fromRear: 2, toRear: 4 } },
  },
  startGear: { front: 1, rear: 7 },
});

const teeth = (drivetrain: Drivetrain, at: GearPosition) => {
  const { chainring, sprocket } = teethAt(drivetrain, at);
  return `${chainring} × ${sprocket}`;
};

/** Applies the shifts in order and gives the teeth after each. */
function ride(drivetrain: Drivetrain, shifts: readonly string[]): string[] {
  let at: GearPosition = drivetrain.startGear;
  return shifts.map((shift) => {
    const [shifter, direction] = shift.split(' ') as ['left' | 'right', 'harder' | 'easier'];
    at = shiftDrivetrain(drivetrain, at, shifter, direction);
    return teeth(drivetrain, at);
  });
}

describe('manual', () => {
  const manual = di2('manual');

  it('moves each derailleur with its own shifter', () => {
    expect(ride(manual, ['right harder', 'right harder', 'left harder', 'right easier', 'left easier'])).toEqual([
      '34 × 15',
      '34 × 14',
      '50 × 14',
      '50 × 15',
      '34 × 15',
    ]);
  });

  it('stops at the ends of each derailleur, and every combination can be reached', () => {
    expect(ride(manual, Array(12).fill('right harder')).at(-1)).toBe('34 × 11');
    expect(ride(manual, Array(14).fill('right easier')).at(-1)).toBe('34 × 34');
    expect(ride(manual, ['left harder', 'left harder', 'left harder']).at(-1)).toBe('50 × 17');
    expect(ride(manual, ['left easier']).at(-1)).toBe('34 × 17');
  });
});

describe('semi-synchro', () => {
  const semi = di2('semi-synchro');

  it('compensates a front shift with two sprockets the other way', () => {
    expect(ride(semi, ['left harder', 'left easier'])).toEqual(['50 × 21', '34 × 17']);
  });

  it('keeps the rear within the cassette while compensating', () => {
    const down = ride(semi, [...Array(6).fill('right easier'), 'left harder']);
    expect(down.at(-1)).toBe('50 × 34');
    const up = ride(semi, [...Array(5).fill('right harder'), 'left harder', 'left easier']);
    expect(up.slice(-2)).toEqual(['50 × 13', '34 × 11']);
  });

  it('leaves the rear shifter alone', () => {
    expect(ride(semi, ['right harder'])).toEqual(['34 × 15']);
  });
});

describe('full synchro', () => {
  const full = di2('full-synchro');

  it('switches to the large chainring when shifting harder from the 7th sprocket', () => {
    expect(ride(full, ['right harder', 'right easier'])).toEqual(['50 × 21', '50 × 24']);
  });

  it('switches to the small chainring when shifting easier from the 2nd sprocket', () => {
    const shifts = ['right harder', 'right easier', 'right easier', 'right easier', 'right easier'];
    expect(ride(full, shifts)).toEqual(['50 × 21', '50 × 24', '50 × 27', '50 × 30', '34 × 24']);
  });

  it('runs through the whole range with the right shifter alone', () => {
    expect(ride(full, Array(12).fill('right harder')).at(-1)).toBe('50 × 11');
    expect(ride(full, Array(20).fill('right easier')).at(-1)).toBe('34 × 34');
  });

  it('shifts the front with the left shifter, compensated as in semi-synchro', () => {
    expect(ride(full, ['left harder'])).toEqual(['50 × 21']);
  });
});

describe('ratios', () => {
  it('lists every combination once, easiest first', () => {
    const ratios = drivetrainRatios(di2('manual'));
    expect(ratios).toHaveLength(24);
    expect(ratios[0]).toBe(34 / 34);
    expect(ratios.at(-1)).toBe(50 / 11);
    expect([...ratios].sort((a, b) => a - b)).toEqual(ratios);
    expect(ratios).toContain(ratioAt(di2('manual'), { front: 2, rear: 5 }));
  });

  it('a single chainring ignores the left shifter', () => {
    const single = { ...di2('manual'), chainrings: [40], startGear: { front: 1, rear: 7 } };
    expect(ride(single, ['left harder'])).toEqual(['40 × 17']);
  });
});
