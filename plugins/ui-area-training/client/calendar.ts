// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CompletedWorkout, PlannedWorkout, Workout as CanonicalWorkout } from '@ridrs/contracts';

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

/** Moves an entry to another day of the week. */
export function moveEntry(calendar: Calendar, id: string, day: Weekday): Calendar {
  return change(
    calendar,
    calendar.entries.map((entry) => (entry.id === id ? { ...entry, day } : entry)),
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

/** The date `days` after (or before) a date, both `YYYY-MM-DD`. */
export function addDays(date: string, days: number): string {
  const [year = 0, month = 1, d = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, d + days)).toISOString().slice(0, 10);
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

/** Rides this close in time, of the same sport, are one ride seen by two providers. */
const SAME_RIDE_MS = 5 * 60_000;

const sameRide = (a: CompletedWorkout, b: CompletedWorkout): boolean =>
  (a.externalId !== undefined && a.externalId === b.externalId) ||
  (a.externalId === undefined &&
    b.externalId === undefined &&
    a.sport === b.sport &&
    a.startedAt !== undefined &&
    b.startedAt !== undefined &&
    Math.abs(a.startedAt - b.startedAt) < SAME_RIDE_MS);

/**
 * The rides of every provider as one list, oldest first (ADR 0076). A ride two providers know
 * is listed once, with what the richer of the two (the one with a training load) has, and the
 * session id of either.
 */
export function mergeCompleted(lists: readonly (readonly CompletedWorkout[])[]): CompletedWorkout[] {
  const merged: CompletedWorkout[] = [];
  for (const ride of lists.flat()) {
    const at = merged.findIndex((known) => sameRide(known, ride));
    const known = merged[at];
    if (known === undefined) {
      merged.push(ride);
      continue;
    }
    const [richer, other] = ride.trainingLoad !== undefined && known.trainingLoad === undefined ? [ride, known] : [known, ride];
    merged[at] = { ...other, ...richer, ...(richer.externalId ?? other.externalId ? { externalId: richer.externalId ?? other.externalId } : {}) } as CompletedWorkout;
  }
  return merged.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.date.localeCompare(b.date));
}

/** What a day of the calendar lists: an entry of the chosen calendar. */
export interface PlannedItem {
  readonly id: string;
  /** What the list keys the entry by: a planned workout keeps the key of its pending entry, so the one entry updates in place. */
  readonly key: string;
  readonly kind: EntryKind;
  readonly title: string;
  readonly detail?: string;
  /** What the matching of a day with its rides compares, where the provider has it. */
  readonly durationSeconds?: number;
  readonly trainingLoad?: number;
  /** What the calendar draws as a micro chart: the workout's structure, when the provider has it. */
  readonly chart?: CanonicalWorkout;
  /** Shown at once, not yet taken by the calendar's provider. */
  readonly pending?: true;
}

/** A plan or a move the rider made, shown at once until the calendar's provider has it. */
export interface Pending {
  readonly key: number;
  readonly date: string;
  readonly title: string;
  /** The entry being moved; none for a plan. */
  readonly moving?: string;
  /** The ids the provider's calendar held on the date when a plan was made: a new one is the plan's entry. */
  readonly before?: readonly string[];
}

type Listed = { readonly id: string; readonly date: string; readonly name: string };

/** The entry of the provider's calendar that a change is about, once it is there. */
export function arrivedEntry(change: Pending, workouts: readonly Listed[]): Listed | undefined {
  return change.moving !== undefined
    ? workouts.find((workout) => workout.id === change.moving && workout.date === change.date)
    : workouts.find(
        (workout) => workout.date === change.date && workout.name === change.title && !(change.before ?? []).includes(workout.id),
      );
}

/**
 * The entries of a day with the unanswered changes applied, so a drop shows at once: a plan or a
 * move to this `date` is listed as pending, and an entry being moved is gone from where it was.
 * `claims` gives the entry a plan became (by its id) the key of the pending entry it was: the
 * rider sees one entry that is updated, not one that is replaced.
 */
export function withPending(
  entries: readonly Omit<PlannedItem, 'key'>[],
  date: string,
  pending: readonly Pending[],
  claims: ReadonlyMap<string, string> = new Map(),
): PlannedItem[] {
  const moving = new Set(pending.flatMap((change) => (change.moving === undefined ? [] : [change.moving])));
  return [
    ...entries
      .filter((entry) => !moving.has(entry.id))
      .map((entry): PlannedItem => ({ ...entry, key: claims.get(entry.id) ?? entry.id })),
    ...pending
      .filter((change) => change.date === date)
      .map(
        (change): PlannedItem => ({
          id: change.moving ?? `pending-${change.key}`,
          key: change.moving ?? `pending-${change.key}`,
          kind: 'workout',
          title: change.title,
          pending: true,
        }),
      ),
  ];
}

/** The month `months` after (or before) a month, both `YYYY-MM`. */
export function addMonths(month: string, months: number): string {
  const [year = 0, m = 1] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m - 1 + months, 1)).toISOString().slice(0, 7);
}

