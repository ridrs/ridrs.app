// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  libraryWorkoutSchema,
  plannedWorkoutSchema,
  trainingCalendarState,
  trainingServiceSchema,
} from './training.ts';

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

describe('planned and library workouts', () => {
  it('remember the library workout an entry was planned from', () => {
    const entry = {
      id: 'e1',
      date: '2026-11-12',
      name: 'Sweet Spot',
      sport: 'ride' as const,
      steps: [],
      library: { from: 'ridrs', workoutId: 'sweet-spot-3x12' },
    };
    expect(plannedWorkoutSchema.parse(entry)).toEqual(entry);
    expect(libraryWorkoutSchema.safeParse({ ...entry, date: undefined }).success).toBe(false);
  });

  it('carry the whole canonical workout where the provider has it', () => {
    const workout = {
      format: 'ridrs-workout' as const,
      version: 1 as const,
      id: 'w',
      name: 'W',
      sport: 'ride' as const,
      author: 'ridrs',
      license: 'CC-BY-SA-4.0',
      source: { kind: 'builtin' as const },
      steps: [],
    };
    const entry = { id: 'w', name: 'W', sport: 'ride' as const, steps: [], workout };
    expect(libraryWorkoutSchema.parse(entry)).toEqual(entry);
  });
});
