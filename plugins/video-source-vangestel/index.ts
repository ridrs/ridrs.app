// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  dataFetchCapability,
  definePlugin,
  routeCancelService,
  routeFetchService,
  routeOfferState,
  routeRemoveService,
  storageMediaCapability,
  dataArchiveCapability,
  dataPictureCapability,
} from '@ridrs/contracts';
import catalog from './catalog/index.json' with { type: 'json' };
import { VideoDownloads } from './downloads.ts';
import { type CatalogFiles, catalogOffers, downloadables } from './offers.ts';

const files: CatalogFiles = {
  // Fixed shapes, so that the bundler finds and ships every picture and overlay file.
  tile: (id) => new URL(`./catalog/${id}/thumbnail.jpg`, import.meta.url).href,
  overlay: (id, path) => new URL(`./catalog/${id}/overlay/${path}`, import.meta.url).href,
};

// The video rides of cycling.vangestel.online, offered to the ride page from the catalog that
// ships with the plugin (`catalog/`, built by `pnpm fetch:video-catalog`): one key of the app
// state `route.offer` per route (ADR 0068). Each route needs its download first: the plugin has it
// fetched, imported and kept in the media storage (docs/ideas/video-sources.md). `route.fetch`
// answers once a download started, or says why it cannot; its progress is the offer's key;
// `route.cancel` stops it.
export default definePlugin({
  start(ctx) {
    const offers = new Map(catalogOffers(catalog, files).map((offer) => [offer.id, offer]));
    const downloads = new VideoDownloads(downloadables(catalog, files), (id) => {
      const offer = offers.get(id);
      if (offer) {
        // A route on the device shows the pictures of its folder: its overlay and its small one.
        ctx.state.set(routeOfferState, id, { ...offer, ...downloads.picturesOf(id), availability: downloads.availability(id) });
      }
    });
    for (const offer of offers.values()) {
      ctx.state.set(routeOfferState, offer.id, offer);
    }
    const failed = (error: unknown) => ctx.logger.error({ error }, 'video-source-vangestel: unexpected failure');
    ctx.services.provide(routeFetchService, ({ key }) => {
      const refusal = downloads.refusal(key);
      if (refusal) {
        throw new Error(refusal);
      }
      downloads.fetch(key).catch(failed);
      return {};
    });
    ctx.services.provide(routeCancelService, ({ key }) => {
      downloads.cancel(key);
      return {};
    });
    ctx.services.provide(routeRemoveService, async ({ key }) => {
      await downloads.remove(key);
      return {};
    });
    downloads
      .connect({
        media: ctx.capabilities.find(storageMediaCapability),
        fetch: ctx.capabilities.find(dataFetchCapability),
        archive: ctx.capabilities.find(dataArchiveCapability),
        picture: ctx.capabilities.find(dataPictureCapability),
      })
      .catch(failed);
  },
});
