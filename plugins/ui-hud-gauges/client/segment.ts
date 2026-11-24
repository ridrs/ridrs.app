// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RouteOffer, TerrainPreview } from '@ridrs/contracts';
import type { TrackPosition } from '@ridrs/ride';
import { gradeColour, measureTrack, type Point, polyline, type ProfileStretch } from './route.ts';

/** An elevation sample along the route: cumulative distance (m) and elevation (m). */
export interface ElevationPoint {
  readonly distance: number;
  readonly elevation: number;
}

/** Fine-grained local profile lookback and lookahead distances (m). */
export const LOCAL_LOOKBACK_M = 100;
export const LOCAL_LOOKAHEAD_M = 500;

/** Start the summit countdown this many seconds before reaching the crest. */
export const SUMMIT_COUNTDOWN_SECONDS = 10;

/** A local window is considered flat below both thresholds (and with flat live gradient). */
const FLAT_SPAN_M = 2;
const FLAT_GRADE_PERCENT = 0.5;

/** Number of uniform segments in the workout perimeter progress ring. */
export const WORKOUT_RING_SEGMENTS = 36;

export interface LocalProfile {
  readonly stretches: readonly ProfileStretch[];
  readonly line: readonly Point[];
  readonly rider: Point;
  readonly elevationSpan: number;
  readonly maxAbsGrade: number;
}

export type RouteClimb = NonNullable<RouteOffer['climbs']>[number];

export interface ActiveClimb {
  readonly climb: RouteClimb;
  readonly remainingMeters: number;
  readonly countdownSeconds: number | undefined;
  readonly climbedGain: number;
  readonly totalGain: number;
}

/**
 * Builds ordered `(distance, elevation)` samples for the fine-grained local profile, preferring
 * the route's high-resolution GPX track elevations, falling back to the route offer's sparkline,
 * and finally integrating `world.terrain-preview` gradients for worlds without a route track.
 */
export function elevationPointsOf(
  track: readonly TrackPosition[] | undefined,
  offer: RouteOffer | undefined,
  terrainPreview: TerrainPreview | undefined,
): ElevationPoint[] {
  if (track && track.length >= 2) {
    const measured = measureTrack(track);
    const withElevation = measured.filter(
      (point): point is typeof point & { readonly elevation: number } =>
        point.elevation !== undefined && Number.isFinite(point.elevation),
    );
    if (withElevation.length >= 2) {
      return withElevation.map(({ distance, elevation }) => ({ distance, elevation }));
    }
  }
  if (offer && offer.distance > 0 && offer.sparkline && offer.sparkline.length >= 2) {
    const step = offer.distance / (offer.sparkline.length - 1);
    return offer.sparkline.map((elevation, index) => ({ distance: index * step, elevation }));
  }
  if (terrainPreview && terrainPreview.samples.length >= 2) {
    const points: ElevationPoint[] = [];
    let elevation = 0;
    for (let i = 0; i < terrainPreview.samples.length; i += 1) {
      const distance = terrainPreview.originDistance + i * terrainPreview.spacing;
      if (i > 0) {
        const previous = terrainPreview.samples[i - 1]?.gradient ?? 0;
        const current = terrainPreview.samples[i]?.gradient ?? 0;
        elevation += ((previous + current) / 2) * terrainPreview.spacing;
      }
      points.push({ distance, elevation });
    }
    return points;
  }
  return [];
}

/** Linearly interpolated elevation (m) at `distance` (m), clamped at the ends of `points`. */
export function elevationAt(points: readonly ElevationPoint[], distance: number): number | undefined {
  if (points.length === 0) return undefined;
  const first = points[0] as ElevationPoint;
  const last = points.at(-1) as ElevationPoint;
  if (distance <= first.distance) return first.elevation;
  if (distance >= last.distance) return last.elevation;
  let low = 0;
  let high = points.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if ((points[mid]?.distance ?? 0) <= distance) low = mid;
    else high = mid;
  }
  const a = points[low] as ElevationPoint;
  const b = points[high] as ElevationPoint;
  const span = b.distance - a.distance;
  if (span <= 0) return a.elevation;
  const share = (distance - a.distance) / span;
  return a.elevation + (b.elevation - a.elevation) * share;
}

