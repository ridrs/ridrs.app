// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineCapability } from './capabilities.ts';

/**
 * A video route in the unified format, `route.json` next to its files (docs/ideas/video-sources.md,
 * section 4): what the video world needs to play it, whatever the source delivered.
 */
export const videoRouteSchema = z
  .object({
    format: z.literal('ridrs-video-route'),
    version: z.literal(1),
    title: z.string().min(1),
    source: z
      .object({
        name: z.string().min(1),
        author: z.string().min(1),
        url: z.string().url(),
        license: z.string().min(1),
      })
      .strict(),
    /** Notes along the route: m from the start, text by language (`en`, `de`, …). */
    notes: z.array(
      z
        .object({ distance: z.number().nonnegative(), text: z.record(z.string(), z.string()) })
        .strict(),
    ),
    /** Named parts of the route, m from the start. */
    segments: z.array(
      z
        .object({
          name: z.string().min(1),
          start: z.number().nonnegative(),
          end: z.number().nonnegative(),
        })
        .strict(),
    ),
    video: z
      .object({
        /** Next to `route.json`. */
        file: z.string().min(1),
        framerate: z.number().positive(),
        /** The video frame of the track's first point, from 1. */
        startFrame: z.number().int().positive(),
      })
      .strict(),
    /** The original GPX track, next to `route.json`; its times are the video's. */
    track: z.object({ file: z.string().min(1) }).strict(),
    /** Who made it: the importer plugin and its version. */
    imported: z.object({ by: z.string().min(1), version: z.string().min(1) }).strict(),
  })
  .strict();

export type VideoRoute = z.infer<typeof videoRouteSchema>;

/** The unified format's file in a route's folder. */
export const VIDEO_ROUTE_FILE = 'route.json';

/** What a source knows about a route that its package may not say. */
export interface VideoRouteFacts {
  readonly title: string;
  readonly source: VideoRoute['source'];
}

/**
 * Turns a package of one format into a video route in the unified format (post-processing per
 * format, docs/ideas/video-sources.md, section 5). Paths are media paths (`storage.media`).
 */
export interface VideoImporter {
  /** The package format it reads, e.g. `incyclist-gpx-import`. */
  readonly format: string;
  /** Imports `pack` into the empty folder `directory`, writes `route.json` there and returns it. */
  import(pack: string, directory: string, facts: VideoRouteFacts): Promise<VideoRoute>;
}

export const videoImporterCapability = defineCapability<
  VideoImporter,
  'multiple',
  'video.importer'
>('video.importer', { cardinality: 'multiple' });
