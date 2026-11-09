// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  addDays,
  addEntry,
  arrivedEntry,
  FIRST_WEEK,
  mergeCompleted,
  withPending,
  moveEntry,
  plannedWorkouts,
  removeEntry,
  UNDO_DEPTH,
  undo,
  weekdayOf,
  weekDate,
} from './calendar.ts';

const titlesOn = (calendar: typeof FIRST_WEEK, day: string) =>
  calendar.entries.filter((entry) => entry.day === day).map((entry) => entry.title);

describe('the calendar', () => {
  it('adds, moves and removes entries, and undoes each change', () => {
    const added = addEntry(FIRST_WEEK, { day: 'Wednesday', kind: 'rest', title: 'Rest day' });
    expect(titlesOn(added, 'Wednesday')).toEqual(['Rest day']);
    const id = added.entries.at(-1)?.id ?? '';
    const moved = moveEntry(added, id, 'Thursday');
    expect(titlesOn(moved, 'Thursday')).toEqual(['VO2 Max 5×4', 'Rest day']);
    const removed = removeEntry(moved, id);
    expect(titlesOn(removed, 'Thursday')).toEqual(['VO2 Max 5×4']);
    expect(undo(undo(undo(removed)))).toEqual(FIRST_WEEK);
  });

  it('moves an entry to any day of the week, and does nothing to undo without a change', () => {
    expect(titlesOn(moveEntry(FIRST_WEEK, 'seed-4', 'Monday'), 'Monday')).toEqual(['Outdoor ride']);
    expect(undo(FIRST_WEEK)).toBe(FIRST_WEEK);
  });

  it('gives new entries unused ids and remembers a limited number of changes', () => {
    let calendar = FIRST_WEEK;
    for (let i = 0; i < UNDO_DEPTH + 3; i += 1) {
      calendar = addEntry(calendar, { day: 'Monday', kind: 'note', title: 'Note' });
    }
    expect(new Set(calendar.entries.map((e) => e.id)).size).toBe(calendar.entries.length);
    expect(calendar.undo).toHaveLength(UNDO_DEPTH);
  });

  it('starts the week on Monday', () => {
    expect(weekdayOf(new Date(2026, 10, 2))).toBe('Monday');
    expect(weekdayOf(new Date(2026, 10, 8))).toBe('Sunday');
  });
});

describe('the planned workouts of the calendar', () => {
  it('puts the workouts of the week on their dates from today on, and leaves other entries out', () => {
    // Wednesday 4 November 2026: Tuesday's workout is past, Sunday's outdoor ride is no workout.
    const entries = [
      { id: 'entry-1', day: 'Tuesday', kind: 'workout', title: 'Past' },
      { id: 'entry-2', day: 'Thursday', kind: 'workout', title: 'Threshold' },
      { id: 'entry-3', day: 'Sunday', kind: 'outdoor', title: 'Outdoor ride' },
    ] as const;
    expect(plannedWorkouts(entries, '2026-11-04')).toEqual([
      { id: 'entry-2', date: '2026-11-05', name: 'Threshold', sport: 'ride', steps: [] },
    ]);
  });

  it('leaves out the sample entries the area starts with', () => {
    expect(plannedWorkouts(FIRST_WEEK.entries, '2026-11-02')).toEqual([]);
  });

  it('keeps the workouts of today, and orders them by date', () => {
    const entries = [
      { id: 'b', day: 'Sunday', kind: 'workout', title: 'B' },
      { id: 'a', day: 'Monday', kind: 'workout', title: 'A' },
    ] as const;
    expect(plannedWorkouts(entries, '2026-11-02').map((w) => [w.date, w.name])).toEqual([
      ['2026-11-02', 'A'],
      ['2026-11-08', 'B'],
    ]);
    expect(plannedWorkouts(entries, '2026-11-08').map((w) => w.name)).toEqual(['B']);
  });
});

