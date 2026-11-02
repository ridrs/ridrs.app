// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { gravityResistanceForce } from './gravity-resistance.ts';

describe('gravityResistanceForce', () => {
  it('opposes the rider uphill: 85 kg on 5 % is m · g · sin(atan 0.05)', () => {
    expect(gravityResistanceForce(85, 0.05)).toBeCloseTo(41.6405, 4);
  });

  it('pushes the rider downhill', () => {
    expect(gravityResistanceForce(85, -0.05)).toBeCloseTo(-41.6405, 4);
  });

  it('is 0 on the flat', () => {
    expect(gravityResistanceForce(85, 0)).toBe(0);
  });

  it('uses the angle, not the gradient: sin θ < gradient', () => {
    expect(gravityResistanceForce(85, 0.3)).toBeLessThan(85 * 9.81 * 0.3);
  });
});
