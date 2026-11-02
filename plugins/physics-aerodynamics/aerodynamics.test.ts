// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { aerodynamicDragForce } from './aerodynamics.ts';

describe('aerodynamicDragForce', () => {
  it('is ½ · ρ · CdA · v² for forward airflow', () => {
    expect(aerodynamicDragForce(1.225, 0.32, 10)).toBeCloseTo(19.6, 12);
    expect(aerodynamicDragForce(1.225, 0.32, 5)).toBeCloseTo(4.9, 12);
  });

  it('is 0 in still air at standstill', () => {
    expect(aerodynamicDragForce(1.225, 0.32, 0)).toBe(0);
  });

  it('follows the sign of the relative airflow (a tailwind faster than the rider pushes)', () => {
    expect(aerodynamicDragForce(1.225, 0.32, -5)).toBeCloseTo(-4.9, 12);
  });
});
