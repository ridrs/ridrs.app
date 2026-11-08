// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AthleteProfile,
  athleteProfileState,
  athleteProfileUpdateService,
  DEFAULT_PROVIDER,
  definePlugin,
} from '@ridrs/contracts';
import { ATHLETE_DOCUMENT, type AthleteDocument } from './athlete.ts';

/** The values of the document without the time of the change. */
function profileOf({ changedAt: _changedAt, ...values }: AthleteDocument): AthleteProfile {
  return values;
}

/**
 * The athlete profile on this device (ADR 0073): the provider `ridrs` of `athlete.profile`,
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
        data: document ? profileOf(document) : {},
      });
    publish();

    ctx.services.provide(athleteProfileUpdateService, async ({ key: _key, ...change }) => {
      document = { ...document, ...change, changedAt: ctx.clock.now() };
      publish();
      const changed = document;
      await kept
        .write(changed)
        .catch((error: unknown) => ctx.logger.warn(`Could not keep the athlete profile: ${String(error)}`));
      return { ok: true };
    });
  },
});
