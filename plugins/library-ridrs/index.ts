// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  type LibraryWorkout,
  RidrsError,
  storageAppFilesCapability,
  trainingLibraryRemoveService,
  trainingLibrarySaveService,
  trainingLibraryState,
} from '@ridrs/contracts';
import { validateWorkout } from '@ridrs/workout';
import { catalogue, libraryWorkout } from './catalogue.ts';
import { WorkoutStore } from './store.ts';

/**
 * The library of the provider `ridrs` (ADR 0075, ADR 0086): the built-in workouts, read only,
 * from the canonical files of `resources/workouts/`, and the rider's own and imported ones, kept
 * as app files (`store.ts`). It is writable when app files are there; a built-in id is never
 * overwritten or removed ("Edit" saves a copy under a new id).
 */
export default definePlugin({
  async start(ctx) {
    const builtIn = catalogue();
    const builtInIds = new Set(builtIn.map((workout) => workout.id));
    const files = ctx.capabilities.find(storageAppFilesCapability);
    const store = files
      ? new WorkoutStore(files, (message, error) => ctx.logger.warn({ error }, message))
      : undefined;

    const publish = () => {
      const own: LibraryWorkout[] = store
        ? [...store.workouts.values()]
            .filter((workout) => !builtInIds.has(workout.id))
            .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
            .map(libraryWorkout)
        : [];
      ctx.state.set(trainingLibraryState, 'ridrs', {
        provider: 'ridrs',
        label: 'ridrs (this device)',
        status: 'ready',
        writable: store !== undefined,
        fetchedAt: ctx.clock.now(),
        data: { workouts: [...builtIn.map(libraryWorkout), ...own] },
      });
    };

    publish();
    if (!store) return;
    await store.load();
    publish();

    ctx.services.provide(trainingLibrarySaveService, async ({ workout, original }) => {
      if (builtInIds.has(workout.id)) return { ok: false as const, reason: 'read-only' as const };
      const problems = validateWorkout(workout);
      if (problems.length > 0) {
        throw new RidrsError('invalid-request', problems.map((problem) => problem.message).join('; '));
      }
      await store.save(workout, original);
      publish();
      return { ok: true as const };
    });

    ctx.services.provide(trainingLibraryRemoveService, async ({ workoutId }) => {
      if (builtInIds.has(workoutId)) return { ok: false as const, reason: 'read-only' as const };
      if (await store.remove(workoutId)) publish();
      return { ok: true as const };
    });
  },
});
