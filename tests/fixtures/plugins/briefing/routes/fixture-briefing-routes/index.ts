// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  type RouteOffer,
  routeDownloadOptionsService,
  routeFetchService,
  routeOfferState,
} from '@ridrs/contracts';

/** A hill: the profile the route cards and the briefing draw. */
const HILL = [100, 104, 112, 130, 160, 190, 185, 150, 120, 104, 100];

const offer = (
  id: string,
  title: string,
  distance: number,
  minutes: number,
  availability: RouteOffer['availability'] = { state: 'ready' },
): RouteOffer => ({
  id: `fixture-briefing/${id}`,
  kind: 'world',
  title,
  distance,
  ascent: 120,
  duration: minutes * 60,
  sparkline: HILL,
  tags: {},
  availability,
  world: { landscape: 'fixture-briefing/landscape', route: id },
});

/** The qualities the route that is not here yet comes in, by their ids. */
const QUALITIES = [
  { id: 'high', label: 'High', size: 500_000_000, recommended: true },
  { id: 'low', label: 'Low', size: 200_000_000 },
];

/**
 * Three routes with known lengths for the briefing scenarios: a short loop (about 35 min), a long
 * coast road (about 90 min) and a route that is not on this device yet, offered in two qualities:
 * its download starts and never ends.
 */
export default definePlugin({
  start(ctx) {
    for (const each of [
      offer('short-loop', 'Short loop', 18_000, 35),
      offer('long-coast', 'Long coast', 60_000, 90),
      offer('not-here', 'Not here yet', 30_000, 60, { state: 'fetchable', size: 500_000_000 }),
    ]) {
      ctx.state.set(routeOfferState, each.id, each);
    }
    ctx.services.provide(routeDownloadOptionsService, () => ({ options: QUALITIES }));
    ctx.services.provide(routeFetchService, ({ key, option }) => {
      const offer = ctx.state.get(routeOfferState, key);
      const quality = QUALITIES.find((each) => each.id === option);
      if (offer && quality) {
        ctx.state.set(routeOfferState, key, {
          ...offer,
          availability: { state: 'fetching', received: 0, size: quality.size },
        });
      }
      return {};
    });
  },
});
