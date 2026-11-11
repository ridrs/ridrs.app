// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  trainingCalendarMoveService,
  trainingCalendarPlanService,
  trainingCalendarRemoveService,
  trainingCalendarState,
  trainingLibrarySaveService,
  trainingLibraryState,
} from '@ridrs/contracts';
import { CALENDAR, entryOf, LIBRARY } from './workouts.ts';

const KEY = 'ridrs';

/**
 * A stand-in for the `ridrs` library under its key: it saves what the editor sends (replacing the
 * workout with that id, or adding one) and refuses a built-in workout, as the real one does.
 */
export default definePlugin({
  start(ctx) {
    let workouts = LIBRARY.map(entryOf);
    const publish = () =>
      ctx.state.set(trainingLibraryState, KEY, {
        provider: KEY,
        label: 'ridrs (this device)',
        status: 'ready',
        writable: true,
        fetchedAt: ctx.clock.now(),
        data: { workouts },
      });
    publish();
    ctx.state.set(trainingCalendarState, KEY, {
      provider: KEY,
      label: 'ridrs (this device)',
      status: 'ready',
      writable: false,
      fetchedAt: ctx.clock.now(),
      data: { workouts: [...CALENDAR] },
    });
    ctx.services.provide(trainingLibrarySaveService, ({ workout }) => {
      const known = workouts.find((entry) => entry.id === workout.id);
      if (known?.workout?.source.kind === 'builtin')
        return { ok: false as const, reason: 'read-only' as const };
      workouts = known
        ? workouts.map((entry) => (entry.id === workout.id ? entryOf(workout) : entry))
        : [...workouts, entryOf(workout)];
      publish();
      return { ok: true as const };
    });
    const readOnly = () => ({ ok: false as const, reason: 'read-only' as const });
    ctx.services.provide(trainingCalendarPlanService, readOnly);
    ctx.services.provide(trainingCalendarMoveService, readOnly);
    ctx.services.provide(trainingCalendarRemoveService, readOnly);
  },
});
