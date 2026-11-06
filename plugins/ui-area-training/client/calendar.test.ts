// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { addEntry, FIRST_WEEK, moveLater, removeEntry, UNDO_DEPTH, undo, weekdayOf } from './calendar.ts';

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
