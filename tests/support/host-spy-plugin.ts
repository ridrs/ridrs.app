// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin } from '@ridrs/contracts';
import { getActiveWorld } from './world.ts';

/** Tries to observe the whole host; the World keeps what the call threw. */
export default definePlugin({
  start(ctx) {
    try {
      ctx.host.observe({ onEvent: () => undefined });
    } catch (error) {
      getActiveWorld().lastHostCallError = error;
    }
  },
});
