// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout, WorkoutDuration, WorkoutStep } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { durationOf, segmentAt, workoutTimeline } from './timeline.ts';

const workout = (steps: WorkoutStep[]): Workout => ({
  format: 'ridrs-workout',
  version: 1,
  id: 'w',
  name: 'W',
  sport: 'ride',
  source: { kind: 'user' },
  steps,
});

const step = (id: string, seconds: number): WorkoutStep => ({
  kind: 'interval',
  id,
  duration: { kind: 'time', seconds },
  effort: { kind: 'free' },
});

describe('workoutTimeline', () => {
  it('unrolls nested repeats with the round of each level, outermost first', () => {
    // 2 × [ 3 × (a 10 s), b 5 s ]: 2 × 35 s = 70 s
    const timeline = workoutTimeline(
      workout([
        {
          kind: 'repeat',
          id: 'o',
          until: { kind: 'count', reps: 2 },
          steps: [
            { kind: 'repeat', id: 'i', until: { kind: 'count', reps: 3 }, steps: [step('a', 10)] },
            step('b', 5),
          ],
        },
      ]),
    );
    expect(timeline.durationSeconds).toBe(70);
    expect(timeline.segments).toHaveLength(8);
    expect(timeline.segments[4]).toMatchObject({
      index: 4,
      stepId: 'a',
      startSeconds: 35,
      repeats: [
        { repeatId: 'o', iteration: 2, count: 2 },
        { repeatId: 'i', iteration: 1, count: 3 },
      ],
    });
  });

  it('keeps name, intensity and cues of the step', () => {
    const cues = [{ offsetSeconds: 5, text: 'Spin up' }];
    const [segment] = workoutTimeline(
      workout([{ ...step('a', 60), name: 'Go', intensity: 'interval', cues } as WorkoutStep]),
    ).segments;
    expect(segment).toMatchObject({ name: 'Go', intensity: 'interval', cues });
  });

  it('is empty for a workout without steps', () => {
    expect(workoutTimeline(workout([]))).toEqual({
      segments: [],
      durationSeconds: 0,
      estimated: false,
    });
  });

  it('takes other assumptions as parameters', () => {
    const distance: WorkoutDuration = { kind: 'distance', meters: 1000 };
    expect(durationOf(distance, { speedMetersPerSecond: 10 })).toEqual({
      seconds: 100,
      estimated: true,
    });
    // 30 kcal ≈ 30 kJ at 300 W: 100 s
    expect(durationOf({ kind: 'energy', kilocalories: 30 }, { energyWatts: 300 }).seconds).toBe(
      100,
    );
    expect(durationOf({ kind: 'open' }, { openSeconds: 60 }).seconds).toBe(60);
  });
});

describe('segmentAt', () => {
  const timeline = workoutTimeline(workout([step('a', 10), step('zero', 0), step('b', 10)]));

  it('passes over a step of no length', () => {
    expect(segmentAt(timeline, 10)?.segment.stepId).toBe('b');
    expect(segmentAt(timeline, 9.5)).toMatchObject({
      segment: { stepId: 'a' },
      offsetSeconds: 9.5,
      remainingSeconds: 0.5,
    });
  });

  it('knows nothing before the start, from the end on, or of an empty workout', () => {
    expect(segmentAt(timeline, -1)).toBeUndefined();
    expect(segmentAt(timeline, 20)).toBeUndefined();
    expect(segmentAt(workoutTimeline(workout([])), 0)).toBeUndefined();
  });
});
