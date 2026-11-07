// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RouteOffer } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { describeRoute, filterRoutes, formatSize, orderOffers } from './routes.ts';

const offer = (id: string, distance: number, ascent: number, duration?: number): RouteOffer => ({
  id: `test/${id}`,
  kind: 'world',
  title: id,
  distance,
  ascent,
  duration,
  tags: {},
  availability: { state: 'ready' },
  world: { landscape: 'test/landscape' },
});

const OFFERS = [
  offer('coast', 24_000, 60, 40 * 60),
  offer('alps', 32_000, 840, 75 * 60),
  offer('pass', 8_600, 428, 44 * 60),
  offer('open', 4_500, 50),
];
const titles = (offers: readonly RouteOffer[]) => offers.map((o) => o.title);

describe('filterRoutes', () => {
  it('keeps every offer without filters', () => {
    expect(filterRoutes(OFFERS, [], [])).toHaveLength(OFFERS.length);
  });

  it('tells flat from hilly by metres of climb per kilometre', () => {
    expect(titles(filterRoutes(OFFERS, ['flat'], []))).toEqual(['coast']);
    expect(titles(filterRoutes(OFFERS, ['hilly', 'short'], []))).toEqual(['pass']);
  });

  it('counts a course without an end as not short, and combines filters with the favourites', () => {
    expect(titles(filterRoutes(OFFERS, ['short'], []))).toEqual(['coast', 'pass']);
    expect(titles(filterRoutes(OFFERS, ['favourites', 'short'], ['test/coast', 'test/open']))).toEqual(['coast']);
  });
});

describe('describeRoute and formatSize', () => {
  it('reads like the card', () => {
    expect(describeRoute({ ...offer('pennes', 46_117, 1216), tags: { country: 'France' } })).toBe(
      'France · 46.1 km · 1216 m',
    );
    expect(describeRoute(offer('open', 4_500, 50))).toBe('4.5 km · 50 m');
    expect(formatSize(11_213_923_126)).toBe('11.2 GB');
    expect(formatSize(770_825_204)).toBe('771 MB');
  });
});

describe('orderOffers', () => {
  it('orders the offers of the app state by provider, then title', () => {
    const of = (id: string, title: string) => ({ ...offer(title, 1000, 0), id });
    const ordered = orderOffers([
      of('video-source-b/x', 'Alpe'),
      of('ui-landscape-demo/demo-course', 'Demo course'),
      of('video-source-a/y', 'Zermatt'),
      of('video-source-a/z', 'Bern'),
    ]);
    expect(ordered.map((o) => o.id)).toEqual([
      'ui-landscape-demo/demo-course',
      'video-source-a/z',
      'video-source-a/y',
      'video-source-b/x',
    ]);
  });
});
