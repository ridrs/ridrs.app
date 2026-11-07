// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  dataFetchCapability,
  definePlugin,
  routeCancelService,
  routeFetchService,
  routeOfferState,
  routeRemoveService,
  storageMediaCapability,
  videoImporterCapability,
} from '@ridrs/contracts';
import catalog from './catalog/index.json' with { type: 'json' };
import { VideoDownloads } from './downloads.ts';
import { catalogOffers, downloadables } from './offers.ts';

const thumbnail = (id: string) =>
  // A fixed shape, so that the bundler finds and ships every thumbnail.
  new URL(`./catalog/${id}/thumbnail.jpg`, import.meta.url).href;

// The video rides of cycling.vangestel.online, offered to the ride page from the catalog that
// ships with the plugin (`catalog/`, built by `pnpm fetch:video-catalog`): one key of the app
// state `route.offer` per route (ADR 0068). Each route needs its download first: the plugin has it
// fetched, imported and kept in the media storage (docs/ideas/video-sources.md). `route.fetch`
// answers once a download started, or says why it cannot; its progress is the offer's key;
// `route.cancel` stops it.
export default definePlugin({
  start(ctx) {
    const offers = new Map(catalogOffers(catalog, thumbnail).map((offer) => [offer.id, offer]));
    const downloads = new VideoDownloads(downloadables(catalog), (id) => {
      const offer = offers.get(id);
      if (offer) {
        ctx.state.set(routeOfferState, id, { ...offer, availability: downloads.availability(id) });
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
        importers: () => ctx.capabilities.getAll(videoImporterCapability),
      })
      .catch(failed);
  },
});