/**
 * Slices `points` strictly to `[windowStart, windowEnd]` (inserting interpolated boundary samples
 * at both ends so the profile never leaks past `windowEnd`, e.g. stripping a post-summit descent)
 * and projects it into a `width` × `height` SVG drawing.
 */
export function localProfileOf(
  points: readonly ElevationPoint[],
  riderDistance: number,
  windowStart: number,
  windowEnd: number,
  width: number,
  height: number,
): LocalProfile | undefined {
  if (points.length < 2 || windowEnd <= windowStart) return undefined;
  const startEle = elevationAt(points, windowStart);
  const endEle = elevationAt(points, windowEnd);
  if (startEle === undefined || endEle === undefined) return undefined;

  const sliced: ElevationPoint[] = [{ distance: windowStart, elevation: startEle }];
  for (const point of points) {
    if (point.distance > windowStart && point.distance < windowEnd) {
      sliced.push(point);
    }
  }
  sliced.push({ distance: windowEnd, elevation: endEle });

  const elevations = sliced.map((point) => point.elevation);
  const low = Math.min(...elevations);
  const high = Math.max(...elevations);
  const elevationSpan = high - low;
  // Keep small undulations legible while preventing flat noise from stretching full height.
  const verticalSpan = Math.max(elevationSpan, 12);
  const top = 5;
  const bottomPad = 2;
  const distSpan = windowEnd - windowStart;

  const project = (distance: number, elevation: number): Point => ({
    x: ((distance - windowStart) / distSpan) * width,
    y: top + (1 - (elevation - low) / verticalSpan) * (height - top - bottomPad),
  });

  const line = sliced.map((point) => project(point.distance, point.elevation));
  let maxAbsGrade = 0;
  const stretches: ProfileStretch[] = [];

  for (let i = 0; i < sliced.length - 1; i += 1) {
    const a = sliced[i] as ElevationPoint;
    const b = sliced[i + 1] as ElevationPoint;
    const start = line[i] as Point;
    const end = line[i + 1] as Point;
    const dx = b.distance - a.distance;
    const grade = dx > 0 ? ((b.elevation - a.elevation) / dx) * 100 : 0;
    if (Math.abs(grade) > maxAbsGrade) maxAbsGrade = Math.abs(grade);
    stretches.push({
      polygon: polyline([start, end, { x: end.x, y: height }, { x: start.x, y: height }]),
      colour: gradeColour(grade),
      from: (a.distance - windowStart) / distSpan,
      to: (b.distance - windowStart) / distSpan,
    });
  }

  const clampedRiderDist = Math.min(Math.max(riderDistance, windowStart), windowEnd);
  const riderEle = elevationAt(sliced, clampedRiderDist) ?? startEle;
  const rider = project(clampedRiderDist, riderEle);

  return { stretches, line, rider, elevationSpan, maxAbsGrade };
}

/** True when the local road has no meaningful relief and the live gradient is flat. */
export function isFlatTerrain(
  profile: LocalProfile | undefined,
  currentGradePercent: number | undefined,
): boolean {
  const liveFlat = currentGradePercent === undefined || Math.abs(currentGradePercent) < FLAT_GRADE_PERCENT;
  if (!liveFlat) return false;
  if (!profile) return true;
  return profile.elevationSpan < FLAT_SPAN_M && profile.maxAbsGrade < FLAT_GRADE_PERCENT;
}

/**
 * Finds the active categorised climb the rider is on (or within 10 s of its summit), together with
 * its summit countdown (when ≤ 10 s away) and climbed / total vertical gain in metres.
 */
