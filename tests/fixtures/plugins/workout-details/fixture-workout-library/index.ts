// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  trainingCalendarMoveService,
  trainingCalendarPlanService,
  trainingCalendarRemoveService,
  trainingCalendarState,
  trainingLibraryState,
} from '@ridrs/contracts';
import { CALENDAR, LIBRARY } from './workouts.ts';

const PROVIDER = 'fixture-library';

/**
 * A provider of `training.library` and `training.calendar` under the key `fixture-library`, ready
 * with the workouts of the details scenarios. Its calendar cannot be written.
 */
export default definePlugin({
  start(ctx) {
    const source = {
      provider: PROVIDER,
      label: 'Fixture library',
      status: 'ready' as const,
      writable: false,
    };
    ctx.state.set(trainingLibraryState, PROVIDER, {
      ...source,
      fetchedAt: ctx.clock.now(),
      data: { workouts: [...LIBRARY] },
    });
    ctx.state.set(trainingCalendarState, PROVIDER, {
      ...source,
      fetchedAt: ctx.clock.now(),
      data: { workouts: [...CALENDAR] },
    });
    const readOnly = () => ({ ok: false as const, reason: 'read-only' as const });
    ctx.services.provide(trainingCalendarPlanService, readOnly);
    ctx.services.provide(trainingCalendarMoveService, readOnly);
    ctx.services.provide(trainingCalendarRemoveService, readOnly);
  },
});
