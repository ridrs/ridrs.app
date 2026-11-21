// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  dataArchiveCapability,
  dataFetchCapability,
  dataPictureCapability,
  definePlugin,
  netHttpCapability,
  type RouteOffer,
  routeCancelService,
  routeFetchService,
  routeOfferState,
  routeRemoveService,
  storageAppFilesCapability,
  storageMediaCapability,
} from '@ridrs/contracts';
import { fetchCatalog, keepOnDevice, type RideCatalog, readCache, writeCache } from './catalog.ts';
import { VideoDownloads } from './downloads.ts';
import { catalogOffers, downloadables, offerId } from './offers.ts';

/** Where the app finds ridrs Scenic, and its ride catalog (docs/formats/scenic-ride-catalog-v1.md). */
const SCENIC = 'https://ridrs.app/scenic/';
const CATALOG_URL = new URL('api/ride/v1/catalog.json', SCENIC).href;

// The video routes of ridrs Scenic: the app ships no catalog, this plugin reads Scenic's ride
// catalog through `net.http` and offers each route as a key of the app state `route.offer` (ADR
// 0068). The last catalog is kept in the app files with its ETag: its routes are there at once and
// without a network, and Scenic is asked whether it changed. A route that leaves the catalog goes,
// unless it is on the device. Each route needs its download first: the plugin has it fetched,
// imported and kept in the media storage (docs/ideas/video-sources.md), a download of the former
// `video-source-vangestel` included. `route.fetch` answers once a download started, or says why it
// cannot; its progress is the offer's key; `route.cancel` stops it.
export default definePlugin({
  start(ctx) {
    const http = ctx.capabilities.find(netHttpCapability);
    const files = ctx.capabilities.find(storageAppFilesCapability);
    let offers = new Map<string, RouteOffer>();
    const show = (id: string) => {
      const offer = offers.get(id);
      if (offer) {
        // A route on the device shows the pictures of its folder: its overlay and its small one.
        ctx.state.set(routeOfferState, id, { ...offer, ...downloads.picturesOf(id), availability: downloads.availability(id) });
      }
    };
    const downloads = new VideoDownloads([], show);
    const failed = (error: unknown) => ctx.logger.error({ error }, 'video-source-scenic: unexpected failure');

    /** Offers the routes of `catalog`: withdraws those that left it, then finds the new ones on the device. */
    const apply = async (catalog: RideCatalog) => {
      const next = new Map(catalogOffers(catalog).map((offer) => [offer.id, offer]));
      for (const id of offers.keys()) if (!next.has(id)) ctx.state.remove(routeOfferState, id);
      offers = next;
      // The downloads know the routes before their offers show: each offer's size comes from them.
      const finding = downloads.setRoutes(downloadables(catalog));
      for (const id of offers.keys()) show(id);
      await finding;
    };

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

    const load = async () => {
      await downloads.connect({
        media: ctx.capabilities.find(storageMediaCapability),
        fetch: ctx.capabilities.find(dataFetchCapability),
        archive: ctx.capabilities.find(dataArchiveCapability),
        picture: ctx.capabilities.find(dataPictureCapability),
      });
      const cached = files ? await readCache(files) : undefined;
      if (cached) await apply(cached.catalog);
      if (!http) return;
      const answer = await fetchCatalog(http, CATALOG_URL, cached?.etag);
      if (answer.status === 'failed') {
        ctx.logger.warn({ reason: answer.reason }, 'video-source-scenic: no new catalog from ridrs Scenic');
        return;
      }
      if (answer.status === 'unchanged') return;
      const onDevice = (id: string) => downloads.availability(offerId({ id })).state === 'ready';
      const catalog = keepOnDevice(cached?.catalog, answer.catalog, onDevice);
      await apply(catalog);
      if (files) await writeCache(files, { ...(answer.etag ? { etag: answer.etag } : {}), catalog });
    };
    load().catch(failed);
  },
});

