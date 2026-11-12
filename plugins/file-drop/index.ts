// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  dataDropCapability,
  definePlugin,
  FILE_DROP_KEY,
  fileDropImportService,
  fileDropState,
  routeImportPreviewService,
  routeImportService,
  routeImportState,
  trainingLibrarySaveService,
  trainingLibraryState,
} from '@ridrs/contracts';
import { importTime } from '@ridrs/workout';
import { FileDrops } from './drops.ts';

/** The writable library of this device, where dropped workouts go (F4 of the plan, ADR 0093). */
const LIBRARY = 'ridrs';

let disconnect: (() => void) | undefined;

// Files dragged onto the window (ADR 0093): what they are, as the key `window` of the app state
// `file.drop` while they hover, and `file.drop.import`, which the layer over the main screen calls
// when they are let go over it. Without that layer, during a ride for one, nothing is imported.
export default definePlugin({
  start(ctx) {
    const drops = new FileDrops(
      {
        drop: ctx.capabilities.find(dataDropCapability),
        routeProviders: () => [...ctx.state.entries(routeImportState).keys()],
        knownWorkouts: () =>
          (ctx.state.get(trainingLibraryState, LIBRARY)?.data?.workouts ?? []).map((entry) => ({
            id: entry.id,
            name: entry.name,
            ...(entry.workout?.source.originalHash ? { originalHash: entry.workout.source.originalHash } : {}),
          })),
        preview: (key, file) => ctx.services.call(routeImportPreviewService, { key, file }),
        importRoute: async (key, file) => {
          await ctx.services.call(routeImportService, { key, file });
        },
        saveWorkout: async (workout, original) => {
          const answer = await ctx.services.call(trainingLibrarySaveService, { key: LIBRARY, workout, original });
          if (!answer.ok) ctx.logger.warn({ workout: workout.id, reason: answer.reason }, 'file-drop: the library refused a workout');
          return answer.ok;
        },
        warn: (message) => ctx.logger.warn({ message }, 'file-drop: a dragged file could not be added'),
        now: () => importTime(ctx.clock.now()),
      },
      (state) => (state ? ctx.state.set(fileDropState, FILE_DROP_KEY, state) : ctx.state.remove(fileDropState, FILE_DROP_KEY)),
    );
    ctx.services.provide(fileDropImportService, async () => {
      await drops.import();
      return {};
    });
    disconnect = drops.connect();
  },
  stop() {
    disconnect?.();
    disconnect = undefined;
  },
});
