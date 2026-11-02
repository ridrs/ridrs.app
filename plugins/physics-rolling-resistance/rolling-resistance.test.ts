// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { rollingResistanceForce } from './rolling-resistance.ts';

describe('rollingResistanceForce', () => {
  it('is Crr · m · g while moving, opposing motion', () => {
    expect(rollingResistanceForce(0.004, 85, 10)).toBeCloseTo(0.004 * 85 * 9.81, 12);
    expect(rollingResistanceForce(0.004, 85, 10)).toBeGreaterThan(0);
  });

  it('does not depend on the speed while moving', () => {
    expect(rollingResistanceForce(0.004, 85, 0.1)).toBe(rollingResistanceForce(0.004, 85, 15));
  });

  it('grows with the moving mass', () => {
    expect(rollingResistanceForce(0.004, 105, 10)).toBeCloseTo(4.1202, 4);
  });

  it('is 0 at standstill', () => {
    expect(rollingResistanceForce(0.004, 85, 0)).toBe(0);
  });
});
