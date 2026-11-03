// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  configSnapshotCapability,
  definePlugin,
  storageAppFilesCapability,
} from '@ridrs/contracts';
import { MemoryAppFiles } from '@ridrs/testing';

/** Steps reach the files through this global handle, so they survive a host restart (see README). */
const STORE = Symbol.for('ridrs.fixture.memory-storage');

export default definePlugin({
  initialize(ctx) {
    const global = globalThis as Record<symbol, unknown>;
    const files = (global[STORE] as MemoryAppFiles | undefined) ?? new MemoryAppFiles();
    global[STORE] = files;
    ctx.capabilities.provide(storageAppFilesCapability, files);
    ctx.capabilities.provide(configSnapshotCapability, {
      section: ctx.manifest.id,
      snapshot: () => ({ storage: 'memory' }),
    });
  },
});
