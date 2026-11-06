// SPDX-License-Identifier: AGPL-3.0-or-later

export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export type EntryKind = 'workout' | 'rest' | 'note' | 'outdoor';

/** One entry of this week's calendar. Placeholders of the early alpha: one week, no dates kept. */
export interface Entry {
  readonly id: string;
  readonly day: Weekday;
  readonly kind: EntryKind;
  readonly title: string;
}

/** The calendar and the states before its last changes, newest last, so Undo survives a restart. */
export interface Calendar {
  readonly entries: readonly Entry[];
  readonly undo: readonly (readonly Entry[])[];
}

/** How many changes Undo can take back. */
export const UNDO_DEPTH = 10;

export interface Workout {
  readonly id: string;
  readonly name: string;
  readonly minutes: number;
  readonly tss: number;
  readonly zone: string;
}

export const WORKOUTS: readonly Workout[] = [
  { id: 'sweet-spot', name: 'Sweet Spot 3×12', minutes: 60, tss: 75, zone: 'Sweet spot' },
  { id: 'vo2-max', name: 'VO2 Max 5×4', minutes: 55, tss: 70, zone: 'VO2 max' },
  { id: 'endurance', name: 'Endurance 90', minutes: 90, tss: 65, zone: 'Endurance' },
  { id: 'recovery', name: 'Recovery Spin', minutes: 40, tss: 20, zone: 'Recovery' },
];

export const FIRST_WEEK: Calendar = {
  entries: [
    { id: 'seed-1', day: 'Tuesday', kind: 'workout', title: 'Sweet Spot 3×12' },
    { id: 'seed-2', day: 'Thursday', kind: 'workout', title: 'VO2 Max 5×4' },
    { id: 'seed-3', day: 'Saturday', kind: 'workout', title: 'Endurance 90' },
    { id: 'seed-4', day: 'Sunday', kind: 'outdoor', title: 'Outdoor ride' },
  ],
  undo: [],
};

/** The title an entry of a kind gets when it is added without one. */
export const KIND_TITLES: Readonly<Record<Exclude<EntryKind, 'workout'>, string>> = {
  rest: 'Rest day',
  note: 'Note',
  outdoor: 'Outdoor ride',
};

const change = (calendar: Calendar, entries: readonly Entry[]): Calendar => ({
  entries,
  undo: [...calendar.undo, calendar.entries].slice(-UNDO_DEPTH),
});

/** Adds an entry with an id that no entry of the calendar has yet. */
export function addEntry(calendar: Calendar, entry: Omit<Entry, 'id'>): Calendar {
  const taken = new Set(calendar.entries.map((e) => e.id));
  let n = calendar.entries.length + calendar.undo.length + 1;
  while (taken.has(`entry-${n}`)) n += 1;
  return change(calendar, [...calendar.entries, { ...entry, id: `entry-${n}` }]);
}

export function removeEntry(calendar: Calendar, id: string): Calendar {
  return change(
    calendar,
    calendar.entries.filter((entry) => entry.id !== id),
  );
}

/** Moves an entry one day later; Sunday's stays. */
export function moveLater(calendar: Calendar, id: string): Calendar {
  return change(
    calendar,
    calendar.entries.map((entry) => {
      const next = WEEKDAYS[WEEKDAYS.indexOf(entry.day) + 1];
      return entry.id === id && next ? { ...entry, day: next } : entry;
    }),
  );
}

/** The calendar before its last change; unchanged without one. */
export function undo(calendar: Calendar): Calendar {
  const previous = calendar.undo.at(-1);
  return previous ? { entries: previous, undo: calendar.undo.slice(0, -1) } : calendar;
}

/** Today's weekday in the local time zone. */
export function weekdayOf(date: Date): Weekday {
  return WEEKDAYS[(date.getDay() + 6) % 7] ?? 'Monday';
}
