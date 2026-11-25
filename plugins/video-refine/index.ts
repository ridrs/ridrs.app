// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  definePlugin,
  routeOfferState,
  routeRefreshService,
  storageMediaCapability,
  videoInterpolatorCapability,
  videoRefineService,
  videoRefinementState,
} from '@ridrs/contracts';
import { Refiner } from './refiner.ts';

const refiners = new WeakMap<object, Refiner>();

// Refines each downloaded video route with in-between frames where a rider at 100 W would see
// fewer than 30 frames per second (ADR 0110): `storage.media` holds the route, the device's
// `video.interpolate` computes the stretches. App state and services only (rule 13): the
// refinement's course is the key of its offer in `video.refinement`, `video.refine` starts or
// cancels it, and `route.refresh` has the source offer the new files. It waits while a ride runs.
export default definePlugin({
  start(ctx) {
    const refiner = new Refiner({
      media: ctx.capabilities.find(storageMediaCapability),
      interpolator: ctx.capabilities.find(videoInterpolatorCapability),
      publish: (key, state) =>
        state === undefined ? ctx.state.remove(videoRefinementState, key) : ctx.state.set(videoRefinementState, key, state),
      refresh: async (key) => {
        await ctx.services.call(routeRefreshService, { key });
      },
      warn: (message, error) => ctx.logger.warn({ error }, message),
    });
    ctx.services.provide(videoRefineService, ({ key, action }) => {
      if (action === 'start') refiner.start(key);
      else refiner.cancel(key);
      return {};
    });
    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) =>
      refiner.ride(payload.state === 'running' || payload.state === 'paused'),
    );
    ctx.state.watch(routeOfferState, ({ entries }) => refiner.offers(entries));
    refiners.set(ctx, refiner);
  },

  stop(ctx) {
    refiners.get(ctx)?.dispose();
  },
});
