// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { rollingResistanceForce } from './rolling-resistance.ts';

describe('rollingResistanceForce', () => {
  it('is Crr · m · g while moving, opposing motion', () => {
    expect(rollingResistanceForce(0.004, 85, 10, 0)).toBeCloseTo(0.004 * 85 * 9.81, 12);
    expect(rollingResistanceForce(0.004, 85, 10, 0)).toBeGreaterThan(0);
  });

  it('does not depend on the speed while moving', () => {
    expect(rollingResistanceForce(0.004, 85, 0.1, 0)).toBe(rollingResistanceForce(0.004, 85, 15, 0));
  });

  it('grows with the moving mass', () => {
    expect(rollingResistanceForce(0.004, 105, 10, 0)).toBeCloseTo(4.1202, 4);
  });

  it('is 0 at standstill', () => {
    expect(rollingResistanceForce(0.004, 85, 0, 0)).toBe(0);
  });

  it('shrinks by cos θ on a gradient, the same uphill and downhill', () => {
    expect(rollingResistanceForce(0.004, 85, 5, 0.05)).toBeCloseTo(3.3312, 4);
    expect(rollingResistanceForce(0.004, 85, 5, -0.05)).toBe(rollingResistanceForce(0.004, 85, 5, 0.05));
    expect(rollingResistanceForce(0.004, 85, 5, 0.05)).toBeLessThan(rollingResistanceForce(0.004, 85, 5, 0));
  });

  it('is 0 at standstill on a gradient too', () => {
    expect(rollingResistanceForce(0.004, 85, 0, 0.05)).toBe(0);
  });
});
