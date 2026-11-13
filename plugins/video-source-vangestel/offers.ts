// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RouteOffer } from '@ridrs/contracts';
import type { Climb } from './climbs.ts';
import type { Availability, Downloadable } from './downloads.ts';

/** The parts of `catalog/index.json` (built by `pnpm fetch:video-catalog`) that the plugin uses. */
export interface Catalog {
  readonly source: {
    readonly name: string;
    readonly author: string;
    readonly license: { readonly name: string };
  };
  readonly routes: readonly {
    readonly id: string;
    readonly title: string;
    readonly page: string;
    readonly country?: string;
    readonly level?: string;
    readonly tour?: { readonly name: string; readonly part: number };
    readonly distance: number;
    readonly ascent: number;
    readonly duration: number;
    readonly sparkline: readonly number[];
    /** The route's small picture for a card, `<id>/thumbnail.jpg`. */
    readonly thumbnail?: string;
    /** Files that improve the route's package (ADR 0094): `<id>/overlay/<path>`. */
    readonly overlay?: readonly { readonly path: string; readonly size: number; readonly sha256: string }[];
    /** As `categoriseClimbs` gave them; JSON knows the category only as a string. */
    readonly climbs?: readonly (Omit<Climb, 'category'> & { readonly category: string })[];
    readonly download: { readonly url: string; readonly format: string; readonly size: number; readonly etag?: string };
  }[];
}

const PLUGIN = 'video-source-vangestel';

/** A route's picture in full size: the overlay's picture, else its small one. */
function pictureOf(route: Catalog['routes'][number], files: CatalogFiles): string | undefined {
  const picture = route.overlay?.find((file) => isPicture(file.path));
  if (picture) return files.overlay(route.id, picture.path);
  return route.thumbnail ? files.tile(route.id) : undefined;
}
const offerId = (route: { readonly id: string }) => `${PLUGIN}/${route.id}`;

/** The URLs the app ships a route's catalog files at, so that the bundler finds and ships them. */
export interface CatalogFiles {
  /** `catalog/<id>/thumbnail.jpg`: the route's small picture for a card. */
  tile(id: string): string;
  /** `catalog/<id>/overlay/<path>`: a file that improves the route's package. */
  overlay(id: string, path: string): string;
}

/** A picture by its name: the overlay file a card's and a route's details show. */
const isPicture = (path: string) => /\.(jpe?g|png)$/i.test(path);

/** Every route of the catalog and what its download takes, its overlay included. */
export function downloadables(catalog: Catalog, files: CatalogFiles): Downloadable[] {
  return catalog.routes.map((route) => ({
    id: offerId(route),
    url: route.download.url,
    size: route.download.size,
    etag: route.download.etag,
    overlay: (route.overlay ?? []).map((file) => ({
      path: file.path,
      sha256: file.sha256,
      url: files.overlay(route.id, file.path),
    })),
  }));
}

/**
 * Every route of the catalog as an offer. Each needs its download first: `availability` says how
 * far it is (fetchable without it). Its picture is the catalog's overlay picture in full size, its
 * card's the catalog's small `thumbnail.jpg`; a route on the device shows its own (`picturesOf`).
 */
export function catalogOffers(
  catalog: Catalog,
  files: CatalogFiles,
  availability: (id: string) => Availability | undefined = () => undefined,
): RouteOffer[] {
  const { source } = catalog;
  return catalog.routes.map((route) => {
    const id = offerId(route);
    return {
      id,
      kind: 'video',
      title: route.title,
      distance: route.distance,
      ascent: route.ascent,
      duration: route.duration,
      sparkline: [...route.sparkline],
      thumbnail: pictureOf(route, files),
      tile: route.thumbnail ? files.tile(route.id) : undefined,
      climbs: route.climbs?.map((climb) => ({ ...climb, category: climb.category as Climb['category'] })),
      tags: { country: route.country, level: route.level, tour: route.tour },
      credits: { author: source.author, source: source.name, url: route.page, license: source.license.name },
      availability: availability(id) ?? { state: 'fetchable', size: route.download.size },
      world: { landscape: 'ui-world-video/landscape', route: id },
    };
  });
}
