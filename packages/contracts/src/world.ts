// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineEvent } from './events.ts';

/*
 * A world knows the terrain; the physics knows how far the rider went. The world tells the
 * physics the terrain ahead in metres along the path the rider follows, anchored at the physics
 * odometer: distance, not time, because the terrain does not depend on speed.
 */

/** What the road is made of; it scales the rolling resistance. */
export type TerrainSurface = 'asphalt' | 'gravel';

export const TERRAIN_SURFACES: readonly TerrainSurface[] = Object.freeze(['asphalt', 'gravel']);

/** The terrain at one sample point. */
export interface TerrainSample {
  /** Rise over run along the path, dimensionless: 0.05 is 5 % uphill, like `RoadSample.gradient`. */
  readonly gradient: number;
  /** Absent means asphalt: windows without a surface stay valid and ride on asphalt. */
  readonly surface?: TerrainSurface;
}

/**
 * The terrain ahead of the rider: sample `i` lies at the odometer reading
 * `originDistance + i · spacing`. Between two samples the spatial layer interpolates the gradient
 * linearly and holds the surface; beyond the last one it holds the last sample.
 */
export interface TerrainPreview {
  /** Counts up with every window a source publishes; a newer window replaces the older one. */
  readonly revision: number;
  /** m, the physics odometer reading of the first sample. */
  readonly originDistance: number;
  /** m between two samples. */
  readonly spacing: number;
  /** At least two, so that there is something to interpolate. */
  readonly samples: readonly TerrainSample[];
}

// zod numbers reject NaN and ±Infinity.
export const terrainPreviewSchema: z.ZodType<TerrainPreview> = z.object({
  revision: z.number().int().positive(),
  originDistance: z.number().nonnegative(),
  spacing: z.number().positive(),
  samples: z
    .array(z.object({ gradient: z.number(), surface: z.enum(['asphalt', 'gravel']).optional() }))
    .min(2),
});

/**
 * The terrain ahead of the rider, accepted by a world driver as an external input after it
 * validated what a sensor observed. Read by the spatial writer, never by the physics.
 */
export const worldTerrainPreviewEvent = defineEvent('world.terrain-preview', terrainPreviewSchema);

/**
 * What a UI landscape sees ahead of the presented position, raw: same shape as the contract
 * event, checked only for its shape. A driver validates it before it becomes terrain.
 */
export const uiTerrainObservedEvent = defineEvent(
  'ui.terrain-observed',
  z.object({
    revision: z.number(),
    originDistance: z.number(),
    spacing: z.number(),
    samples: z.array(z.object({ gradient: z.number(), surface: z.string().optional() })),
  }),
);

/**
 * Where the rider is on the earth at the physics odometer reading `distance`: WGS 84 degrees and
 * metres above sea level. A world that knows the real place of its route tells it; a ride without
 * one has no position. Recorded as an input and exported to the activity file.
 */
export interface WorldPosition {
  /** m, the physics odometer reading the position belongs to. */
  readonly distance: number;
  /** Degrees north, -90 … 90. */
  readonly latitude: number;
  /** Degrees east, -180 … 180. */
  readonly longitude: number;
  /** m above sea level; absent when the world does not know it. */
  readonly altitude?: number;
}

export const worldPositionSchema: z.ZodType<WorldPosition> = z.object({
  distance: z.number().nonnegative(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitude: z.number().optional(),
});

/** The rider's position, accepted by a world driver as an external input. */
export const worldPositionEvent = defineEvent('world.position', worldPositionSchema);

/** Where a UI landscape shows the rider, raw: checked only for its shape, like the terrain. */
export const uiPositionObservedEvent = defineEvent(
  'ui.position-observed',
  z.object({
    distance: z.number(),
    latitude: z.number(),
    longitude: z.number(),
    altitude: z.number().optional(),
  }),
);
