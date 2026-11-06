// SPDX-License-Identifier: AGPL-3.0-or-later

/** A place to ride. Placeholders of the early alpha: every Go rides the demo landscape. */
export interface Route {
  readonly id: string;
  readonly name: string;
  readonly world: string;
  readonly kind: 'world' | 'video';
  readonly km: number;
  readonly climb: number;
  readonly minutes: number;
}

export const ROUTES: readonly Route[] = [
  { id: 'alpine-loop', name: 'Alpine Loop', world: 'Ridrs Alps', kind: 'world', km: 32, climb: 840, minutes: 75 },
  { id: 'coastal-flats', name: 'Coastal Flats', world: 'Ridrs Coast', kind: 'world', km: 24, climb: 60, minutes: 40 },
  { id: 'volcano-climb', name: 'Volcano Climb', world: 'Ridrs Islands', kind: 'world', km: 18, climb: 1120, minutes: 70 },
  { id: 'city-criterium', name: 'City Criterium', world: 'Ridrs City', kind: 'world', km: 12, climb: 40, minutes: 20 },
  { id: 'passo-video', name: 'Mountain Pass Video', world: 'Real video', kind: 'video', km: 21, climb: 1300, minutes: 95 },
  { id: 'harbour-video', name: 'Harbour Morning Video', world: 'Real video', kind: 'video', km: 15, climb: 90, minutes: 30 },
];

export type Filter = 'flat' | 'hilly' | 'short' | 'favourites';

export const FILTERS: readonly { readonly id: Filter; readonly label: string }[] = [
  { id: 'flat', label: 'Flat' },
  { id: 'hilly', label: 'Hilly' },
  { id: 'short', label: 'Under 45 min' },
  { id: 'favourites', label: 'Favourites' },
];

/** The routes that pass every chosen filter, in their order. */
export function filterRoutes(
  routes: readonly Route[],
  filters: readonly Filter[],
  favourites: readonly string[],
): Route[] {
  return routes.filter((route) =>
    filters.every((filter) => {
      switch (filter) {
        case 'flat':
          return route.climb / route.km < 10;
        case 'hilly':
          return route.climb / route.km >= 10;
        case 'short':
          return route.minutes < 45;
        case 'favourites':
          return favourites.includes(route.id);
      }
    }),
  );
}
