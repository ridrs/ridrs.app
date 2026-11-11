// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AthleteProfile,
  type DataSource,
  type DataSourceChoice,
  DEFAULT_PROVIDER,
  type LibraryWorkout,
  type PlannedWorkout,
  type TrainingCalendar,
  WORKOUT_FORMAT,
  WORKOUT_FORMAT_VERSION,
  type Workout,
  type WorkoutEditorSubject,
} from '@ridrs/contracts';
import type { WorkoutAthlete } from '@ridrs/workout';

/** The library the editor saves to (structured-workouts.md, section 12). */
export const OWN_LIBRARY = 'ridrs';

export type Library = DataSource<{ readonly workouts: readonly LibraryWorkout[] }>;

export type Source =
  | { readonly state: 'ready'; readonly workout: Workout }
  | { readonly state: 'loading' }
  | { readonly state: 'missing' };

/** A canonical workout from a library entry that has only steps (a provider's library). */
function fromEntry(entry: LibraryWorkout): Workout {
  return {
    format: WORKOUT_FORMAT,
    version: WORKOUT_FORMAT_VERSION,
    id: entry.id,
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    sport: entry.sport,
    source: { kind: 'provider' },
    steps: [...entry.steps],
  };
}

/**
 * The workout to start from: nothing for a new one, else the entry of the library. A copy is
 * a workout of the rider's own (`source.kind: 'user'`); its name says so. Author and licence
 * stay, as the licence of a built-in workout asks.
 */
export function startingWorkout(
  subject: WorkoutEditorSubject,
  libraries: ReadonlyMap<string, Library>,
  copyName: (name: string) => string,
  blank: Workout,
): Source {
  if (subject.kind === 'new') return { state: 'ready', workout: blank };
  const library = libraries.get(subject.from);
  const entry = library?.data?.workouts.find((each) => each.id === subject.workoutId);
  if (!entry) {
    const pending = !library || (library.data === undefined && library.status === 'loading');
    return pending ? { state: 'loading' } : { state: 'missing' };
  }
  const workout = entry.workout ?? fromEntry(entry);
  if (subject.kind === 'edit') return { state: 'ready', workout };
  const { declared: _declared, ...rest } = workout;
  return {
    state: 'ready',
    workout: { ...rest, name: copyName(workout.name), source: { kind: 'user' } },
  };
}

/** The athlete of the chosen profile source: what the numbers and the chart read of it. */
export function chosenAthlete(
  profiles: ReadonlyMap<string, DataSource<AthleteProfile>>,
  choices: ReadonlyMap<string, DataSourceChoice>,
): WorkoutAthlete {
  const provider = choices.get('athlete.profile')?.provider ?? DEFAULT_PROVIDER;
  const profile = profiles.get(provider)?.data;
  if (!profile) return {};
  const { ftp, lthr, maxHeartRate, powerZones, heartRateZones } = profile;
  return {
    ...(ftp === undefined ? {} : { ftp }),
    ...(lthr === undefined ? {} : { lthr }),
    ...(maxHeartRate === undefined ? {} : { maxHeartRate }),
    ...(powerZones === undefined ? {} : { powerZones }),
    ...(heartRateZones === undefined ? {} : { heartRateZones }),
  };
}

/** The rider's local date, `YYYY-MM-DD`. */
export function localToday(at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * The days on which entries of a calendar follow this library workout (structured-workouts.md,
 * section 10): from today on, of every provider's calendar. Their number is the notice.
 */
export function plannedDays(
  calendars: ReadonlyMap<string, DataSource<TrainingCalendar>>,
  from: string,
  workoutId: string,
  today: string,
): number {
  const days = new Set<string>();
  for (const calendar of calendars.values()) {
    for (const entry of calendar.data?.workouts ?? ([] as readonly PlannedWorkout[])) {
      if (entry.library?.from === from && entry.library.workoutId === workoutId && entry.date >= today) {
        days.add(entry.date);
      }
    }
  }
  return days.size;
}
