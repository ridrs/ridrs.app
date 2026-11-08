// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  addEntry,
  FIRST_WEEK,
  moveLater,
  plannedWorkouts,
  removeEntry,
  UNDO_DEPTH,
  undo,
  weekdayOf,
  weekDate,
  nextDate,
} from './calendar.ts';

const titlesOn = (calendar: typeof FIRST_WEEK, day: string) =>
  calendar.entries.filter((entry) => entry.day === day).map((entry) => entry.title);

describe('the calendar', () => {
  it('adds, moves and removes entries, and undoes each change', () => {
    const added = addEntry(FIRST_WEEK, { day: 'Wednesday', kind: 'rest', title: 'Rest day' });
    expect(titlesOn(added, 'Wednesday')).toEqual(['Rest day']);
    const id = added.entries.at(-1)?.id ?? '';
    const moved = moveLater(added, id);
    expect(titlesOn(moved, 'Thursday')).toEqual(['VO2 Max 5×4', 'Rest day']);
    const removed = removeEntry(moved, id);
    expect(titlesOn(removed, 'Thursday')).toEqual(['VO2 Max 5×4']);
    expect(undo(undo(undo(removed)))).toEqual(FIRST_WEEK);
  });

  it('keeps Sunday on Sunday and does nothing to undo without a change', () => {
    expect(titlesOn(moveLater(FIRST_WEEK, 'seed-4'), 'Sunday')).toEqual(['Outdoor ride']);
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

describe('the next date of a weekday', () => {
  it('is today or a later day of this week, else the day of next week', () => {
    expect(nextDate('Wednesday', '2026-11-04')).toBe('2026-11-04');
    expect(nextDate('Thursday', '2026-11-04')).toBe('2026-11-05');
    expect(nextDate('Tuesday', '2026-11-04')).toBe('2026-11-10');
  });
});
