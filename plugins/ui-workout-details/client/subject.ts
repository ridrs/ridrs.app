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
  type WorkoutDetailsSubject,
} from '@ridrs/contracts';
import type { WorkoutAthlete } from '@ridrs/workout';

/** A provider's library as the app state holds it (ADR 0075). */
export type Library = DataSource<{ readonly workouts: readonly LibraryWorkout[] }>;

/** The workout the details show, and the day it is planned for when it is a calendar entry. */
export type Shown =
  | { readonly state: 'shown'; readonly workout: Workout; readonly plannedFor?: string }
  | { readonly state: 'loading' }
  | { readonly state: 'missing' };

/**
 * A canonical workout from an entry that has only steps (a library of intervals.icu, a calendar
 * entry): the details compute with it and the chart draws it; nothing is converted.
 */
function fromEntry(entry: LibraryWorkout | PlannedWorkout): Workout {
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

/** Whether a provider's data is still to come: absent, or loading without data yet. */
const pending = (source: DataSource<unknown> | undefined) =>
  !source || (source.data === undefined && source.status === 'loading');

/**
 * Finds the subject in the app state. A library entry shows its canonical workout where the
 * provider has one (author, licence, metadata). A calendar entry shows its own name, steps and
 * description; author and licence come from the library workout it was planned from, if known.
 */
export function shownWorkout(
  subject: WorkoutDetailsSubject,
  libraries: ReadonlyMap<string, Library>,
  calendars: ReadonlyMap<string, DataSource<TrainingCalendar>>,
): Shown {
  if (subject.kind === 'library') {
    const library = libraries.get(subject.from);
    const entry = library?.data?.workouts.find((workout) => workout.id === subject.workoutId);
    if (entry) return { state: 'shown', workout: entry.workout ?? fromEntry(entry) };
    return pending(library) ? { state: 'loading' } : { state: 'missing' };
  }
  const calendar = calendars.get(subject.from);
  const entry = calendar?.data?.workouts.find((workout) => workout.id === subject.id);
  if (!entry) return pending(calendar) ? { state: 'loading' } : { state: 'missing' };
  const origin = entry.library
    ? libraries
        .get(entry.library.from)
        ?.data?.workouts.find((workout) => workout.id === entry.library?.workoutId)?.workout
    : undefined;
  const description = entry.description ?? origin?.description;
  return {
    state: 'shown',
    plannedFor: entry.date,
    workout: {
      ...fromEntry(entry),
      ...(description ? { description } : {}),
      ...(origin?.author ? { author: origin.author } : {}),
      ...(origin?.license ? { license: origin.license } : {}),
    },
  };
}

/**
 * The athlete of the chosen profile source (ADR 0075; `ridrs` without a choice): only what the
 * numbers and the chart read of it.
 */
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
