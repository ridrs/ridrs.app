// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin } from '@ridrs/contracts';
import { z } from 'zod';
import { getActiveWorld } from './world.ts';

/** Writes and reads a machine setting as the World says when it starts; keeps what it read or threw. */
export default definePlugin({
  async start(ctx) {
    const world = getActiveWorld();
    const job = world.settingsProbe;
    const document = (name: string) =>
      ctx.settings.machine({ name, version: 1, schema: z.string() });
    try {
      if (job?.write) {
        await document(job.write.name).write(job.write.value);
      }
      if (job?.read) {
        world.settingsProbeValue = await document(job.read).read();
      }
    } catch (error) {
      world.lastHostCallError = error;
    }
  },
});
