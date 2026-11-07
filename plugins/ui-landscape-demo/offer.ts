// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RouteOffer } from '@ridrs/contracts';
import { type CourseSegment, DEMO_COURSE, gradientAt } from './client/landscape-model.ts';

/** Samples of the course's small profile: every 250 m up to where it stays flat for ever. */
const SPARKLINE_SPACING = 250;

/** The elevation (m above the start) at `distance`: the gradients integrated along the course. */
function elevationAt(course: readonly CourseSegment[], distance: number): number {
  let elevation = 0;
  for (const [i, segment] of course.entries()) {
    const end = Math.min(distance, course[i + 1]?.from ?? Number.POSITIVE_INFINITY);
    if (end <= segment.from) {
      break;
    }
    elevation += (end - segment.from) * gradientAt(course, segment.from);
  }
  return elevation;
}

/** The demo course as the ride page lists it: its profile up to the last change of gradient. */
export function demoCourseOffer(course: readonly CourseSegment[] = DEMO_COURSE): RouteOffer {
  const length = course.at(-1)?.from ?? 0;
  const sparkline: number[] = [];
  for (let distance = 0; distance <= length; distance += SPARKLINE_SPACING) {
    sparkline.push(Math.round(elevationAt(course, distance) * 10) / 10);
  }
  const ascent = sparkline.slice(1).reduce((sum, elevation, i) => sum + Math.max(0, elevation - (sparkline[i] ?? 0)), 0);
  return {
    id: 'ui-landscape-demo/demo-course',
    kind: 'world',
    title: 'Demo course',
    distance: length,
    ascent,
    sparkline,
    tags: {},
    availability: { state: 'ready' },
    world: { landscape: 'ui-landscape-demo/landscape' },
  };
}
