// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  APP_LANGUAGE_KEY,
  activityStateChangedEvent,
  appLanguageSetService,
  appLanguageState,
  athleteProfileChangedEvent,
  athleteProfileState,
  DEFAULT_LANGUAGE,
  DEFAULT_PROVIDER,
  type DataSource,
  type AthleteProfile,
  dataSelectService,
  dataSourceState,
  definePlugin,
  hostStartedEvent,
  languageSchema,
  type RideAthlete,
  trainingAccountState,
  trainingCalendarState,
} from '@ridrs/contracts';
import { z } from 'zod';
import { DATA_SOURCES_DOCUMENT } from './data-sources.ts';

/** The language the rider chose (ADR 0072), kept apart from the preview's settings. */
const languageDocument = {
  name: 'language',
  version: 1,
  schema: z.object({ language: languageSchema }).strict(),
};

/** The data types with a choice (ADR 0075); the library has none. */
const ATHLETE_PROFILE = 'athlete.profile';
const DATA_TYPES: readonly string[] = [ATHLETE_PROFILE, 'training.calendar'];

/** What a ride uses of a source's profile: the values that change the ride, never the name. */
function rideAthleteOf(source: DataSource<AthleteProfile>): RideAthlete {
  const { ftp, weight } = source.data ?? {};
  return {
    provider: source.provider,
    ...(ftp === undefined ? {} : { ftp }),
    ...(weight === undefined ? {} : { weight }),
  };
}

// The rest of this plugin lives in its client module (see `ui` in the manifest). The host side
// owns the app's language: every UI plugin watches it, so it must be there before they render.
// It owns the choice of the data sources as well (ADR 0075) and hands the chosen athlete profile
// to the next ride as the input `athlete.profile-changed`, as the garage hands over the bicycle.
export default definePlugin({
  async start(ctx) {
    const kept = ctx.settings.user(languageDocument);
    const stored = await kept.read();
    ctx.state.set(appLanguageState, APP_LANGUAGE_KEY, stored?.language ?? DEFAULT_LANGUAGE);
    // The change takes effect at once, like every setting; keeping it follows. A language that
    // could not be kept still holds until ridrs restarts.
    ctx.services.provide(appLanguageSetService, async ({ language }) => {
      ctx.state.set(appLanguageState, APP_LANGUAGE_KEY, language);
      await kept
        .write({ language })
        .catch((error: unknown) => ctx.logger.warn(`Could not keep the language: ${String(error)}`));
      return {};
    });

    // The rider's choice per data type. It stays in the document when its provider is gone, so
    // the provider comes back with the choice; the state holds the provider in use.
    const sources = ctx.settings.user(DATA_SOURCES_DOCUMENT);
    const chosen = new Map(Object.entries((await sources.read())?.sources ?? {}));
    let started = false;
    const inUse = new Map<string, string>();
    let handedOver: string | undefined;

    const keepChoices = () =>
      sources
        .write({ sources: Object.fromEntries(chosen) })
        .catch((error: unknown) => ctx.logger.warn(`Could not keep the data sources: ${String(error)}`));

    /** The providers of each data type with a choice. */
    const providersOf = (type: string): ReadonlyMap<string, unknown> =>
      type === ATHLETE_PROFILE
        ? ctx.state.entries(athleteProfileState)
        : ctx.state.entries(trainingCalendarState);

    /**
     * The source of a data type the rider has not chosen: a service whose account the rider
     * connected (or is connecting, or whose sign-in failed), so a connected rider keeps seeing
     * that service and a rider who connects later sees it at once; else ridrs.
     */
    const implicitChoice = (type: string): string => {
      const accounts = ctx.state.entries(trainingAccountState);
      return (
        [...providersOf(type).keys()]
          .filter((provider) => provider !== DEFAULT_PROVIDER)
          .sort()
          .find((provider) => {
            const state = accounts.get(provider)?.state;
            return state !== undefined && state !== 'disconnected';
          }) ?? DEFAULT_PROVIDER
      );
    };

    /** The provider in use: the chosen one, or ridrs once the host has started and it is gone. */
    const evaluate = (force = false): void => {
      for (const type of DATA_TYPES) {
        const entries = providersOf(type);
        const choice = chosen.get(type) ?? implicitChoice(type);
        const provider = !started || entries.has(choice) ? choice : DEFAULT_PROVIDER;
        if (provider !== inUse.get(type)) {
          inUse.set(type, provider);
          ctx.state.set(dataSourceState, type, { provider });
        }
      }
      // The profile of the provider in use goes to the next ride.
      const profiles = ctx.state.entries(athleteProfileState);
      const source = profiles.get(inUse.get(ATHLETE_PROFILE) ?? DEFAULT_PROVIDER);
      if (!started || !source) {
        return;
      }
      const athlete = rideAthleteOf(source);
      const json = JSON.stringify(athlete);
      if (force || json !== handedOver) {
        handedOver = json;
        ctx.inputs.accept(athleteProfileChangedEvent, athlete);
      }
    };

    evaluate();
    ctx.state.watch(athleteProfileState, () => evaluate());
    ctx.state.watch(trainingCalendarState, () => evaluate());
    ctx.state.watch(trainingAccountState, () => evaluate());
    // Providers start in turn: the choice counts as gone only when all of them have started.
    ctx.events.subscribe(hostStartedEvent, () => {
      started = true;
      evaluate();
    });
    // A ride continued from its journal re-enters the athlete it recorded; the profile as it is
    // now is handed over again when that ride finishes, for the next one (as the garage does).
    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      if (payload.state === 'finished') {
        evaluate(true);
      }
    });

    ctx.services.provide(dataSelectService, async ({ key, provider }) => {
      if (!DATA_TYPES.includes(key)) {
        throw new Error(`"${key}" is no data type with a choice`);
      }
      if (!providersOf(key).has(provider)) {
        throw new Error(`"${provider}" does not offer ${key}`);
      }
      chosen.set(key, provider);
      evaluate();
      await keepChoices();
      return {};
    });
  },
});
