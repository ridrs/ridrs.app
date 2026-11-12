// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RecordingEvent, RideWorkout } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { workoutOf } from './index.ts';

const workout: RideWorkout = {
  workout: {
    format: 'ridrs-workout',
    version: 1,
    id: 'ss',
    name: 'Sweet Spot',
    sport: 'virtual-ride',
    source: { kind: 'user' },
    steps: [],
  },
  planned: { provider: 'intervals', id: 'evt-7' },
};

const event = (seq: number, type: string, payload: unknown): RecordingEvent => ({
  kind: 'event',
  seq,
  preroll: false,
  envelope: { id: `e${seq}`, type, source: 'activity-session', timestamp: seq, payload },
});

describe('workoutOf', () => {
  it('finds the workout of the ride in its activity states', () => {
    const events = [
      event(1, 'activity.state-changed', { state: 'idle' }),
      event(2, 'physics.state', {}),
      event(3, 'activity.state-changed', { state: 'running', sessionId: 's', startedAt: 0, workout }),
    ];
    expect(workoutOf({ events })).toEqual(workout);
  });

  it('finds none for a ride without a workout, or a state it cannot read', () => {
    expect(
      workoutOf({
        events: [
          event(1, 'activity.state-changed', { state: 'running', sessionId: 's', startedAt: 0 }),
          event(2, 'activity.state-changed', { state: 'running', workout: 'broken' }),
        ],
      }),
    ).toBeUndefined();
  });
});
