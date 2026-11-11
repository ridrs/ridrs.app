// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, trainingLibraryState } from '@ridrs/contracts';
import { LIBRARY } from './workouts.ts';

const PROVIDER = 'fixture-library';

/** A read-only provider of `training.library` under the key `fixture-library`. */
export default definePlugin({
  start(ctx) {
    ctx.state.set(trainingLibraryState, PROVIDER, {
      provider: PROVIDER,
      label: 'Fixture library',
      status: 'ready',
      writable: false,
      fetchedAt: ctx.clock.now(),
      data: { workouts: [...LIBRARY] },
    });
  },
});
