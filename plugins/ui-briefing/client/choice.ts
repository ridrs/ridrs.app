// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AthleteProfile,
  type DataSource,
  type DataSourceChoice,
  DEFAULT_PROVIDER,
  type LibraryWorkout,
  type PlannedWorkout,
  type RideBriefing,
  type RideWorkout,
  type RouteOffer,
  type TrainingCalendar,
  WORKOUT_FORMAT,
  WORKOUT_FORMAT_VERSION,
  type Workout,
} from '@ridrs/contracts';
import { resolveWorkout, type WorkoutAthlete } from '@ridrs/workout';

/**
 * What the briefing decides before a ride (docs/ideas/structured-workouts.md, section 11), apart
 * from the screen: pure and headless. The way into the briefing fixes some of it; the rest is
 * asked, or taken from the choice remembered last.
 */

/** The world of a route: a landscape and the course in it. */
export type World = NonNullable<RideBriefing['world']>;
/** A workout as the app state names it: none, one of a library, one planned in a calendar. */
export type WorkoutPick = NonNullable<RideBriefing['workout']>;

/** The two decisions the briefing asks for. `null` is an answer: a free ride, no workout. */
export interface Answers {
  /** `undefined` while the rider has not said; `null` for a free ride. */
  readonly world: World | null | undefined;
  readonly workout: WorkoutPick | undefined;
}

/** Which of the answers the way into the briefing fixed. */
export interface Fixed {
  readonly world: boolean;
  readonly workout: boolean;
}

/**
 * The answers to start from: what the way in fixed, else what was chosen last. A remembered choice
 * always names its workout (`none` for a ride without one), which is how "a free ride" differs
 * from "nothing remembered yet".
 */
export function startingAnswers(
  last: RideBriefing | undefined,
  fixed: RideBriefing | undefined,
): { readonly answers: Answers; readonly fixed: Fixed } {
  const remembered = last?.workout !== undefined;
  const world = fixed?.world ?? (remembered ? (last?.world ?? null) : undefined);
  const workout = fixed?.workout ?? (remembered ? last?.workout : undefined);
  return {
    answers: { world, workout },
    fixed: { world: fixed?.world !== undefined, workout: fixed?.workout !== undefined },
  };
}

/** The offer that stands for a world: the same landscape and course. */
export function offerOf(world: World | null | undefined, offers: Iterable<RouteOffer>): RouteOffer | undefined {
  if (!world) return undefined;
  return [...offers].find(
    (offer) => offer.world.landscape === world.landscape && offer.world.route === world.route,
  );
}

/** A provider's library as the app state holds it (ADR 0075). */
export type Library = DataSource<{ readonly workouts: readonly LibraryWorkout[] }>;
export type Calendar = DataSource<TrainingCalendar>;

/** A canonical workout from an entry that has only steps; nothing is converted. */
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

export type Found =
  | { readonly state: 'none' }
  | { readonly state: 'found'; readonly ride: RideWorkout }
  | { readonly state: 'missing' };

/**
 * The workout a pick stands for, with where it came from: a calendar entry stays the planned one,
 * so the ride can be matched with its plan later, and names the library workout it was planned
 * from.
 */
export function findWorkout(
  pick: WorkoutPick | undefined,
  libraries: ReadonlyMap<string, Library>,
  calendars: ReadonlyMap<string, Calendar>,
): Found {
  if (!pick || pick.kind === 'none') return { state: 'none' };
  if (pick.kind === 'library') {
    const entry = libraries.get(pick.from)?.data?.workouts.find((each) => each.id === pick.workoutId);
    if (!entry) return { state: 'missing' };
    return {
      state: 'found',
      ride: {
        workout: entry.workout ?? fromEntry(entry),
        library: { from: pick.from, workoutId: pick.workoutId },
      },
    };
  }
  const entry = calendars.get(pick.from)?.data?.workouts.find((each) => each.id === pick.id);
  if (!entry) return { state: 'missing' };
  const origin = entry.library
    ? libraries.get(entry.library.from)?.data?.workouts.find((each) => each.id === entry.library?.workoutId)?.workout
    : undefined;
  return {
    state: 'found',
    ride: {
      workout: {
        ...fromEntry(entry),
        ...(entry.description ?? origin?.description
          ? { description: (entry.description ?? origin?.description) as string }
          : {}),
        ...(origin?.author ? { author: origin.author } : {}),
        ...(origin?.license ? { license: origin.license } : {}),
      },
      planned: { provider: pick.from, id: pick.id },
      ...(entry.library ? { library: entry.library } : {}),
    },
  };
}

