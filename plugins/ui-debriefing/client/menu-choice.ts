// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AthleteProfile,
  type DataSource,
  type DataSourceChoice,
  DEFAULT_PROVIDER,
  type LibraryWorkout,
  type PlannedWorkout,
  type RideWorkout,
  type RideWorld,
  type RouteOffer,
  type TrainingCalendar,
  WORKOUT_FORMAT,
  WORKOUT_FORMAT_VERSION,
  type Workout,
} from '@ridrs/contracts';
import { resolveWorkout, type WorkoutAthlete } from '@ridrs/workout';

export type Library = DataSource<{ readonly workouts: readonly LibraryWorkout[] }>;
export type Calendar = DataSource<TrainingCalendar>;

export interface WorkoutChoice {
  readonly key: string;
  readonly name: string;
  readonly date?: string;
  readonly ride: RideWorkout;
}

export type Refusal = 'no-ftp' | 'no-power-zones';

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

/** The route offer matching `world`, if one is registered. */
export function offerOf(
  world: RideWorld | undefined,
  offers: Iterable<RouteOffer>,
): RouteOffer | undefined {
  if (!world) return undefined;
  return [...offers].find(
    (offer) => offer.world.landscape === world.landscape && offer.world.route === world.route,
  );
}

export const sameWorld = (a: RideWorld | undefined, b: RideWorld | undefined): boolean =>
  (a ?? undefined) === (b ?? undefined) ||
  (!!a && !!b && a.landscape === b.landscape && a.route === b.route);

/** Whether `active` came from the same planned or library entry as `candidate`. */
export function sameRideWorkout(a: RideWorkout | undefined, b: RideWorkout): boolean {
  if (!a) return false;
  if (a.planned && b.planned) {
    return a.planned.provider === b.planned.provider && a.planned.id === b.planned.id;
  }
  if (a.library && b.library && !a.planned && !b.planned) {
    return a.library.from === b.library.from && a.library.workoutId === b.library.workoutId;
  }
  return a.workout.id === b.workout.id && a.workout.name === b.workout.name;
}

/** Planned workouts from `today` (`YYYY-MM-DD`) on and library workouts, ready to resolve. */
export function availableWorkouts(
  libraries: ReadonlyMap<string, Library>,
  calendars: ReadonlyMap<string, Calendar>,
  today: string,
): { readonly planned: readonly WorkoutChoice[]; readonly library: readonly WorkoutChoice[] } {
  const planned: WorkoutChoice[] = [...calendars.entries()]
    .flatMap(([from, calendar]) =>
      (calendar.data?.workouts ?? [])
        .filter((entry) => entry.date >= today && entry.steps.length > 0)
        .map((entry): WorkoutChoice => {
          const origin = entry.library
            ? libraries
                .get(entry.library.from)
                ?.data?.workouts.find((each) => each.id === entry.library?.workoutId)?.workout
            : undefined;
          return {
            key: `planned/${from}/${entry.id}`,
            name: entry.name,
            date: entry.date,
            ride: {
              workout: {
                ...fromEntry(entry),
                ...(entry.description ?? origin?.description
                  ? { description: (entry.description ?? origin?.description) as string }
                  : {}),
                ...(origin?.author ? { author: origin.author } : {}),
                ...(origin?.license ? { license: origin.license } : {}),
              },
              planned: { provider: from, id: entry.id },
              ...(entry.library ? { library: entry.library } : {}),
            },
          };
        }),
    )
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.name.localeCompare(b.name));

  const library: WorkoutChoice[] = [...libraries.entries()]
    .flatMap(([from, source]) =>
      (source.data?.workouts ?? [])
        .filter((entry) => entry.steps.length > 0 || entry.workout !== undefined)
        .map(
          (entry): WorkoutChoice => ({
            key: `library/${from}/${entry.id}`,
            name: entry.name,
            ride: {
              workout: entry.workout ?? fromEntry(entry),
              library: { from, workoutId: entry.id },
            },
          }),
        ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  return { planned, library };
}

/** Athlete values for resolving workout targets: chosen profile, overridden by the ride's frozen FTP. */
export function resolveAthlete(
  profiles: ReadonlyMap<string, DataSource<AthleteProfile>>,
  choices: ReadonlyMap<string, DataSourceChoice>,
  rideFtp: number | undefined,
): WorkoutAthlete {
  const provider = choices.get('athlete.profile')?.provider ?? DEFAULT_PROVIDER;
  const profile = profiles.get(provider)?.data;
  const ftp = rideFtp ?? profile?.ftp;
  return {
    ...(ftp === undefined ? {} : { ftp }),
    ...(profile?.lthr === undefined ? {} : { lthr: profile.lthr }),
    ...(profile?.maxHeartRate === undefined ? {} : { maxHeartRate: profile.maxHeartRate }),
    ...(profile?.powerZones === undefined ? {} : { powerZones: profile.powerZones }),
    ...(profile?.heartRateZones === undefined ? {} : { heartRateZones: profile.heartRateZones }),
  };
}

/** Resolves `% FTP` and zone targets to watts for deterministic recording and replay. */
export function resolveWorkoutForRide(
  ride: RideWorkout,
  athlete: WorkoutAthlete,
): { readonly ok: true; readonly ride: RideWorkout } | { readonly ok: false; readonly refusal: Refusal } {
  const { workout, issues } = resolveWorkout(ride.workout, athlete);
  for (const code of ['no-ftp', 'no-power-zones'] as const) {
    if (issues.some((issue) => issue.code === code)) return { ok: false, refusal: code };
  }
  return { ok: true, ride: { ...ride, workout } };
}
