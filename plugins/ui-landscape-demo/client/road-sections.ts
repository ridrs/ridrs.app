// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TerrainSurface } from '@ridrs/contracts';
import { type LandscapeModel, type SurfacePattern, surfaceAt } from './landscape-model.ts';
import { LANE_MARKINGS, type Quad } from './lane-markings.ts';

/** The road in a 100 × 100 view: its half width at the bottom edge and at the horizon. */
export const ROAD = Object.freeze({ halfWidthAtBottom: 30, halfWidthAtHorizon: 3 });

/** A stretch of road with one surface, `from` to `to` m along the ride, as a quad in the view. */
export interface RoadSection {
  readonly surface: TerrainSurface;
  readonly from: number;
  readonly to: number;
  readonly quad: Quad;
}

/** The next distance after `distance` where the surface changes. */
function nextChange(pattern: SurfacePattern, distance: number): number {
  const start = Math.floor(distance / pattern.period) * pattern.period;
  const gravel = start + pattern.gravelFrom;
  return gravel > distance ? gravel : start + pattern.period;
}

/** View y of a point `ahead` metres ahead (Infinity: the horizon), as the lane markings project. */
function viewY(ahead: number): number {
  const { horizonY, nearDistance } = LANE_MARKINGS;
  return horizonY + (100 - horizonY) * (nearDistance / ahead);
}

/** The road's edges are straight lines in the view: its half width is linear in y. */
function halfWidth(y: number): number {
  const { horizonY } = LANE_MARKINGS;
  const { halfWidthAtBottom, halfWidthAtHorizon } = ROAD;
  return halfWidthAtHorizon + ((halfWidthAtBottom - halfWidthAtHorizon) * (y - horizonY)) / (100 - horizonY);
}

/**
 * The visible road at the presented `position`, nearest first, split where the surface changes:
 * from the bottom edge to the farthest distance the view draws. The farthest section reaches
 * the horizon.
 */
export function roadSections(model: LandscapeModel, position: number): RoadSection[] {
  const { nearDistance, farDistance } = LANE_MARKINGS;
  const end = position + farDistance;
  const sections: RoadSection[] = [];
  for (let from = position + nearDistance; from < end; ) {
    const to = Math.min(nextChange(model.surface, from), end);
    const near = viewY(from - position);
    const far = to === end ? LANE_MARKINGS.horizonY : viewY(to - position);
    sections.push({
      surface: surfaceAt(model.surface, from),
      from,
      to,
      quad: [
        [50 - halfWidth(far), far],
        [50 + halfWidth(far), far],
        [50 + halfWidth(near), near],
        [50 - halfWidth(near), near],
      ],
    });
    from = to;
  }
  return sections;
}
