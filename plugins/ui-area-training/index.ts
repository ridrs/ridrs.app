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
import { localToday, plannedWorkouts } from './client/calendar.ts';
import { INITIAL_TRAINING, TRAINING_DOCUMENT } from './document.ts';

// Most of this plugin lives in its client module (see `ui` in the manifest). The host side is
// the provider `ridrs` of the data type `training.calendar` (ADR 0075): the workouts of the
// area's calendar, read from its document at start and handed over by the client after every
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

    // The entries dropped from a library carry its steps: resolved again when a library changes,
    // also while the area is not shown (the document is kept at once, ADR 0059).
    const publishDocument = async () => {
      const kept = await ctx.settings.user(TRAINING_DOCUMENT).read();
      publish(
        plannedWorkouts(
          (kept ?? INITIAL_TRAINING).calendar.entries,
          localToday(new Date(ctx.clock.now())),
          ctx.state.entries(trainingLibraryState),
        ),
      );
    };
    await publishDocument();
    ctx.state.watch(trainingLibraryState, ({ changed }) => {
      if (changed.length > 0) {
        publishDocument().catch((error: unknown) =>
          ctx.logger.warn(`Could not publish the calendar again: ${String(error)}`),
        );
      }
    });
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
