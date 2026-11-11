// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, trainingLibraryState } from '@ridrs/contracts';
import { catalogue, libraryWorkout } from './catalogue.ts';

// The built-in workouts as the library of the provider `ridrs` (ADR 0075, ADR 0086): read only,
// loaded from the canonical files of `resources/workouts/`. "Edit" makes a copy elsewhere.
export default definePlugin({
  start(ctx) {
    ctx.state.set(trainingLibraryState, 'ridrs', {
      provider: 'ridrs',
      label: 'ridrs (this device)',
      status: 'ready',
      writable: false,
      fetchedAt: ctx.clock.now(),
      data: { workouts: catalogue().map(libraryWorkout) },
    });
  },
});
