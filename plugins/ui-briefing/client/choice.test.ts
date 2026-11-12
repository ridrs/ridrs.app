// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RideWorkout, Workout } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { lengthNote, rememberedChoice, resolveForRide, startingAnswers } from './choice.ts';

const workout = (percent: number): Workout => ({
  format: 'ridrs-workout',
  version: 1,
  id: 'w',
  name: 'W',
  sport: 'virtual-ride',
  source: { kind: 'provider' },
  steps: [
    {
      kind: 'interval',
      id: '1',
      intensity: 'interval',
      duration: { kind: 'time', seconds: 600 },
      effort: { kind: 'target', primary: { unit: 'percent-ftp', start: { low: percent, high: percent } } },
    },
  ],
});
const ride = (percent: number): RideWorkout => ({ workout: workout(percent) });

describe('startingAnswers', () => {
  it('asks for everything while nothing is remembered or fixed', () => {
    expect(startingAnswers({}, {}).answers).toEqual({ world: undefined, workout: undefined });
  });

  it('takes a remembered free ride as an answer, not as nothing', () => {
    const { answers } = startingAnswers({ workout: { kind: 'none' } }, {});
    expect(answers).toEqual({ world: null, workout: { kind: 'none' } });
  });

  it('lets what the way in fixed win over what was remembered', () => {
    const { answers, fixed } = startingAnswers(
      { world: { landscape: 'a' }, workout: { kind: 'none' } },
      { world: { landscape: 'b' } },
    );
    expect(answers.world).toEqual({ landscape: 'b' });
    expect(fixed).toEqual({ world: true, workout: false });
  });
});

describe('resolveForRide', () => {
  it('turns 90 % at an FTP of 250 W into 225 W', () => {
    const resolved = resolveForRide(ride(90), { ftp: 250 });
    expect(resolved.ok && JSON.stringify(resolved.ride.workout.steps)).toContain('"unit":"watts","start":{"low":225,"high":225}');
  });

  it('refuses a % FTP workout without an FTP', () => {
    expect(resolveForRide(ride(90), {})).toEqual({ ok: false, refusal: 'no-ftp' });
  });
});

describe('rememberedChoice', () => {
  it('remembers a planned entry as its library workout, or as none', () => {
    const planned = { state: 'found', ride: { ...ride(90), planned: { provider: 'p', id: '1' } } } as const;
    expect(rememberedChoice(undefined, planned, undefined).workout).toEqual({ kind: 'none' });
    const withLibrary = {
      state: 'found',
      ride: { ...planned.ride, library: { from: 'ridrs', workoutId: 'w' } },
    } as const;
    expect(rememberedChoice(undefined, withLibrary, undefined).workout).toEqual({
      kind: 'library',
      from: 'ridrs',
      workoutId: 'w',
    });
  });
});

describe('lengthNote', () => {
  it('notes which of the two lasts longer when they differ much', () => {
    expect(lengthNote(60 * 60, 35 * 60)).toBe('workout-longer');
    expect(lengthNote(30 * 60, 90 * 60)).toBe('route-longer');
  });

  it('says nothing for similar or unknown lengths', () => {
    expect(lengthNote(60 * 60, 55 * 60)).toBeUndefined();
    expect(lengthNote(60 * 60, undefined)).toBeUndefined();
  });
});
