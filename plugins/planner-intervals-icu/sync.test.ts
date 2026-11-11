// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LibraryWorkout } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { eventContent, eventHash, sourceHash, workoutOf } from './sync.ts';

const entry: LibraryWorkout = {
  id: 'sweet-spot',
  name: 'Sweet Spot',
  sport: 'virtual-ride',
  durationSeconds: 900,
  steps: [
    {
      kind: 'interval',
      id: '1',
      duration: { kind: 'time', seconds: 600 },
      effort: { kind: 'target', primary: { unit: 'percent-ftp', start: { low: 90, high: 90 } } },
    },
    { kind: 'interval', id: '2', duration: { kind: 'time', seconds: 300 }, effort: { kind: 'free' } },
  ],
};

describe('eventContent', () => {
  it('sends the content as intervals.icu text after the description by default', () => {
    expect(eventContent({ ...entry, description: 'Hold it.' }, 'description', () => undefined)).toEqual({
      name: 'Sweet Spot',
      type: 'VirtualRide',
      moving_time: 900,
      description: 'Hold it.\n\n- 10m 90%\n- 5m freeride',
    });
  });

  it('sends a workout document when switched to it', () => {
    expect(eventContent(entry, 'workout_doc', () => undefined)).toEqual({
      name: 'Sweet Spot',
      type: 'VirtualRide',
      moving_time: 900,
      workout_doc: { steps: [{ duration: 600, power: { units: '%ftp', value: 90 } }, { duration: 300, freeride: true }] },
    });
  });

  it('sends the name and the length only for a workout without steps', () => {
    expect(eventContent({ ...entry, steps: [] }, 'description', () => undefined)).toEqual({
      name: 'Sweet Spot',
      type: 'VirtualRide',
      moving_time: 900,
    });
  });

  it('hands what cannot be expressed to the log', () => {
    const logged: string[] = [];
    eventContent(
      { ...entry, steps: [{ kind: 'interval', id: '1', duration: { kind: 'energy', kilocalories: 9 }, effort: { kind: 'free' } }] },
      'description',
      (diagnostics) => logged.push(...diagnostics.map((d) => d.code)),
    );
    expect(logged).toEqual(['duration-not-expressible']);
  });
});

describe('hashes', () => {
  const event = { id: 1, name: 'A', description: '- 10m 90%', start_date_local: '2026-11-05T00:00:00' };

  it('ignore the day, the order of keys and what intervals.icu fills in itself', () => {
    const doc = { steps: [{ duration: 60, power: { units: '%ftp', value: 90 } }] };
    const resolved = { steps: [{ power: { value: 90, units: '%ftp' }, duration: 60, _power: { value: 225 } }] };
    expect(eventHash({ ...event, start_date_local: '2026-11-07T00:00:00' }, 'description')).toBe(eventHash(event, 'description'));
    expect(eventHash({ ...event, workout_doc: resolved }, 'workout_doc')).toBe(eventHash({ ...event, workout_doc: doc }, 'workout_doc'));
  });

  it('change with what the rider can change in intervals.icu', () => {
    expect(eventHash({ ...event, description: '- 20m 60%' }, 'description')).not.toBe(eventHash(event, 'description'));
    expect(eventHash({ ...event, name: 'B' }, 'description')).not.toBe(eventHash(event, 'description'));
    const doc = (value: number) => ({ steps: [{ duration: 60, power: { units: '%ftp', value } }] });
    expect(eventHash({ ...event, workout_doc: doc(80) }, 'workout_doc')).not.toBe(eventHash({ ...event, workout_doc: doc(90) }, 'workout_doc'));
    // With the description sent, intervals.icu's own reading of it is no change of the rider.
    expect(eventHash({ ...event, workout_doc: doc(80) }, 'description')).toBe(eventHash(event, 'description'));
  });

  it('of a library workout change with its content only', () => {
    expect(sourceHash({ ...entry, folder: 'Base' })).toBe(sourceHash(entry));
    expect(sourceHash({ ...entry, name: 'Other' })).not.toBe(sourceHash(entry));
    expect(sourceHash({ ...entry, steps: entry.steps.slice(1) })).not.toBe(sourceHash(entry));
  });
});

describe('workoutOf', () => {
  it('makes a canonical workout of the steps where the entry has none', () => {
    expect(workoutOf(entry)).toMatchObject({ format: 'ridrs-workout', id: 'sweet-spot', steps: entry.steps });
  });
});
