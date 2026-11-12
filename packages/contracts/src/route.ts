// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { rideWorldSchema } from './activity.ts';
import { defineState } from './app-state.ts';
import { defineService } from './services.ts';

/**
 * A route a plugin offers on the ride page (docs/ideas/video-sources.md): a world's course, a
 * video of a source. The ride page lists, filters and starts every offer alike.
 */
export const routeOfferSchema = z
  .object({
    /** `<pluginId>/<route>`: unique across providers. */
    id: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    kind: z.enum(['world', 'video']),
    title: z.string().min(1),
    /** m along the route, and m climbed on it. */
    distance: z.number().nonnegative(),
    ascent: z.number().nonnegative(),
    /** s a ride takes about; none for a course without an end. */
    duration: z.number().positive().optional(),
    /** Elevations (m) evenly spaced from the start to the end, for its profile on a card and in the details. */
    sparkline: z.array(z.number()).min(2).optional(),
    /** A picture of the route, as a URL the UI may load. */
    thumbnail: z.string().min(1).optional(),
    /**
     * The route's categorised climbs, in their order along it (ADR 0070): from the foot to the
     * summit in m along the route, m climbed, the average gradient in % and the summit's altitude;
     * the name of the summit or the climb where the provider knows it.
     */
    climbs: z
      .array(
        z
          .object({
            category: z.enum(['HC', '1', '2', '3', '4']),
            start: z.number().nonnegative(),
            end: z.number().nonnegative(),
            gain: z.number().nonnegative(),
            grade: z.number(),
            summit: z.number(),
            name: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    tags: z
      .object({
        country: z.string().min(1).optional(),
        level: z.string().min(1).optional(),
        tour: z
          .object({ name: z.string().min(1), part: z.number().int().positive() })
          .strict()
          .optional(),
      })
      .strict(),
    /** Who made third-party content and under which license (LICENSING.md, section 6a). */
    credits: z
      .object({
        author: z.string().min(1),
        source: z.string().min(1),
        url: z.string().url(),
        license: z.string().min(1),
      })
      .strict()
      .optional(),
    /**
     * `ready` can be ridden now; `fetchable` needs a download of `size` bytes first, `fetching` is
     * downloading it, `failed` could not and says why. A downloaded route names the URL of each of
     * its files on this device by file name (`route.json`, `video.mp4`, … for a video): only the
     * media storage knows how to make them, so the UI never builds one. It may be removable.
     */
    availability: z.discriminatedUnion('state', [
      z
        .object({
          state: z.literal('ready'),
          files: z.record(z.string().min(1), z.string().min(1)).optional(),
          removable: z.boolean().optional(),
        })
        .strict(),
      z.object({ state: z.literal('fetchable'), size: z.number().int().positive() }).strict(),
      z
        .object({
          state: z.literal('fetching'),
          received: z.number().int().nonnegative(),
          size: z.number().int().positive(),
        })
        .strict(),
      z
        .object({
          state: z.literal('failed'),
          reason: z.string().min(1),
          size: z.number().int().positive(),
        })
        .strict(),
    ]),
    /** What Go puts into `activity.start-requested`. */
    world: rideWorldSchema,
  })
  .strict();

export type RouteOffer = z.infer<typeof routeOfferSchema>;

/**
 * Every offer of every provider, by its id (ADR 0068): each provider owns the keys of its offers
 * and changes one key at a time, e.g. for a download's progress. The ride page watches the topic.
 */
export const routeOfferState = defineState('route.offer', routeOfferSchema);

const routeKeyRequest = z.object({ key: routeOfferSchema.shape.id }).strict();

/**
 * Downloads a `fetchable` or `failed` offer: answered by the offer's provider once the download
 * started (its progress and a failure are the offer's state), rejected with the reason when it
 * cannot start. An offer that is `ready` or `fetching` stays as it is.
 */
export const routeFetchService = defineService('route.fetch', {
  request: routeKeyRequest,
  response: z.object({}).strict(),
  keyedBy: routeOfferState,
});

/**
 * Cancels the download of an offer on its way; the offer is `fetchable` again and what was fetched
 * so far stays for the next download. An offer that is not on its way stays as it is.
 */
export const routeCancelService = defineService('route.cancel', {
  request: routeKeyRequest,
  response: z.object({}).strict(),
  keyedBy: routeOfferState,
});

/** Removes a downloaded offer from the device; answered once it is gone. */
export const routeRemoveService = defineService('route.remove', {
  request: routeKeyRequest,
  response: z.object({}).strict(),
  keyedBy: routeOfferState,
});

/**
 * A provider that imports routes from packages the rider brings (ADR 0090), by its plugin id: the
 * list its routes go to, and how its last import went. `importing` names the chosen file while it
 * becomes a route, `failed` says why it could not; once a route is imported it is an offer and the
 * provider is `idle` again. The ride page shows an import in a list only while its provider is here.
 */
export const routeImportSchema = z.discriminatedUnion('state', [
  z.object({ kind: routeOfferSchema.shape.kind, state: z.literal('idle') }).strict(),
  z
    .object({
      kind: routeOfferSchema.shape.kind,
      state: z.literal('importing'),
      file: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: routeOfferSchema.shape.kind,
      state: z.literal('failed'),
      file: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),
]);

export type RouteImport = z.infer<typeof routeImportSchema>;

export const routeImportState = defineState('route.import', routeImportSchema);

/**
 * Imports a route from a package the rider chooses in the system's open dialog: answered once the
 * dialog closed, `started: false` when the rider cancelled. The import's progress and a failure
 * are the provider's key of `route.import`; the route is then a key of `route.offer`.
 */
export const routeImportService = defineService('route.import', {
  request: z.object({ key: z.string().min(1) }).strict(),
  response: z.object({ started: z.boolean() }).strict(),
  keyedBy: routeImportState,
});
