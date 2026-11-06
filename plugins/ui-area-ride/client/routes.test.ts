// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { filterRoutes, ROUTES } from './routes.ts';

const names = (routes: readonly { readonly name: string }[]) => routes.map((r) => r.name);

describe('filterRoutes', () => {
  it('keeps every route without filters', () => {
    expect(filterRoutes(ROUTES, [], [])).toHaveLength(ROUTES.length);
  });

  it('tells flat from hilly by metres of climb per kilometre', () => {
    expect(names(filterRoutes(ROUTES, ['flat'], []))).toEqual([
      'Coastal Flats',
      'City Criterium',
      'Harbour Morning Video',
    ]);
    expect(names(filterRoutes(ROUTES, ['hilly', 'short'], []))).toEqual([]);
  });

  it('combines filters with the favourites', () => {
    expect(names(filterRoutes(ROUTES, ['favourites', 'short'], ['coastal-flats', 'alpine-loop']))).toEqual([
      'Coastal Flats',
    ]);
  });
});
