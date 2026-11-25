// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  netHttpCapability,
  type RouteDownloads,
  type RouteOffer,
  routeCancelService,
  routeDownloaderCapability,
  routeDownloadOptionsService,
  routeFetchService,
  routeOfferState,
  routeRefreshService,
  routeRemoveService,
  storageAppFilesCapability,
} from '@ridrs/contracts';
import { fetchCatalog, keepOnDevice, type RideCatalog, readCache, writeCache } from './catalog.ts';
import { catalogOffers, offerId, routeDownloads } from './offers.ts';

/** Where the app finds ridrs Scenic, and its ride catalog (docs/formats/scenic-ride-catalog-v1.md). */
const SCENIC = 'https://ridrs.app/scenic/';
const CATALOG_URL = new URL('api/ride/v1/catalog.json', SCENIC).href;

// The video routes of ridrs Scenic: the app ships no catalog, this plugin reads Scenic's ride
// catalog through `net.http` and offers each route as a key of the app state `route.offer` (ADR
// 0068). The last catalog is kept in the app files with its ETag: its routes are there at once and
// without a network, and Scenic is asked whether it changed. A route that leaves the catalog goes,
// unless it is on the device. Each route needs its download first, and how it comes onto the
// device is the business of the downloader of its kind (`route.downloader`, ADR 0105): the plugin
// hands each route to it and offers only routes of a kind some downloader fetches. `route.fetch`
// answers once a download started, or says why it cannot; its progress is the offer's key;
// `route.download-options` names the qualities, `route.cancel` stops a download.
export default definePlugin({
  start(ctx) {
    const http = ctx.capabilities.find(netHttpCapability);
    const files = ctx.capabilities.find(storageAppFilesCapability);
    let offers = new Map<string, RouteOffer>();
    /** The downloads of each route's kind, by the route's offer id. */
    const routes = new Map<string, RouteDownloads>();
    const show = (id: string) => {
      const offer = offers.get(id);
      const downloads = routes.get(id);
      if (offer && downloads) {
        // A route on the device shows the pictures of its folder: its overlay and its small one.
        ctx.state.set(routeOfferState, id, { ...offer, ...downloads.pictures(id), availability: downloads.availability(id) });
      }
    };
    /** The downloads of each kind, by the first downloader of it. */
    const kinds = new Map<string, RouteDownloads>();
    for (const downloader of ctx.capabilities.getAll(routeDownloaderCapability)) {
      const downloads = downloader.open(show);
      for (const kind of downloader.kinds) if (!kinds.has(kind)) kinds.set(kind, downloads);
    }
    const failed = (error: unknown) => ctx.logger.error({ error }, 'video-source-scenic: unexpected failure');
    const downloadsOf = (key: string) => {
      const downloads = routes.get(key);
      if (!downloads) throw new Error(`There is no route "${key}"`);
      return downloads;
    };

    /** Offers the routes of `catalog`: withdraws those that left it, then finds the new ones on the device. */
    const apply = async (catalog: RideCatalog) => {
      const described = routeDownloads(catalog).filter((route) => kinds.has(route.kind));
      const next = new Map(
        catalogOffers(catalog)
          .filter((offer) => described.some((route) => route.id === offer.id))
          .map((offer) => [offer.id, offer]),
      );
      for (const id of offers.keys()) if (!next.has(id)) ctx.state.remove(routeOfferState, id);
      offers = next;
      routes.clear();
      for (const route of described) routes.set(route.id, kinds.get(route.kind) as RouteDownloads);
      // The downloads know the routes before their offers show: each offer's size comes from them.
      const finding = [...new Set(kinds.values())].map((downloads) =>
        downloads.setRoutes(described.filter((route) => kinds.get(route.kind) === downloads)),
      );
      for (const id of offers.keys()) show(id);
      await Promise.all(finding);
    };

    ctx.services.provide(routeDownloadOptionsService, async ({ key }) => ({
      options: [...(await downloadsOf(key).options(key))],
    }));
    ctx.services.provide(routeFetchService, ({ key, option }) => {
      const downloads = downloadsOf(key);
      const refusal = downloads.refusal(key, option);
      if (refusal) {
        throw new Error(refusal);
      }
      downloads.fetch(key, option).catch(failed);
      return {};
    });
    ctx.services.provide(routeCancelService, ({ key }) => {
      routes.get(key)?.cancel(key);
      return {};
    });
    ctx.services.provide(routeRefreshService, async ({ key }) => {
      await routes.get(key)?.refresh?.(key);
      return {};
    });
    ctx.services.provide(routeRemoveService, async ({ key }) => {
      await routes.get(key)?.remove(key);
      return {};
    });

    const load = async () => {
      const cached = files ? await readCache(files) : undefined;
      if (cached) await apply(cached.catalog);
      if (!http) return;
      const answer = await fetchCatalog(http, CATALOG_URL, cached?.etag);
      if (answer.status === 'failed') {
        ctx.logger.warn({ reason: answer.reason }, 'video-source-scenic: no new catalog from ridrs Scenic');
        return;
      }
      if (answer.status === 'unchanged') return;
      const onDevice = (id: string) => routes.get(offerId({ id }))?.availability(offerId({ id })).state === 'ready';
      const catalog = keepOnDevice(cached?.catalog, answer.catalog, onDevice);
      await apply(catalog);
      if (files) await writeCache(files, { ...(answer.etag ? { etag: answer.etag } : {}), catalog });
    };
    load().catch(failed);
  },
});
