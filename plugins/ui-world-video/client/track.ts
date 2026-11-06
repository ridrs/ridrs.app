// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TrackPoint } from './library.ts';

/** Mean earth radius (m) of the haversine distance. */
export const EARTH_RADIUS = 6_371_008.8;

/**
 * The route as the rider follows it: every GPX point at its distance along the path (m), from
 * 0 at the first point. Distances never decrease; points where the camera stood still share one.
 * A plausible track (ADR 0063) counts a jump of the GPS with the length the camera rode.
 */
export interface Track {
  readonly points: readonly TrackPoint[];
  readonly distances: readonly number[];
  /** m from the first point to the last. */
  readonly length: number;
}

/** Where on the route a distance lies: WGS 84 degrees, m above sea level, s into the video. */
export interface TrackPlace {
  readonly latitude: number;
  readonly longitude: number;
  readonly elevation: number;
  readonly time: number;
}

/**
 * Over how many metres the gradient is measured, centred on the distance: GPX elevations jitter
 * from point to point, a bike length is too short for them (world-plugins.md, "Choosing the numbers").
 */
export const GRADIENT_BASE = 20;

/** The steepest gradient the route tells the physics, either way: below the driver's ±30 %. */
export const MAX_GRADIENT = 0.25;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** The great-circle distance (m) between two points. */
export function haversine(a: TrackPoint, b: TrackPoint): number {
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function buildTrack(points: readonly TrackPoint[]): Track {
  if (points.length < 2) {
    throw new Error('A track needs at least two points');
  }
  const distances = [0];
  for (let i = 1; i < points.length; i += 1) {
    distances.push((distances[i - 1] ?? 0) + haversine(points[i - 1] as TrackPoint, points[i] as TrackPoint));
  }
  return { points, distances, length: distances.at(-1) ?? 0 };
}

/**
 * The index of the last point at or before `distance`. Where the camera stood still, that is the
 * last of the points with the same distance: the ride goes on where the video moves again.
 */
function segmentAt(track: Track, distance: number): number {
  const { distances } = track;
  let low = 0;
  let high = distances.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((distances[middle] ?? 0) <= distance) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/**
 * The place at `distance`, linear between two points. Before the start it is the first point,
 * beyond the end the last one: the route holds there.
 */
export function placeAt(track: Track, distance: number): TrackPlace {
  const i = segmentAt(track, Math.max(0, Math.min(distance, track.length)));
  const a = track.points[i] as TrackPoint;
  const b = track.points[i + 1];
  const from = track.distances[i] ?? 0;
  const to = track.distances[i + 1] ?? from;
  const f = b && to > from ? Math.min(1, Math.max(0, (distance - from) / (to - from))) : 0;
  const lerp = (x: number, y: number) => x + (y - x) * f;
  return b
    ? {
        latitude: lerp(a.latitude, b.latitude),
        longitude: lerp(a.longitude, b.longitude),
        elevation: lerp(a.elevation, b.elevation),
        time: lerp(a.time, b.time),
      }
    : { latitude: a.latitude, longitude: a.longitude, elevation: a.elevation, time: a.time };
}

/**
 * The gradient at `distance`, rise over run across `GRADIENT_BASE` m centred on it (shorter at
 * the route's ends), within ±`MAX_GRADIENT`. Flat beyond the end.
 */
export function gradientAt(track: Track, distance: number): number {
  const from = Math.max(0, distance - GRADIENT_BASE / 2);
  const to = Math.min(track.length, distance + GRADIENT_BASE / 2);
  if (to - from < 1) {
    return 0;
  }
  const rise = placeAt(track, to).elevation - placeAt(track, from).elevation;
  return Math.max(-MAX_GRADIENT, Math.min(MAX_GRADIENT, rise / (to - from)));
}
