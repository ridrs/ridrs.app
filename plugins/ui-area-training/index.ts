// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  type PlannedWorkout,
  trainingCalendarHandOverService,
  trainingCalendarState,
  trainingLibraryState,
} from '@ridrs/contracts';
import { plannedWorkouts } from './client/calendar.ts';
import { INITIAL_TRAINING, TRAINING_DOCUMENT } from './document.ts';

/** The rider's local date, `YYYY-MM-DD`. */
function today(epochMs: number): string {
  const at = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

// Most of this plugin lives in its client module (see `ui` in the manifest). The host side is
// the provider `ridrs` of the data type `training.calendar` (ADR 0075): the workouts of the
// area's calendar (and an empty library), read from its document at start and handed over by the client after every
// change. Only the area edits the calendar, so the provider is read only for everyone else.
export default definePlugin({
  async start(ctx) {
    const publish = (workouts: PlannedWorkout[]) =>
      ctx.state.set(trainingCalendarState, 'ridrs', {
        provider: 'ridrs',
        label: 'ridrs (this device)',
        status: 'ready',
        writable: false,
        fetchedAt: ctx.clock.now(),
        data: { workouts },
      });

    // ridrs on this device has no workouts of its own to offer (no built-in workouts yet).
    ctx.state.set(trainingLibraryState, 'ridrs', {
      provider: 'ridrs',
      label: 'ridrs (this device)',
      status: 'ready',
      writable: false,
      fetchedAt: ctx.clock.now(),
      data: { workouts: [] },
    });

    const kept = await ctx.settings.user(TRAINING_DOCUMENT).read();
    publish(plannedWorkouts((kept ?? INITIAL_TRAINING).calendar.entries, today(ctx.clock.now())));
    ctx.services.provide(trainingCalendarHandOverService, ({ workouts }) => {
      publish(workouts);
      return {};
    });
  },
});