describe('the date of a weekday', () => {
  it('is the day of the week that holds today, Monday first', () => {
    expect(weekDate('Monday', '2026-11-04')).toBe('2026-11-02');
    expect(weekDate('Thursday', '2026-11-04')).toBe('2026-11-05');
    expect(weekDate('Sunday', '2026-11-08')).toBe('2026-11-08');
    expect(weekDate('Monday', '2026-11-08')).toBe('2026-11-02');
  });
});

describe('the rides that were done', () => {
  const ride = (id: string, startedAt: number, extra: object = {}) => ({
    id,
    date: '2026-11-04',
    startedAt,
    name: 'Ride',
    sport: 'virtual-ride' as const,
    ...extra,
  });

  it('lists a ride once when two providers know it by the session id', () => {
    const local = ride('s1', 1000, { externalId: 'session-1' });
    const service = ride('a9', 90_000_000, { name: 'Sweet Spot', trainingLoad: 70, externalId: 'session-1' });
    expect(mergeCompleted([[local], [service]])).toEqual([service]);
  });

  it('lists rides without an id once when they start within five minutes', () => {
    const merged = mergeCompleted([[ride('a', 0)], [ride('b', 120_000, { trainingLoad: 50 })]]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.trainingLoad).toBe(50);
  });

  it('keeps rides that are apart and lists them oldest first', () => {
    const merged = mergeCompleted([[ride('late', 3_600_000)], [ride('early', 0)]]);
    expect(merged.map((r) => r.id)).toEqual(['early', 'late']);
  });
});

describe('adding days', () => {
  it('counts across months and years, forwards and back', () => {
    expect(addDays('2026-11-04', 7)).toBe('2026-11-11');
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-01-02', -7)).toBe('2025-12-26');
  });
});

describe('changes the provider has not answered', () => {
  const entry = { id: 'e1', kind: 'workout' as const, title: 'Threshold 20' };

  it('lists a plan on its day at once, marked as pending', () => {
    const listed = withPending([entry], '2026-11-05', [{ key: 1, date: '2026-11-05', title: 'Recovery Spin' }]);
    expect(listed.map((item) => [item.title, item.pending])).toEqual([['Threshold 20', undefined], ['Recovery Spin', true]]);
    expect(withPending([entry], '2026-11-06', [{ key: 1, date: '2026-11-05', title: 'Recovery Spin' }])).toEqual([{ ...entry, key: 'e1' }]);
  });

  it('moves an entry on screen: gone from its day, pending on the new one', () => {
    const move = { key: 2, date: '2026-11-07', title: 'Threshold 20', moving: 'e1' };
    expect(withPending([entry], '2026-11-05', [move])).toEqual([]);
    expect(withPending([], '2026-11-07', [move])).toEqual([
      { id: 'e1', key: 'e1', kind: 'workout', title: 'Threshold 20', pending: true },
    ]);
  });

  it('gives the entry a plan became the key of its pending entry, so the list updates one entry', () => {
    const claims = new Map([['e9', 'pending-1']]);
    const planned = { id: 'e9', kind: 'workout' as const, title: 'Recovery Spin' };
    const [pending] = withPending([], '2026-11-05', [{ key: 1, date: '2026-11-05', title: 'Recovery Spin' }]);
    const [real] = withPending([planned], '2026-11-05', [], claims);
    expect(real?.key).toBe(pending?.key);
  });
});

describe('a change that arrived', () => {
  const workouts = [{ id: 'e1', date: '2026-11-07', name: 'Threshold 20' }];

  it('is a move once the entry is on its new day', () => {
    expect(arrivedEntry({ key: 1, date: '2026-11-07', title: 'Threshold 20', moving: 'e1' }, workouts)?.id).toBe('e1');
    expect(arrivedEntry({ key: 1, date: '2026-11-08', title: 'Threshold 20', moving: 'e1' }, workouts)).toBeUndefined();
  });

  it('is a plan once the day holds an entry of that name that it did not hold before', () => {
    const plan = { key: 2, date: '2026-11-07', title: 'Threshold 20', before: ['e1'] };
    expect(arrivedEntry(plan, workouts)).toBeUndefined();
    expect(arrivedEntry(plan, [...workouts, { id: 'e2', date: '2026-11-07', name: 'Threshold 20' }])?.id).toBe('e2');
  });
});
