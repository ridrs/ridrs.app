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
    expect(plannedWorkouts(FIRST_WEEK.entries, '2026-11-04')).toEqual([
      { id: 'seed-2', date: '2026-11-05', name: 'VO2 Max 5×4', sport: 'ride', steps: [] },
      { id: 'seed-3', date: '2026-11-07', name: 'Endurance 90', sport: 'ride', steps: [] },
    ]);
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