export function activeClimbOf(
  climbs: RouteOffer['climbs'],
  distance: number,
  speed: number,
  points: readonly ElevationPoint[],
  altitude: number | undefined,
): ActiveClimb | undefined {
  if (!climbs || climbs.length === 0) return undefined;
  const climb = climbs.find((candidate) => {
    if (distance >= candidate.start && distance <= candidate.end) return true;
    const remaining = candidate.end - distance;
    return remaining > 0 && speed > 0 && remaining / speed <= SUMMIT_COUNTDOWN_SECONDS;
  });
  if (!climb) return undefined;

  const remainingMeters = Math.max(0, climb.end - distance);
  const eta = speed > 0 && remainingMeters > 0 ? remainingMeters / speed : undefined;
  const countdownSeconds =
    eta !== undefined && eta <= SUMMIT_COUNTDOWN_SECONDS
      ? Math.max(1, Math.ceil(eta))
      : undefined;

  const totalGain = Math.round(climb.gain);
  const startEle = elevationAt(points, climb.start);
  const currentEle = altitude ?? elevationAt(points, distance);
  let climbedGain: number;
  if (startEle !== undefined && currentEle !== undefined) {
    climbedGain = Math.round(Math.min(Math.max(currentEle - startEle, 0), totalGain));
  } else {
    const span = climb.end - climb.start;
    const share = span > 0 ? Math.min(Math.max((distance - climb.start) / span, 0), 1) : 0;
    climbedGain = Math.round(totalGain * share);
  }

  return { climb, remainingMeters, countdownSeconds, climbedGain, totalGain };
}

export interface PerimeterRing {
  readonly path: string;
  readonly perimeter: number;
  readonly segmentLength: number;
  readonly gap: number;
  readonly segments: number;
  readonly filled: number;
}

/**
 * Geometry for a fine-segmented rounded-rectangle progress ring starting at top-center and running
 * clockwise around a card of `width` × `height`.
 */
export function perimeterRing(
  width: number,
  height: number,
  radius: number,
  stroke: number,
  segments: number,
  progress: number,
): PerimeterRing {
  const pad = stroke / 2;
  const rx = Math.min(radius, (width - stroke) / 2, (height - stroke) / 2);
  const rw = Math.max(0, width - stroke);
  const rh = Math.max(0, height - stroke);
  const perimeter = 2 * (rw - 2 * rx) + 2 * (rh - 2 * rx) + 2 * Math.PI * rx;
  const cx = width / 2;
  const path = [
    `M ${cx.toFixed(1)} ${pad.toFixed(1)}`,
    `H ${(width - pad - rx).toFixed(1)}`,
    `A ${rx.toFixed(1)} ${rx.toFixed(1)} 0 0 1 ${(width - pad).toFixed(1)} ${(pad + rx).toFixed(1)}`,
    `V ${(height - pad - rx).toFixed(1)}`,
    `A ${rx.toFixed(1)} ${rx.toFixed(1)} 0 0 1 ${(width - pad - rx).toFixed(1)} ${(height - pad).toFixed(1)}`,
    `H ${(pad + rx).toFixed(1)}`,
    `A ${rx.toFixed(1)} ${rx.toFixed(1)} 0 0 1 ${pad.toFixed(1)} ${(height - pad - rx).toFixed(1)}`,
    `V ${(pad + rx).toFixed(1)}`,
    `A ${rx.toFixed(1)} ${rx.toFixed(1)} 0 0 1 ${(pad + rx).toFixed(1)} ${pad.toFixed(1)}`,
    'Z',
  ].join(' ');
  const gap = 4.5;
  const segmentLength = Math.max(2, perimeter / segments - gap);
  const clamped = Math.min(Math.max(progress, 0), 1);
  const filled = Math.round(segments * clamped);
  return { path, perimeter, segmentLength, gap, segments, filled };
}
