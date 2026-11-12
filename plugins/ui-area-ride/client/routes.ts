// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RouteOffer } from '@ridrs/contracts';
import type { Messages } from './i18n/index.ts';

/** The route ridden last until the rider rides another: the demo course, always on the device. */
export const FIRST_ROUTE = 'ui-landscape-demo/demo-course';

export type Filter = 'flat' | 'hilly' | 'short' | 'favourites';

export const FILTERS: readonly Filter[] = ['flat', 'hilly', 'short', 'favourites'];

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
export const formatDistance = (offer: RouteOffer, text: Messages): string => `${text.km(offer.distance)} km`;

/** A route's climb as the rider reads it: `1216 m`. */
export const formatAscent = (offer: RouteOffer, text: Messages): string => text.metres(offer.ascent);

/** A categorised climb's name: `HC` or `Cat 1` to `Cat 4` (ADR 0070). */
export type Climb = NonNullable<RouteOffer['climbs']>[number];
export const climbCategory = (climb: Climb, text: Messages): string => text.category(climb.category);

/** A categorised climb in the route details, e.g. `Cat 1: summit 1244 m at km 14.3 · 14.3 km at 4.9 %`. */
export function describeClimb(climb: Climb, text: Messages): string {
  return text.describeClimb(
    climbCategory(climb, text),
    climb.summit,
    text.km(climb.end),
    text.km(climb.end - climb.start),
    climb.grade,
  );
}

/** What the route details say over its picture: what it is and where, e.g. `Video · France · Grimone, part 1`. */
export function describeRoute(offer: RouteOffer, text: Messages): string {
  const { country, tour } = offer.tags;
  return [
    offer.kind === 'video' ? text.video : text.route,
    country && (text.countries[country] ?? country),
    tour && text.part(tour.name, tour.part),
  ]
    .filter((part) => part !== undefined)
    .join(' · ');
}

/** How long a ride takes about, as the rider reads it: `about 2 h 53 min`, `about 44 min`. */
export function formatDuration(seconds: number, text: Messages): string {
  return text.about(Math.round(seconds / 60));
}

/** A download's size as the rider reads it: `11.2 GB`, `770 MB`. */
export function formatSize(bytes: number, text: Messages): string {
  return text.size(bytes);
}
