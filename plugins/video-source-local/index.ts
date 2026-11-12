// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  dataPickCapability,
  definePlugin,
  routeImportService,
  routeImportState,
  routeOfferState,
  routeRemoveService,
  storageMediaCapability,
  videoImporterCapability,
} from '@ridrs/contracts';
import { LocalVideos, PLUGIN } from './local.ts';

// The video routes a rider imports from packages of their own (ADR 0090): one key of the app state
// `route.offer` per imported route, beside the routes of the catalogs, and the plugin's key of
// `route.import` while it can import. `route.import` opens the system's open dialog through
// `data.pick` and answers once it closed; the import's progress and a failure are that key.
export default definePlugin({
  start(ctx) {
    const failed = (error: unknown) => ctx.logger.error({ error }, 'video-source-local: unexpected failure');
    const videos = new LocalVideos({
      offer: (id, offer) => (offer ? ctx.state.set(routeOfferState, id, offer) : ctx.state.remove(routeOfferState, id)),
      importer: (state) =>
        state ? ctx.state.set(routeImportState, PLUGIN, state) : ctx.state.remove(routeImportState, PLUGIN),
    });
    ctx.services.provide(routeImportService, async () => ({ started: await videos.import() }));
    ctx.services.provide(routeRemoveService, async ({ key }) => {
      await videos.remove(key);
      return {};
    });
    videos
      .connect({
        media: ctx.capabilities.find(storageMediaCapability),
        pick: ctx.capabilities.find(dataPickCapability),
        importers: () => ctx.capabilities.getAll(videoImporterCapability),
      })
      .catch(failed);
  },
});
