// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { trainingCalendarState, trainingServiceSchema } from './training.ts';

describe('the training service', () => {
  it('is any provider id, not a closed list', () => {
    expect(trainingServiceSchema.parse('intervals.icu')).toBe('intervals.icu');
    expect(trainingServiceSchema.parse('other-service')).toBe('other-service');
    expect(trainingServiceSchema.safeParse('Not A Provider').success).toBe(false);
  });
});

describe('the training calendar', () => {
  it('is a data type keyed by the provider', () => {
    expect(trainingCalendarState.id).toBe('training.calendar');
  });
});
