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
    readonly thumbnail?: string;
    /** As `categoriseClimbs` gave them; JSON knows the category only as a string. */
    readonly climbs?: readonly (Omit<Climb, 'category'> & { readonly category: string })[];
    readonly download: { readonly url: string; readonly format: string; readonly size: number; readonly etag?: string };
  }[];
}

const PLUGIN = 'video-source-vangestel';
const offerId = (route: { readonly id: string }) => `${PLUGIN}/${route.id}`;

/** Every route of the catalog and what its download takes. */
export function downloadables(catalog: Catalog): Downloadable[] {
  const { source } = catalog;
  return catalog.routes.map((route) => ({
    id: offerId(route),
    url: route.download.url,
    size: route.download.size,
    etag: route.download.etag,
    format: route.download.format,
    facts: {
      title: route.title,
      source: { name: source.name, author: source.author, url: route.page, license: source.license.name },
    },
  }));
}

/**
 * Every route of the catalog as an offer. Each needs its download first: `availability` says how
 * far it is (fetchable without it). `thumbnail` gives the URL of a route's
 * `catalog/<id>/thumbnail.jpg` that the UI can load.
 */
export function catalogOffers(
  catalog: Catalog,
  thumbnail: (id: string) => string,
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
      thumbnail: route.thumbnail ? thumbnail(route.id) : undefined,
      climbs: route.climbs?.map((climb) => ({ ...climb, category: climb.category as Climb['category'] })),
      tags: { country: route.country, level: route.level, tour: route.tour },
      credits: { author: source.author, source: source.name, url: route.page, license: source.license.name },
      availability: availability(id) ?? { state: 'fetchable', size: route.download.size },
      world: { landscape: 'ui-world-video/landscape', route: id },
    };
  });
}