/** Whether libraries or calendars still have to deliver: a pick that is not found yet may come. */
export function stillLoading(
  pick: WorkoutPick | undefined,
  libraries: ReadonlyMap<string, Library>,
  calendars: ReadonlyMap<string, Calendar>,
): boolean {
  if (!pick || pick.kind === 'none') return false;
  return pending(pick.kind === 'library' ? libraries.get(pick.from) : calendars.get(pick.from));
}

/** One workout the rider can pick, with what tells it from the others. */
export interface WorkoutOption {
  readonly pick: WorkoutPick;
  readonly name: string;
  /** The day of a planned entry, `YYYY-MM-DD`. */
  readonly date?: string;
}

/** The workouts to pick from: the entries planned from `today` on, then every library workout. */
export function workoutOptions(
  libraries: ReadonlyMap<string, Library>,
  calendars: ReadonlyMap<string, Calendar>,
  today: string,
): { readonly planned: readonly WorkoutOption[]; readonly library: readonly WorkoutOption[] } {
  const planned = [...calendars.entries()]
    .flatMap(([from, calendar]) =>
      (calendar.data?.workouts ?? [])
        .filter((entry) => entry.date >= today && entry.steps.length > 0)
        .map((entry) => ({ pick: { kind: 'planned', from, id: entry.id } as const, name: entry.name, date: entry.date })),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const library = [...libraries.entries()]
    .flatMap(([from, source]) =>
      (source.data?.workouts ?? [])
        .filter((entry) => entry.steps.length > 0 || entry.workout !== undefined)
        .map((entry) => ({ pick: { kind: 'library', from, workoutId: entry.id } as const, name: entry.name })),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return { planned, library };
}

/**
 * What the next ride remembers (`ride.briefing` key `last`): the choice as the briefing ends it.
 * A planned entry is remembered as the library workout it was planned from, or as none: the usual
 * ride is the workout, not that one day's entry, which the next ride would ride past its date.
 */
export function rememberedChoice(
  world: World | null | undefined,
  found: Found,
  bicycle: string | undefined,
): RideBriefing {
  const library = found.state === 'found' ? found.ride.library : undefined;
  return {
    ...(world ? { world } : {}),
    workout: library ? { kind: 'library', from: library.from, workoutId: library.workoutId } : { kind: 'none' },
    ...(bicycle ? { bicycle } : {}),
  };
}

/** The athlete of the chosen profile source (ADR 0075; `ridrs` without a choice): what resolving reads. */
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

/** What stops a ride with a workout: its power targets cannot become watts with this profile. */
export type Refusal = 'no-ftp' | 'no-power-zones';

/**
 * The workout as the ride gets it, its targets resolved with the athlete profile of now (% FTP and
 * power zones become watts; a replay needs neither profile nor catalogue). A power target the
 * profile cannot resolve refuses the start and says what is missing; nothing is guessed. Other
 * gaps (heart rate without a threshold) do not stop a ride: those steps run without a target.
 */
export function resolveForRide(
  ride: RideWorkout,
  athlete: WorkoutAthlete,
): { readonly ok: true; readonly ride: RideWorkout } | { readonly ok: false; readonly refusal: Refusal } {
  const { workout, issues } = resolveWorkout(ride.workout, athlete);
  for (const code of ['no-ftp', 'no-power-zones'] as const) {
    if (issues.some((issue) => issue.code === code)) return { ok: false, refusal: code };
  }
  return { ok: true, ride: { ...ride, workout } };
}

/** How a workout and a route of different lengths go together, if they differ much. */
export type LengthNote = 'workout-longer' | 'route-longer';

/** The smallest gap that is worth a note, in s, and the share of the longer one the shorter falls short by. */
const NOTE_GAP_SECONDS = 5 * 60;
const NOTE_SHARE = 0.8;

export function lengthNote(workoutSeconds: number | undefined, routeSeconds: number | undefined): LengthNote | undefined {
  if (!workoutSeconds || !routeSeconds) return undefined;
  const [shorter, longer] = [Math.min(workoutSeconds, routeSeconds), Math.max(workoutSeconds, routeSeconds)];
  if (longer - shorter < NOTE_GAP_SECONDS || shorter >= longer * NOTE_SHARE) return undefined;
  return workoutSeconds > routeSeconds ? 'workout-longer' : 'route-longer';
}
