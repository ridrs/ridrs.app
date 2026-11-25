// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { rideWorldSchema } from './activity.ts';
import { defineState } from './app-state.ts';
import { defineCapability } from './capabilities.ts';
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
     * The same picture small, about 800 px wide, for a card: it loads and decodes quicker than
     * `thumbnail`, which a card shows where there is none.
     */
    tile: z.string().min(1).optional(),
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
     * downloading it, `failed` could not and says why; `importing` is a route the rider brought
     * that becomes one now (ADR 0093), listed at once and ridden once it is `ready`. A downloaded route names the URL of each of
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
          state: z.literal('importing'),
          /** How far the import is, from 0 to 1, once it started copying. */
          progress: z.number().min(0).max(1).optional(),
        })
        .strict(),
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
 * A quality a route can be downloaded in (ADR 0105): `size` in bytes where it is known; a video's
 * `height` in pixels, `fps` and whether it is `hdr` where the downloader names them.
 */
export const routeDownloadOptionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    size: z.number().int().positive().optional(),
    recommended: z.boolean().optional(),
    height: z.number().int().positive().optional(),
    fps: z.number().positive().optional(),
    hdr: z.boolean().optional(),
  })
  .strict();

export type RouteDownloadOption = z.infer<typeof routeDownloadOptionSchema>;

/**
 * The qualities a `fetchable` or `failed` offer can be downloaded in, answered by its provider
 * (ADR 0105). With one, Download starts it at once; with several, the rider chooses.
 */
export const routeDownloadOptionsService = defineService('route.download-options', {
  request: routeKeyRequest,
  response: z.object({ options: z.array(routeDownloadOptionSchema) }).strict(),
  keyedBy: routeOfferState,
});

/**
 * Downloads a `fetchable` or `failed` offer, in the quality `option` of `route.download-options`
 * (the first without one): answered by the offer's provider once the download started (its
 * progress and a failure are the offer's state), rejected with the reason when it cannot start.
 * An offer that is `ready` or `fetching` stays as it is.
 */
export const routeFetchService = defineService('route.fetch', {
  request: routeKeyRequest.extend({ option: z.string().min(1).optional() }).strict(),
  response: z.object({}).strict(),
  keyedBy: routeOfferState,
});

/**
 * Cancels the download of an offer on its way; the offer is `fetchable` again and what was fetched
 * so far stays for the next download. An offer that is not on its way stays as it is, also one
 * whose downloaded package is being unpacked (`importing`, ADR 0094).
 */
export const routeCancelService = defineService('route.cancel', {
  request: routeKeyRequest,
  response: z.object({}).strict(),
  keyedBy: routeOfferState,
});

/**
 * Reads the files of a downloaded offer on the device anew and offers them (ADR 0110): after
 * files were added to its folder, such as its refined stretches.
 */
export const routeRefreshService = defineService('route.refresh', {
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

/** A file the rider dragged onto the window, by its id of `data.drop` (ADR 0093). */
const droppedFileId = z.string().min(1);

/**
 * Imports a route from a package the rider chooses in the system's open dialog: answered once the
 * dialog closed, `started: false` when the rider cancelled. With `file`, from that file dragged
 * onto the window instead, without a dialog (ADR 0093); with `move` as well, the dragged file is
 * removed from where it lay once its route is imported, and stays there when the import fails.
 * The import's progress and a failure are the provider's key of `route.import`; the route is then
 * a key of `route.offer`.
 */
export const routeImportService = defineService('route.import', {
  request: z
    .object({
      key: z.string().min(1),
      file: droppedFileId.optional(),
      move: z.boolean().optional(),
    })
    .strict(),
  response: z.object({ started: z.boolean() }).strict(),
  keyedBy: routeImportState,
});

/**
 * What a route would be once a dragged file is imported, or why the provider cannot import it:
 * the route's card before the route exists. Read from the package's track, nothing is copied.
 */
export const routeImportPreviewSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      preview: routeOfferSchema
        .pick({
          kind: true,
          title: true,
          distance: true,
          ascent: true,
          duration: true,
          sparkline: true,
          thumbnail: true,
        })
        .strict(),
    })
    .strict(),
  z.object({ ok: z.literal(false), reason: z.string().min(1) }).strict(),
]);

export type RouteImportPreview = z.infer<typeof routeImportPreviewSchema>;

/** Previews a file dragged onto the window as a route of the provider `key` (ADR 0093). */
export const routeImportPreviewService = defineService('route.import-preview', {
  request: z.object({ key: z.string().min(1), file: droppedFileId }).strict(),
  response: routeImportPreviewSchema,
  keyedBy: routeImportState,
});

/**
 * A route's download as its source describes it to a downloader (ADR 0105): `kind` picks the
 * downloader, `details` are the source's description of it, read by the downloader of that kind.
 */
export interface RouteDownload {
  /** The offer's id, `<pluginId>/<route>`: also its folder below `videos/` in the media storage. */
  readonly id: string;
  readonly kind: string;
  /** Bytes, as far as the source knows them. */
  readonly size: number;
  readonly details: Readonly<Record<string, unknown>>;
  /**
   * The media folder where a former source kept this route's download: moved to the route's own
   * folder when that has none, so that the rider need not download it again.
   */
  readonly former?: string;
}

/** A route's pictures on the device, as URLs: its picture and the small one of its card. */
export interface RoutePictures {
  readonly thumbnail?: string;
  readonly tile?: string;
}

/**
 * The downloads of one source with one downloader: which of its routes is on the device, on its
 * way or failed. `changed` (of {@link RouteDownloader.open}) is called with a route's id after
 * every change of its availability or pictures.
 */
export interface RouteDownloads {
  /** The source's routes of the downloader's kinds; finds those new to it on the device. */
  setRoutes(routes: readonly RouteDownload[]): Promise<void>;
  availability(id: string): RouteOffer['availability'];
  pictures(id: string): RoutePictures;
  /** Why a download of the route in the quality `option` cannot start now; none when it can. */
  refusal(id: string, option?: string): string | undefined;
  options(id: string): Promise<readonly RouteDownloadOption[]>;
  /** Resolves once the download is done, failed or cancelled; its course is the availability. */
  fetch(id: string, option?: string): Promise<void>;
  cancel(id: string): void;
  remove(id: string): Promise<void>;
  /** Reads the files of a route on the device anew (ADR 0110); a downloader without it offers them from the next start on. */
  refresh?(id: string): Promise<void>;
}

/** A downloader of routes of some kinds of download (ADR 0105); a source opens one per downloader. */
export interface RouteDownloader {
  readonly kinds: readonly string[];
  open(changed: (id: string) => void): RouteDownloads;
}

export const routeDownloaderCapability = defineCapability<
  RouteDownloader,
  'multiple',
  'route.downloader'
>('route.downloader', { cardinality: 'multiple' });
