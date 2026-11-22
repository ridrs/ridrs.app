// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RouteDownload, RouteOffer } from '@ridrs/contracts';
import type { CatalogRoute, RideCatalog } from './catalog.ts';

type Availability = RouteOffer['availability'];

/** The kind of download of a catalog's route that names none: a package with its video. */
export const PACKAGE_KIND = 'ride-package';

/** The kind of a route's download (ADR 0105): the downloader of that kind fetches it. */
export const kindOf = (route: CatalogRoute) => route.download.kind ?? PACKAGE_KIND;

export const PLUGIN = 'video-source-scenic';

type Category = NonNullable<RouteOffer['climbs']>[number]['category'];

/** The offer's id of a route of the catalog: `video-source-scenic/<Scenic's id>`. */
export const offerId = (route: { readonly id: string }) => `${PLUGIN}/${route.id}`;

/**
 * Where the former plugin `video-source-vangestel` kept a route it downloaded (ADR 0094): its id
 * there was the route's slug, Scenic's id less `vg-`.
 */
export const formerFolder = (route: CatalogRoute) =>
  route.source === 'vangestel' && route.id.startsWith('vg-')
    ? `videos/video-source-vangestel/${route.id.slice(3)}`
    : undefined;

/** A picture by its name: the overlay file a card's and a route's details show. */
const isPicture = (path: string) => /\.(jpe?g|png)$/i.test(path);

/** A route's picture in full size: the overlay's picture, else its small one. */
const pictureOf = (route: CatalogRoute) => route.overlay.find((file) => isPicture(file.path))?.url ?? route.tile;

/** The country's English name by its ISO code, as the ride page names countries (`tags.country`). */
const COUNTRIES = new Intl.DisplayNames('en', { type: 'region' });
function countryName(code: string | undefined): string | undefined {
  if (!code) return undefined;
  try {
    return COUNTRIES.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Every route of the catalog as its downloader sees it: its kind, its size, and the catalog's
 * description of its download (a package's URL and ETag, a YouTube video's id and frame rate) with
 * the overlay's sizes and hashes; and where a former source kept it.
 */
export function routeDownloads(catalog: RideCatalog): RouteDownload[] {
  return catalog.routes.map((route) => {
    const former = formerFolder(route);
    const { kind: _kind, size, ...download } = route.download;
    return {
      id: offerId(route),
      kind: kindOf(route),
      size,
      details: {
        ...download,
        overlay: route.overlay.map(({ path, size: bytes, sha256, url }) => ({ path, size: bytes, sha256, url })),
      },
      ...(former ? { former } : {}),
    };
  });
}

/**
 * Every route of the catalog as an offer. Each needs its download first: `availability` says how
 * far it is (fetchable without it). Its picture is the overlay's picture in full size, its card's
 * Scenic's small one; a route on the device shows its own (the plugin lays them over these).
 */
export function catalogOffers(
  catalog: RideCatalog,
  availability: (id: string) => Availability | undefined = () => undefined,
): RouteOffer[] {
  return catalog.routes.map((route) => {
    const id = offerId(route);
    const source = catalog.sources[route.source];
    const author = route.author ?? source?.author;
    const thumbnail = pictureOf(route);
    return {
      id,
      kind: 'video',
      title: route.title,
      distance: route.distance,
      ascent: route.ascent,
      duration: route.duration,
      sparkline: [...route.sparkline],
      ...(thumbnail ? { thumbnail } : {}),
      ...(route.tile ? { tile: route.tile } : {}),
      climbs: route.climbs.map((climb) => ({ ...climb, category: climb.category as Category })),
      tags: { country: countryName(route.country), level: route.level, tour: route.tour },
      ...(source && author
        ? { credits: { author, source: source.name, url: route.page, license: source.license.name } }
        : {}),
      availability: availability(id) ?? { state: 'fetchable', size: route.download.size },
      world: { landscape: 'ui-world-video/landscape', route: id },
    };
  });
}
