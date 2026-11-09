// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  type PlannedWorkout,
  trainingCalendarHandOverService,
  trainingCalendarMoveService,
  trainingCalendarPlanService,
  trainingCalendarRemoveService,
  trainingCalendarState,
  trainingLibraryState,
} from '@ridrs/contracts';
import { localToday, plannedWorkouts, WORKOUTS } from './client/calendar.ts';
import { INITIAL_TRAINING, TRAINING_DOCUMENT } from './document.ts';

// Most of this plugin lives in its client module (see `ui` in the manifest). The host side is
// the provider `ridrs` of the data type `training.calendar` (ADR 0075): the workouts of the
// area's calendar (and the built-in workouts as its library), read from its document at start and handed over by the client after every
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

    // The built-in workouts are the library of ridrs on this device, without steps: a calendar of
    // another provider plans them from here (the Training area lists them as "Workouts").
    ctx.state.set(trainingLibraryState, 'ridrs', {
      provider: 'ridrs',
      label: 'ridrs (this device)',
      status: 'ready',
      writable: false,
      fetchedAt: ctx.clock.now(),
      data: {
        workouts: WORKOUTS.map((workout) => ({
          id: workout.id,
          name: workout.name,
          sport: 'virtual-ride' as const,
          durationSeconds: workout.minutes * 60,
          trainingLoad: workout.tss,
          steps: [],
        })),
      },
    });

    const kept = await ctx.settings.user(TRAINING_DOCUMENT).read();
    publish(plannedWorkouts((kept ?? INITIAL_TRAINING).calendar.entries, localToday(new Date(ctx.clock.now()))));
    // Only the area edits the calendar on this device: its own buttons, not the library.
    const refuse = () => ({ ok: false as const, reason: 'read-only' as const });
    ctx.services.provide(trainingCalendarPlanService, refuse);
    ctx.services.provide(trainingCalendarMoveService, refuse);
    ctx.services.provide(trainingCalendarRemoveService, refuse);
    ctx.services.provide(trainingCalendarHandOverService, ({ workouts }) => {
      publish(workouts);
      return {};
    });
  },
});
