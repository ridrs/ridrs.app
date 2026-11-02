// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import type { ResistanceInput } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { aerodynamicDragForce } from './aerodynamics.ts';
import plugin from './index.ts';

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

describe('the aerodynamics plugin', () => {
  type Provided = { force(input: ResistanceInput): number };

  function dragWith(airDensity: number, speed = 10): number {
    let provided: Provided | undefined;
    const parameters: Record<string, unknown> = {
      'physics.rider': { mass: { value: 75, origin: 'default' }, cdA: { value: 0.32, origin: 'default' } },
      'physics.environment': { airDensity: { value: airDensity, origin: 'default' } },
    };
    const ctx = {
      manifest: { id: 'physics-aerodynamics' },
      capabilities: {
        provide: (_contract: unknown, impl: Provided) => {
          provided = impl;
        },
        get: (contract: { id: string }) => ({ parameters: () => parameters[contract.id] }),
      },
    };
    plugin.initialize?.(ctx as never);
    assert(provided);
    return provided.force({ at: 0, speed, mass: 85, road: { gradient: 0, origin: 'default' } });
  }

  it('uses the air density of the environment', () => {
    expect(dragWith(1.225)).toBeCloseTo(19.6, 12);
    expect(dragWith(1.0)).toBeCloseTo(16, 12);
  });

  it('fails the step naming itself for an invalid air density', () => {
    for (const airDensity of [0, -1, Number.NaN]) {
      expect(() => dragWith(airDensity)).toThrowError(
        expect.objectContaining({ name: 'PhysicsStepError', pluginId: 'physics-aerodynamics' }),
      );
    }
  });
});
