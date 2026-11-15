// SPDX-License-Identifier: AGPL-3.0-or-later

/** A place on the earth in WGS 84 degrees. */
export interface Place {
  readonly latitude: number;
  readonly longitude: number;
}

/** A point in a drawing, in its own units, y downwards. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

const METRES_PER_DEGREE = (Math.PI / 180) * 6_371_000;

/** At most `max` of `items`, evenly picked, the first and the last always among them. */
export function thin<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => items[Math.round(i * step)] as T);
}

/** The index of the place of `track` nearest to `place`: where the rider is on it. */
export function nearestIndex(track: readonly Place[], place: Place): number {
  const east = Math.cos((place.latitude * Math.PI) / 180);
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  track.forEach((point, index) => {
    const dx = (point.longitude - place.longitude) * east;
    const dy = point.latitude - place.latitude;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * A projection of places into a `width` × `height` drawing that shows them all, north up, with
 * `pad` around them and the same scale in both directions. Places are metres east and north of
 * the first one (equirectangular around its latitude): exact enough for a route's few kilometres.
 */
export function fitPlaces(
  places: readonly Place[],
  width: number,
  height: number,
  pad: number,
): (place: Place) => Point {
  const origin = places[0] ?? { latitude: 0, longitude: 0 };
  const east = Math.cos((origin.latitude * Math.PI) / 180) * METRES_PER_DEGREE;
  const toMetres = (place: Place): Point => ({
    x: (place.longitude - origin.longitude) * east,
    y: (place.latitude - origin.latitude) * METRES_PER_DEGREE,
  });
  const points = places.map(toMetres);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scale = Math.min(
    (width - 2 * pad) / Math.max(maxX - minX, 1),
    (height - 2 * pad) / Math.max(maxY - minY, 1),
  );
  const offsetX = (width - (maxX - minX) * scale) / 2;
  const offsetY = (height - (maxY - minY) * scale) / 2;
  return (place) => {
    const { x, y } = toMetres(place);
    return { x: offsetX + (x - minX) * scale, y: height - (offsetY + (y - minY) * scale) };
  };
}

/** Points as the `points` of an SVG polyline. */
export const polyline = (points: readonly Point[]): string =>
  points.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

/**
 * The gradient bands of the route profile (`ui-route-profile/client/profile-data.ts`), from the
 * flattest up; plugins share no code, so the box keeps a copy. A descent counts as flat.
 */
const GRADE_COLOURS = [
  { below: 2, colour: '#8fbf5a' },
  { below: 4, colour: '#f2cd2f' },
  { below: 6, colour: '#f0962a' },
  { below: 8, colour: '#df4b2b' },
  { below: 10, colour: '#a11d2b' },
  { below: Number.POSITIVE_INFINITY, colour: '#6a1b6e' },
] as const;

/** The colour of a gradient in %, as the route profile colours it. */
export function gradeColour(percent: number): string {
  return (GRADE_COLOURS.find(({ below }) => percent < below) ?? GRADE_COLOURS[5]).colour;
}

/** One stretch of the profile: its outline in the drawing and its colour. */
export interface ProfileStretch {
  readonly polygon: string;
  readonly colour: string;
  /** Where it starts and ends along the route, 0 to 1. */
  readonly from: number;
  readonly to: number;
}

/**
 * The elevation profile of a route `distance` m long from its evenly spaced elevations, as
 * stretches between neighbouring samples in a `width` × `height` drawing, each coloured by its
 * gradient; and the line along their tops.
 */
export function profileOf(
  elevations: readonly number[],
  distance: number,
  width: number,
  height: number,
): { readonly stretches: ProfileStretch[]; readonly line: Point[] } {
  if (elevations.length < 2) return { stretches: [], line: [] };
  const low = Math.min(...elevations);
  const high = Math.max(...elevations);
  // A flat route still shows a little ground; a steep one fills the height.
  const span = Math.max(high - low, 20);
  const step = distance / (elevations.length - 1);
  const top = 4;
  const at = (index: number): Point => ({
    x: (index / (elevations.length - 1)) * width,
    y: top + (1 - ((elevations[index] ?? low) - low) / span) * (height - top - 2),
  });
  const line = elevations.map((_, index) => at(index));
  const stretches = line.slice(1).map((end, i) => {
    const start = line[i] as Point;
    const grade = step > 0 ? (((elevations[i + 1] ?? 0) - (elevations[i] ?? 0)) / step) * 100 : 0;
    return {
      polygon: polyline([start, end, { x: end.x, y: height }, { x: start.x, y: height }]),
      colour: gradeColour(grade),
      from: i / (elevations.length - 1),
      to: (i + 1) / (elevations.length - 1),
    };
  });
  return { stretches, line };
}
