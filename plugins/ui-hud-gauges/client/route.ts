// SPDX-License-Identifier: AGPL-3.0-or-later

/** A place on the earth in WGS 84 degrees. */
export interface Place {
  readonly latitude: number;
  readonly longitude: number;
}

/** A place on a track together with its cumulative distance (m) from the start. */
export interface MeasuredPlace extends Place {
  readonly distance: number;
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

/**
 * Each place of `track` paired with its cumulative distance (m) from the start along the full
 * track. Measure before thinning so shortcuts across hairpins do not shrink distances.
 */
export function measureTrack<T extends Place>(track: readonly T[]): (T & { readonly distance: number })[] {
  let distance = 0;
  return track.map((point, index) => {
    if (index > 0) distance += metresBetween(track[index - 1] as Place, point);
    return { ...point, distance };
  });
}

/**
 * The index of the last place of `track` at or before `distance` (m): where the rider is along
 * the route. Locating by distance rather than coordinates stays on the right leg of an
 * out-and-back, self-crossing or switchback track.
 */
export function indexAtDistance(
  track: readonly { readonly distance: number }[],
  distance: number,
): number {
  if (track.length <= 1) return 0;
  let low = 0;
  let high = track.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((track[middle]?.distance ?? 0) <= distance) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/** m either side of the place the odometer expects within which the rider is looked for first. */
const NEAR = 50;
/** m a position may lie off the track near the expected place: GPS points the world dropped. */
const ON_TRACK = 25;
/**
 * m a position may lie off the track beyond the expected place: across a cut of the video the
 * world puts the rider on a point of the track itself, a long way further on.
 */
const ON_TRACK_AHEAD = 10;

/**
 * Where on the measured `track` the world puts the rider at `place`, in m along it: on the
 * nearest stretch within `NEAR` m of `expected` if it lies within `ON_TRACK` m, else on the first
 * stretch further on within `ON_TRACK_AHEAD` m; none if neither. Looking near the expected place
 * first keeps to the right leg of an out-and-back track; looking further on finds the rider past a
 * cut of the video, which the odometer does not count but the track does.
 */
export function locateOnTrack(
  track: readonly MeasuredPlace[],
  place: Place,
  expected: number,
): number | undefined {
  const east = Math.cos((place.latitude * Math.PI) / 180) * METRES_PER_DEGREE;
  const toMetres = (p: Place): Point => ({
    x: (p.longitude - place.longitude) * east,
    y: (p.latitude - place.latitude) * METRES_PER_DEGREE,
  });
  /** How far `place` lies off the stretch from point `i` to the next, and where along the track. */
  const onStretch = (i: number) => {
    const a = track[i] as MeasuredPlace;
    const b = track[i + 1] as MeasuredPlace;
    const pa = toMetres(a);
    const pb = toMetres(b);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const squared = dx * dx + dy * dy;
    const t = squared > 0 ? Math.min(1, Math.max(0, -(pa.x * dx + pa.y * dy) / squared)) : 0;
    return {
      off: Math.hypot(pa.x + t * dx, pa.y + t * dy),
      along: t >= 1 ? b.distance : a.distance + t * (b.distance - a.distance),
    };
  };
  let near: { off: number; along: number } | undefined;
  let ahead = -1;
  for (let i = 0; i < track.length - 1; i += 1) {
    const from = (track[i] as MeasuredPlace).distance;
    const to = (track[i + 1] as MeasuredPlace).distance;
    if (to < expected - NEAR) continue;
    if (from > expected + NEAR) {
      ahead = i;
      break;
    }
    const found = onStretch(i);
    if (!near || found.off < near.off) near = found;
  }
  if (near && near.off <= ON_TRACK) return near.along;
  if (ahead < 0) return undefined;
  for (let i = ahead; i < track.length - 1; i += 1) {
    let found = onStretch(i);
    if (found.off > ON_TRACK_AHEAD) continue;
    // The nearest of the stretches in a row that lie this close.
    for (let j = i + 1; j < track.length - 1; j += 1) {
      const next = onStretch(j);
      if (next.off > ON_TRACK_AHEAD) break;
      if (next.off < found.off) found = next;
    }
    return found.along;
  }
  return undefined;
}

/**
 * m the measured `track` runs ahead of the odometer at the world's latest `position`: what cuts of
 * the video skipped, and what GPS points the world dropped took off. `previous` holds where the
 * position cannot be found on the track.
 */
export function trackOffset(
  track: readonly MeasuredPlace[],
  position: MeasuredPlace,
  previous: number,
): number {
  const along = locateOnTrack(track, position, position.distance + previous);
  return along === undefined ? previous : along - position.distance;
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

/**
 * The colour of a gradient readout on a dark HUD card: matches `gradeColour` up to 8 %, and lifts
 * the darkest crimson/purple bands so steep climbs stay readable from trainer distance.
 */
export function gradeTextColour(percent: number): string {
  if (percent < 8) return gradeColour(percent);
  return percent < 10 ? '#e05263' : '#c084fc';
}

/**
 * Where to place the right-aligned remaining/total distance inside a profile of `width` × `height`:
 * top-right when the elevation line stays in the lower half of the right side (open sky above),
 * bottom-right when the line climbs into the upper half (open filled terrain below).
 */
export function distanceLabelAlign(
  line: readonly Point[],
  width: number,
  height: number,
): 'top' | 'bottom' {
  const zoneStart = width * 0.55;
  const rightPoints = line.filter((point) => point.x >= zoneStart);
  const sample = rightPoints.length > 0 ? rightPoints : line;
  if (sample.length === 0) return 'top';
  const highestY = Math.min(...sample.map((point) => point.y));
  return highestY >= height * 0.48 ? 'top' : 'bottom';
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

/** m between two places, on a sphere: enough to look ahead along a track. */
function metresBetween(a: Place, b: Place): number {
  const east = Math.cos((((a.latitude + b.latitude) / 2) * Math.PI) / 180);
  const dx = (b.longitude - a.longitude) * east * METRES_PER_DEGREE;
  const dy = (b.latitude - a.latitude) * METRES_PER_DEGREE;
  return Math.hypot(dx, dy);
}

/** Degrees clockwise from north, from `from` toward `to`. */
function bearingBetween(from: Place, to: Place): number {
  const east = Math.cos((from.latitude * Math.PI) / 180);
  const degrees = (Math.atan2((to.longitude - from.longitude) * east, to.latitude - from.latitude) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/**
 * The direction of travel at the point `index` of `track`, in degrees clockwise from north: toward
 * the point about `ahead` m further on. Short enough that a hairpin does not turn the map across
 * the road before the rider reaches it; long enough that GPS jitter does not shake it.
 */
export function headingAt(track: readonly Place[], index: number, ahead = 50): number {
  const from = track[index];
  if (!from) return 0;
  let to = from;
  let travelled = 0;
  for (let i = index + 1; i < track.length && travelled < ahead; i += 1) {
    const next = track[i] as Place;
    travelled += metresBetween(to, next);
    to = next;
  }
  if (metresBetween(from, to) >= 1) {
    return bearingBetween(from, to);
  }
  // Looking `ahead` folded back onto `from` (e.g. approaching a U-turn): face the road right ahead.
  for (let i = index + 1; i < track.length; i += 1) {
    const next = track[i] as Place;
    if (metresBetween(from, next) >= 1) return bearingBetween(from, next);
  }
  // At the end (or only stationary points remain): keep the direction the track came from.
  for (let i = index - 1; i >= 0; i -= 1) {
    const before = track[i] as Place;
    if (metresBetween(before, from) >= 1) return bearingBetween(before, from);
  }
  return 0;
}
