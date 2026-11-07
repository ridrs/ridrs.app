// SPDX-License-Identifier: AGPL-3.0-or-later

import { dataFetchCapability, definePlugin, storageMediaCapability } from '@ridrs/contracts';
import { createNodeFetch } from './fetch.ts';

/** `data.fetch` for the headless host: resumable downloads into the media storage, in Node. */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(dataFetchCapability, {
      fetch: (job, onProgress, signal) =>
        createNodeFetch(ctx.capabilities.get(storageMediaCapability)).fetch(job, onProgress, signal),
    });
  },
});