/**
 * The days the large calendar shows for a month (`YYYY-MM`): whole weeks, Monday first, from the
 * week that holds its first day to the week that holds its last.
 */
export function monthDays(month: string): string[] {
  const first = `${month}-01`;
  const last = addDays(`${addMonths(month, 1)}-01`, -1);
  const days: string[] = [];
  for (let date = weekDate('Monday', first); date <= weekDate('Sunday', last); date = addDays(date, 1)) {
    days.push(date);
  }
  return days;
}

/** A planned workout as the matching of a day sees it. */
export interface PlannedOfDay {
  readonly key: string;
  readonly title: string;
  readonly durationSeconds?: number;
  readonly trainingLoad?: number;
  readonly pending?: true;
}

/** "Sweet Spot 3x12" for "sweet spot 3×12 ": names compared by what they say. */
const normalName = (name: string) =>
  name
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** How far apart two values may be, relatively, and still be the same workout. */
const DURATION_TOLERANCE = 0.1;
const LOAD_TOLERANCE = 0.15;

const near = (a: number | undefined, b: number | undefined, tolerance: number) =>
  a !== undefined && b !== undefined && a > 0 && b > 0 && Math.abs(a - b) <= tolerance * Math.max(a, b);

/** A ride done as a plan of its day: by its name, or by its duration and load where both are known. */
const ridden = (plan: PlannedOfDay, ride: CompletedWorkout): boolean =>
  (normalName(plan.title) !== '' && normalName(plan.title) === normalName(ride.name)) ||
  (near(plan.durationSeconds, ride.durationSeconds, DURATION_TOLERANCE) &&
    near(plan.trainingLoad, ride.trainingLoad, LOAD_TOLERANCE));

/**
 * The rides of a day paired with the plans of the same day they did: a plan that was ridden is
 * listed once, as a done ride (ADR 0076). A ride matches by its name first, then by its duration
 * and load; each plan and each ride is paired at most once, and a plan not yet kept by its
 * provider is never paired.
 */
export function matchDone<P extends PlannedOfDay>(
  plans: readonly P[],
  rides: readonly CompletedWorkout[],
): { readonly open: P[]; readonly done: { readonly ride: CompletedWorkout; readonly plan?: P }[] } {
  const taken = new Set<string>();
  const pairs = new Map<string, P>();
  for (const byName of [true, false]) {
    for (const ride of rides) {
      if (pairs.has(ride.id)) continue;
      const plan = plans.find(
        (candidate) =>
          !candidate.pending &&
          !taken.has(candidate.key) &&
          (byName ? normalName(candidate.title) === normalName(ride.name) && normalName(ride.name) !== '' : ridden(candidate, ride)),
      );
      if (plan) {
        taken.add(plan.key);
        pairs.set(ride.id, plan);
      }
    }
  }
  return {
    open: plans.filter((plan) => !taken.has(plan.key)),
    done: rides.map((ride) => {
      const plan = pairs.get(ride.id);
      return plan ? { ride, plan } : { ride };
    }),
  };
}
