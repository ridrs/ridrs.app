// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import type { MotionCapability, ResistanceInput } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import plugin from './index.ts';

const T0 = Date.UTC(2026, 10, 1, 10, 0, 0, 0);

/** The virtual-speed plugin on fake providers; records every input the resistance sees. */
function motionOn(gradientAt: (distance: number) => number) {
  const asked: number[] = [];
  const inputs: ResistanceInput[] = [];
  const parameter = (value: number) => ({ value, origin: 'default' });
  const providers: Record<string, unknown> = {
    'physics.rider': { parameters: () => ({ mass: parameter(75), cdA: parameter(0.32) }) },
    'physics.bicycle': {
      parameters: () => ({ mass: parameter(10), rollingResistanceCoefficient: parameter(0.004) }),
    },
    'physics.powertrain': {
      wheelPower: (at: number) => ({
        riderPower: { status: 'unavailable', at, reason: 'no-source' },
        wheelPower: 0,
        efficiency: 1,
      }),
    },
    'physics.road': {
      source: 'test-road',
      at: (distance: number) => {
        asked.push(distance);
        return { gradient: gradientAt(distance), origin: 'default' };
      },
    },
    'physics.total-resistance': {
      evaluate: (input: ResistanceInput) => {
        inputs.push(input);
        return { total: 0, contributions: [] };
      },
    },
  };
  let motion: MotionCapability | undefined;
  const ctx = {
    manifest: { id: 'physics-virtual-speed' },
    capabilities: {
      provide: (_contract: unknown, impl: MotionCapability) => {
        motion = impl;
      },
      get: (contract: { id: string }) => providers[contract.id],
    },
  };
  plugin.initialize?.(ctx as never);
  assert(motion);
  return { motion, asked, inputs };
}

describe('the road lookup in a step', () => {
  it('asks the road once per step at the previous distance and reports that sample', () => {
    const { motion, asked, inputs } = motionOn((distance) => (distance < 100 ? 0 : 0.05));
    expect(motion.initial(T0).road).toEqual({ gradient: 0, origin: 'default' });
    const next = motion.advance({ at: T0, speed: 5, distance: 100 }, T0 + 10);
    expect(asked).toEqual([0, 100]);
    expect(inputs.at(-1)?.road).toEqual({ gradient: 0.05, origin: 'default' });
    expect(next.road).toEqual({ gradient: 0.05, origin: 'default' });
  });

  it.each([0.31, -0.31, Number.NaN])('fails the step naming the road for a gradient of %f', (g) => {
    const { motion } = motionOn(() => g);
    expect(() => motion.initial(T0)).toThrowError(
      expect.objectContaining({ name: 'PhysicsStepError', pluginId: 'test-road' }),
    );
  });
});
