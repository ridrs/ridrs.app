// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TerrainSurface } from '@ridrs/contracts';

/*
 * The demo landscape until routes exist. The UI owns it: it draws the road from this model and
 * publishes the same terrain ahead, so what the rider sees is what the physics rides.
 */

/** A stretch of road with a constant gradient, from `from` m to the start of the next one. */
export interface CourseSegment {
  /** m along the ride */
  readonly from: number;
  /** Rise over run, dimensionless. */
  readonly gradient: number;
}

/**
 * 2 km flat, 1 km at 5 %, 500 m flat, 1 km at -5 %, then flat for ever (ADR 0027). Gradients are
 * piecewise constant, so the elevation is continuous.
 */
export const DEMO_COURSE: readonly CourseSegment[] = Object.freeze([
  { from: 0, gradient: 0 },
  { from: 2000, gradient: 0.05 },
  { from: 3000, gradient: 0 },
  { from: 3500, gradient: -0.05 },
  { from: 4500, gradient: 0 },
]);

/** A surface repeating every `period` m: asphalt, then gravel from `gravelFrom` to the period's end. */
export interface SurfacePattern {
  readonly period: number;
  readonly gravelFrom: number;
}

/** 500 m asphalt, 500 m gravel, from 0 m, repeating (maintainer, 2026-11-04; ADR 0044 had 3 km / 1 km). */
export const DEMO_SURFACE: SurfacePattern = Object.freeze({ period: 1000, gravelFrom: 500 });

export interface LandscapeModel {
  readonly course: readonly CourseSegment[];
  readonly surface: SurfacePattern;
}

export const DEMO_LANDSCAPE: LandscapeModel = Object.freeze({
  course: DEMO_COURSE,
  surface: DEMO_SURFACE,
});

/** The gradient of the last segment with `from ≤ distance`: a segment starts exactly at `from`. */
export function gradientAt(course: readonly CourseSegment[], distance: number): number {
  let gradient = course[0]?.gradient ?? 0;
  for (const segment of course) {
    if (segment.from > distance) {
      break;
    }
    gradient = segment.gradient;
  }
  return gradient;
}

/** The surface at `distance`: a stretch starts exactly at its boundary. */
export function surfaceAt(pattern: SurfacePattern, distance: number): TerrainSurface {
  const within = ((distance % pattern.period) + pattern.period) % pattern.period;
  return within >= pattern.gravelFrom ? 'gravel' : 'asphalt';
}

/**
 * The terrain window: `windowLength` m ahead, a sample every `spacing` m, republished when less
 * than `republishBelow` m of it are left ahead of the presented position. See ADR 0043 and 0044
 * for the numbers.
 */
export const TERRAIN_WINDOW = Object.freeze({ windowLength: 20, spacing: 1, republishBelow: 10 });

/** Where a window anchored at the odometer reading `distance` starts: the grid point at or before it. */
export function windowOrigin(distance: number, spacing = TERRAIN_WINDOW.spacing): number {
  return Math.floor(distance / spacing) * spacing;
}

export interface TerrainWindow {
  readonly originDistance: number;
  readonly spacing: number;
  readonly samples: readonly { readonly gradient: number; readonly surface: TerrainSurface }[];
}

/**
 * The landscape from the grid point at or before `distance`, `windowLength` m ahead. Samples lie
 * on a fixed grid, so the terrain at a distance is the same whichever window covers it.
 */
export function terrainWindow(
  model: LandscapeModel,
  distance: number,
  { windowLength, spacing } = TERRAIN_WINDOW,
): TerrainWindow {
  const originDistance = windowOrigin(distance, spacing);
  const count = Math.round(windowLength / spacing) + 1;
  return {
    originDistance,
    spacing,
    samples: Array.from({ length: count }, (_, i) => {
      const at = originDistance + i * spacing;
      return { gradient: gradientAt(model.course, at), surface: surfaceAt(model.surface, at) };
    }),
  };
}

/** m of the window ahead of `distance`; negative once the rider passed its last sample. */
export function remainingAhead(window: TerrainWindow, distance: number): number {
  return window.originDistance + (window.samples.length - 1) * window.spacing - distance;
}
