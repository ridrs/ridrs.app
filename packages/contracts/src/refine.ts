// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineState } from './app-state.ts';
import { defineCapability } from './capabilities.ts';
import { routeOfferSchema } from './route.ts';
import { defineService } from './services.ts';

/**
 * One refined stretch of a route's video to compute (ADR 0110): from `from` s to `to` s of the
 * video at the media path `video`, with `factor` frames per frame of it, to the media path
 * `target`, a video of its own whose time 0 is the stretch's first frame.
 */
export interface VideoInterpolation {
  readonly video: string;
  readonly from: number;
  readonly to: number;
  readonly factor: number;
  readonly target: string;
}

/** The stretch as computed: the time of its first frame and of the frame after its last, s of the video. */
export interface VideoInterpolated {
  readonly from: number;
  readonly to: number;
}

/** Computes in-between frames of a video (ADR 0110): on a Mac, Apple's frame rate conversion. */
export interface VideoInterpolator {
  /** `progress` is called with the share done, 0 to 1; rejects when `signal` aborts. */
  interpolate(
    request: VideoInterpolation,
    progress: (share: number) => void,
    signal: AbortSignal,
  ): Promise<VideoInterpolated>;
}

export const videoInterpolatorCapability = defineCapability<
  VideoInterpolator,
  'single',
  'video.interpolate'
>('video.interpolate', { cardinality: 'single' });

/**
 * How far the refinement of a downloaded video route is (ADR 0110), by its offer's id: `waiting`
 * for its turn or for a ride to end, `refining` with the share of the stretches' time done,
 * `done` with how many stretches it has, `skipped` or `failed` with the reason.
 */
export const videoRefinementSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('waiting') }).strict(),
  z.object({ status: z.literal('refining'), progress: z.number().min(0).max(1) }).strict(),
  z.object({ status: z.literal('done'), stretches: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal('skipped'), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal('failed'), reason: z.string().min(1) }).strict(),
]);

export type VideoRefinement = z.infer<typeof videoRefinementSchema>;

export const videoRefinementState = defineState('video.refinement', videoRefinementSchema);

/** Starts the refinement of a downloaded route again, or cancels it until it is started again. */
export const videoRefineService = defineService('video.refine', {
  request: z
    .object({ key: routeOfferSchema.shape.id, action: z.enum(['start', 'cancel']) })
    .strict(),
  response: z.object({}).strict(),
  keyedBy: videoRefinementState,
});
