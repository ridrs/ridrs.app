// SPDX-License-Identifier: AGPL-3.0-or-later

import { PhysicsStepError, type ResistanceProvider } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { totalResistance } from './total-resistance.ts';

const input = { at: 0, speed: 10, mass: 85 };

function constant(source: string, force: number): ResistanceProvider {
  return { source, force: () => force };
}

describe('totalResistance', () => {
  it('sums signed forces', () => {
    const result = totalResistance([constant('b', 20), constant('a', -5)], input);
    expect(result.total).toBe(15);
  });

  it('lists contributions sorted by source, whatever the registration order', () => {
    const forward = totalResistance([constant('b', 2), constant('a', 1)], input);
    const reverse = totalResistance([constant('a', 1), constant('b', 2)], input);
    expect(forward).toEqual(reverse);
    expect(forward.contributions.map((c) => c.source)).toEqual(['a', 'b']);
  });

  it('is 0 without any resistance', () => {
    expect(totalResistance([], input)).toEqual({ total: 0, contributions: [] });
  });

  it('fails the step naming a provider that throws', () => {
    const broken: ResistanceProvider = {
      source: 'broken',
      force: () => {
        throw new Error('boom');
      },
    };
    expect(() => totalResistance([constant('a', 1), broken], input)).toThrowError(
      expect.objectContaining({ name: 'PhysicsStepError', pluginId: 'broken' }),
    );
  });

  it('fails the step naming a provider that returns a non-finite force', () => {
    try {
      totalResistance([constant('nan', Number.NaN)], input);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PhysicsStepError);
      expect((error as PhysicsStepError).pluginId).toBe('nan');
    }
  });
});
