// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  dataDropCapability,
  dataPickCapability,
  definePlugin,
  routeImportPreviewService,
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
// `data.pick` and answers once it closed, or takes a file dragged onto the window (`data.drop`,
// ADR 0093), which `route.import-preview` previews first; the import's progress and a failure are
// that key.
export default definePlugin({
  start(ctx) {
    const failed = (error: unknown) => ctx.logger.error({ error }, 'video-source-local: unexpected failure');
    const videos = new LocalVideos({
      offer: (id, offer) => (offer ? ctx.state.set(routeOfferState, id, offer) : ctx.state.remove(routeOfferState, id)),
      importer: (state) =>
        state ? ctx.state.set(routeImportState, PLUGIN, state) : ctx.state.remove(routeImportState, PLUGIN),
    });
    ctx.services.provide(routeImportService, async ({ file }) => ({ started: await videos.import(file) }));
    ctx.services.provide(routeImportPreviewService, ({ file }) => videos.preview(file));
    ctx.services.provide(routeRemoveService, async ({ key }) => {
      await videos.remove(key);
      return {};
    });
    videos
      .connect({
        media: ctx.capabilities.find(storageMediaCapability),
        pick: ctx.capabilities.find(dataPickCapability),
        drop: ctx.capabilities.find(dataDropCapability),
        importers: () => ctx.capabilities.getAll(videoImporterCapability),
      })
      .catch(failed);
  },
});
