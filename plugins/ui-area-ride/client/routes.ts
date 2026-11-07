// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RouteOffer } from '@ridrs/contracts';

/** The route ridden last until the rider rides another: the demo course, always on the device. */
export const FIRST_ROUTE = 'ui-landscape-demo/demo-course';

export type Filter = 'flat' | 'hilly' | 'short' | 'favourites';

export const FILTERS: readonly { readonly id: Filter; readonly label: string }[] = [
  { id: 'flat', label: 'Flat' },
  { id: 'hilly', label: 'Hilly' },
  { id: 'short', label: 'Under 45 min' },
  { id: 'favourites', label: 'Favourites' },
];

const providerOf = (offer: RouteOffer) => offer.id.slice(0, offer.id.indexOf('/'));

/**
 * The offers of the app state `route.offer` in the ride page's order: by provider (the plugin id
 * that starts every offer id), then by title. Every plugin start orders them alike.
 */
export function orderOffers(offers: Iterable<RouteOffer>): RouteOffer[] {
  return [...offers].sort(
    (a, b) => providerOf(a).localeCompare(providerOf(b)) || a.title.localeCompare(b.title),
  );
}

/** m climbed per km from which a route counts as hilly. */
const HILLY = 10;

/** The offers that pass every chosen filter, in their order. A course without an end is not short. */
export function filterRoutes(
  offers: readonly RouteOffer[],
  filters: readonly Filter[],
  favourites: readonly string[],
): RouteOffer[] {
  return offers.filter((offer) => {
    const hilly = offer.distance > 0 && offer.ascent / (offer.distance / 1000) >= HILLY;
    return filters.every((filter) => {
      switch (filter) {
        case 'flat':
          return !hilly;
        case 'hilly':
          return hilly;
        case 'short':
          return offer.duration !== undefined && offer.duration < 45 * 60;
        case 'favourites':
          return favourites.includes(offer.id);
      }
    });
  });
}

/** A route's length as the rider reads it: `46.1 km`. */
export const formatDistance = (offer: RouteOffer): string => `${(offer.distance / 1000).toFixed(1)} km`;

/** A route's climb as the rider reads it: `1216 m`. */
export const formatAscent = (offer: RouteOffer): string => `${Math.round(offer.ascent)} m`;

/** What the route details say: country, length and climb, e.g. `France · 46.1 km · 1216 m`. */
export function describeRoute(offer: RouteOffer): string {
  return [offer.tags.country, formatDistance(offer), formatAscent(offer)]
    .filter((part) => part !== undefined)
    .join(' · ');
}

/** A download's size as the rider reads it: `11.2 GB`, `770 MB`. */
export function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
