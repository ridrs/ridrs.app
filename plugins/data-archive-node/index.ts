// SPDX-License-Identifier: AGPL-3.0-or-later

import { dataArchiveCapability, definePlugin, storageMediaCapability } from '@ridrs/contracts';
import { createNodeArchive } from './archive.ts';

/** `data.archive` for the headless host and the tests: ZIPs in the media storage, unpacked in Node. */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(dataArchiveCapability, {
      extract: (archive, directory) =>
        createNodeArchive(ctx.capabilities.get(storageMediaCapability)).extract(archive, directory),
    });
  },
});
