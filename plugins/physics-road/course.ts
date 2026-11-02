// SPDX-License-Identifier: AGPL-3.0-or-later

/** A stretch of road with a constant gradient, from `from` m to the start of the next one. */
export interface CourseSegment {
  /** m along the ride */
  readonly from: number;
  /** Rise over run, dimensionless. */
  readonly gradient: number;
}

/**
 * The built-in demo course until routes exist: 2 km flat, 1 km at 5 %, 500 m flat, 1 km at -5 %,
 * then flat for ever. Gradients are piecewise constant, so the elevation is continuous.
 */
export const DEMO_COURSE: readonly CourseSegment[] = Object.freeze([
  { from: 0, gradient: 0 },
  { from: 2000, gradient: 0.05 },
  { from: 3000, gradient: 0 },
  { from: 3500, gradient: -0.05 },
  { from: 4500, gradient: 0 },
]);

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
