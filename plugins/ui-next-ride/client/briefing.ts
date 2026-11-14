// SPDX-License-Identifier: AGPL-3.0-or-later

import { type RideBriefing, rideBriefingSetService } from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';

/** The briefing screen of `ui-briefing`. */
const BRIEFING = 'briefing';

/**
 * Leads into the briefing with what this way in fixes (docs/ideas/structured-workouts.md, section
 * 11), and says so with `true`: the fixed points go to the app state `ride.briefing` through its
 * owner, then the briefing opens. Without the briefing (its plugin is absent) nothing happens and
 * the caller starts the ride as it always did.
 */
export function openBriefing(ctx: UiContext, fixed: RideBriefing): boolean {
  if (!ctx.hasScreen(BRIEFING)) return false;
  const open = () => ctx.navigate(BRIEFING);
  ctx.call(rideBriefingSetService, { key: 'fixed', briefing: fixed }).then(open, (error: unknown) => {
    ctx.logger.warn('The briefing could not be told what is fixed', error);
    open();
  });
  return true;
}
