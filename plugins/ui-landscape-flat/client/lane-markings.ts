// SPDX-License-Identifier: AGPL-3.0-or-later

/** The centre line in a 100 × 100 view, seen from a rider's eye above the road. */
export const LANE_MARKINGS = Object.freeze({
  /** View y of the horizon. */
  horizonY: 55,
  /** Road distance (m) that the bottom edge of the view shows. */
  nearDistance: 4,
  /** Farther than this (m) nothing is drawn; dashes there are dots on the horizon. */
  farDistance: 160,
  /** m */
  dashLength: 3,
  /** m */
  gapLength: 9,
  /** Half the line width at the bottom edge, in view units. */
  halfWidthAtBottom: 1.5,
});

export type Quad = readonly (readonly [number, number])[];

/** Where a point `distance` metres ahead appears: its view y and the line's half width there. */
function project(distance: number): { y: number; halfWidth: number } {
  const { horizonY, nearDistance, halfWidthAtBottom } = LANE_MARKINGS;
  const scale = nearDistance / distance;
  return { y: horizonY + (100 - horizonY) * scale, halfWidth: halfWidthAtBottom * scale };
}

/**
 * The visible dashes, nearest first, as quads in view coordinates, for a road that has moved by
 * `position` metres. Dashes repeat every dash + gap, so only the position modulo that matters.
 */
export function laneDashes(position: number): Quad[] {
  const { nearDistance, farDistance, dashLength, gapLength } = LANE_MARKINGS;
  const period = dashLength + gapLength;
  const shift = ((position % period) + period) % period;
  const dashes: Quad[] = [];
  for (let start = -shift; start < farDistance; start += period) {
    const near = Math.max(start, nearDistance);
    const far = Math.min(start + dashLength, farDistance);
    if (far <= near) {
      continue;
    }
    const bottom = project(near);
    const top = project(far);
    dashes.push([
      [50 - top.halfWidth, top.y],
      [50 + top.halfWidth, top.y],
      [50 + bottom.halfWidth, bottom.y],
      [50 - bottom.halfWidth, bottom.y],
    ]);
  }
  return dashes;
}
