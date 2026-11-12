// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  type RideBriefing,
  rideBriefingSchema,
  rideBriefingSetService,
  rideBriefingState,
  type SettingsDocument,
} from '@ridrs/contracts';

/** The choice remembered for the next ride, kept beside the app (ADR 0059). */
const LAST: SettingsDocument<RideBriefing> = { name: 'last-ride', version: 1, schema: rideBriefingSchema };

/** The keys of `ride.briefing`: what the way in fixed, and what was chosen last. */
const KEYS: ReadonlySet<string> = new Set(['fixed', 'last']);

/**
 * The host side of the briefing owns the app state `ride.briefing` (ADR 0068): UI plugins cannot
 * write app state, so the ways into the briefing (Today, the route and workout details) and the
 * briefing itself write its two keys through the service `ride.briefing-set`. `fixed` lives in
 * memory, only until the briefing has been left; `last` is kept, so that Enter, Enter starts the
 * usual ride after a restart as well.
 */
export default definePlugin({
  async start(ctx) {
    const kept = ctx.settings.user(LAST);
    // Both keys exist from the start: a keyed service reaches only the keys that have an owner.
    ctx.state.set(rideBriefingState, 'fixed', {});
    ctx.state.set(rideBriefingState, 'last', {});
    ctx.services.provide(rideBriefingSetService, async ({ key, briefing }) => {
      if (!KEYS.has(key)) {
        throw new Error(`The briefing keeps no "${key}", only "fixed" and "last"`);
      }
      ctx.state.set(rideBriefingState, key, briefing);
      if (key === 'last') await kept.write(briefing);
      return {};
    });
    const stored = await kept.read();
    // A choice written while the document was read is newer.
    if (stored && Object.keys(ctx.state.get(rideBriefingState, 'last') ?? {}).length === 0) {
      ctx.state.set(rideBriefingState, 'last', stored);
    }
  },
});
