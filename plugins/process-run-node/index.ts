// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, processRunCapability, storageAppFilesCapability } from '@ridrs/contracts';
import { nodeProcessRun } from './run.ts';

/** `process.run` on Node (ADR 0106): the programs the rider granted to installed plugins. */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(processRunCapability, nodeProcessRun(ctx.capabilities.find(storageAppFilesCapability)));
  },
});
