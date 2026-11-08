// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PlannedWorkout } from '@ridrs/contracts';

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

/** The title an entry of a kind is kept with; the page shows the kind in the rider's language. */
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

/** The date of a weekday in the week that holds `today` (`YYYY-MM-DD`), Monday first. */
export function weekDate(day: Weekday, today: string): string {
  const [year = 0, month = 1, d = 1] = today.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, d));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + WEEKDAYS.indexOf(day));
  return date.toISOString().slice(0, 10);
}

/** The next date of a weekday from `today` on (`YYYY-MM-DD`): this week's, else next week's. */
export function nextDate(day: Weekday, today: string): string {
  const date = weekDate(day, today);
  if (date >= today) return date;
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 7);
  return next.toISOString().slice(0, 10);
}

/** The rider's local date, `YYYY-MM-DD`. */
export function localToday(at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * The workouts of the calendar as the data type `training.calendar` has them (ADR 0075): the
 * entries of kind workout, each on its day of the week that holds `today` (`YYYY-MM-DD`, Monday
 * first), from today on. Rest days, notes and outdoor rides are no planned workouts, nor are the
 * sample entries the area starts with (`FIRST_WEEK`): the rider did not plan them. The entries
 * have no steps.
 */
export function plannedWorkouts(entries: readonly Entry[], today: string): PlannedWorkout[] {
  const samples = new Set(FIRST_WEEK.entries.map((entry) => entry.id));
  return entries
    .filter((entry) => entry.kind === 'workout' && !samples.has(entry.id))
    .map((entry) => ({ entry, date: weekDate(entry.day, today) }))
    .filter(({ date }) => date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ entry, date }) => ({
      id: entry.id,
      date,
      name: entry.title,
      sport: 'ride' as const,
      steps: [],
    }));
}
