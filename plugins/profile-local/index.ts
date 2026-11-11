// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AthleteProfile,
  athleteProfileState,
  athleteProfileUpdateService,
  DEFAULT_PROVIDER,
  definePlugin,
} from '@ridrs/contracts';
import { defaultHeartRateZones, defaultPowerZones } from '@ridrs/workout';
import { ATHLETE_DOCUMENT, type AthleteDocument } from './athlete.ts';

/**
 * The profile of the document: the rider's own zones, else the defaults, derived on read so that
 * a change of the LTHR moves the heart rate zones the rider did not set (ADR 0082).
 */
function profileOf({ changedAt: _changedAt, ...values }: AthleteDocument): AthleteProfile {
  const heartRateZones = values.heartRateZones ?? (values.lthr ? defaultHeartRateZones(values.lthr) : undefined);
  return {
    ...values,
    powerZones: values.powerZones ?? defaultPowerZones(),
    ...(heartRateZones ? { heartRateZones } : {}),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Zones equal to the defaults are not kept: they stay derived ("reset to defaults"). */
function withoutDefaultZones(document: AthleteDocument): AthleteDocument {
  const { powerZones, heartRateZones, ...rest } = document;
  return {
    ...rest,
    ...(powerZones && !same(powerZones, defaultPowerZones()) ? { powerZones } : {}),
    ...(heartRateZones && !(rest.lthr && same(heartRateZones, defaultHeartRateZones(rest.lthr)))
      ? { heartRateZones }
      : {}),
  };
}

/**
 * The athlete profile on this device (ADR 0075): the provider `ridrs` of `athlete.profile`,
 * always ready and writable, the default of the choice. The profile is the user document
 * `athlete`; a change takes effect at once and is kept after it, as the language is. The values
 * of an older preview in the Me area are handed over through the update service (ui-area-me).
 */
export default definePlugin({
  async start(ctx) {
    const kept = ctx.settings.user(ATHLETE_DOCUMENT);
    let document = await kept.read();

    const publish = () =>
      ctx.state.set(athleteProfileState, DEFAULT_PROVIDER, {
        provider: DEFAULT_PROVIDER,
        label: 'ridrs (this device)',
        status: 'ready',
        writable: true,
        data: profileOf(document ?? { changedAt: 0 }),
      });
    publish();

    ctx.services.provide(athleteProfileUpdateService, async ({ key: _key, ...change }) => {
      document = withoutDefaultZones({ ...document, ...change, changedAt: ctx.clock.now() });
      publish();
      const changed = document;
      await kept
        .write(changed)
        .catch((error: unknown) => ctx.logger.warn(`Could not keep the athlete profile: ${String(error)}`));
      return { ok: true };
    });
  },
});
