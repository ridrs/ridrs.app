// SPDX-License-Identifier: AGPL-3.0-or-later

import { XMLParser } from 'fast-xml-parser';

/** What a route's card and details tell about its GPX track. */
export interface TrackFacts {
  /** m along the track, and m climbed on it. */
  readonly distance: number;
  readonly ascent: number;
  /** s from the first to the last point, where the track has times. */
  readonly duration?: number;
  /** Elevations (m) evenly spaced from the start to the end. */
  readonly sparkline: readonly number[];
}

/** m between the elevations the ascent adds up: GPS elevation jitter between fixes does not count. */
const SPACING = 100;
/** Elevations of a card's profile, as the catalog of the Van Gestel routes has them. */
const SPARKLINE = 640;
const EARTH_RADIUS = 6_371_008.8;

interface Point {
  readonly latitude: number;
  readonly longitude: number;
  readonly elevation: number;
  readonly time: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === 'trk' || name === 'trkseg' || name === 'trkpt',
});

/**
 * s since 1970 of a GPX time (`2022-12-28T09:00:05Z`, also with fractions and an offset); NaN for
 * any other text. By the calendar, without `Date`: plugins read no clock (AGENTS.md, rule 7).
 */
export function secondsOf(time: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(Z|([+-])(\d{2}):?(\d{2}))$/.exec(time.trim());
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi, s, , sign, oh, om] = match;
  // Days since 1970-01-01 of a date of the Gregorian calendar (Howard Hinnant's days_from_civil).
  const month = Number(mo);
  const year = Number(y) - (month <= 2 ? 1 : 0);
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + Number(d) - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const days = era * 146_097 + dayOfEra - 719_468;
  const offset = sign ? (sign === '-' ? -1 : 1) * (Number(oh) * 3600 + Number(om) * 60) : 0;
  return days * 86_400 + Number(h) * 3600 + Number(mi) * 60 + Number(s) - offset;
}

type Node = Record<string, unknown>;
const nodes = (value: unknown): Node[] => (Array.isArray(value) ? (value as Node[]) : []);

/** Every point of every track and segment, in order; a point without a position is left out. */
function pointsOf(gpx: string): Point[] {
  const root = (parser.parse(gpx) as { gpx?: Node }).gpx;
  const points = nodes(root?.trk)
    .flatMap((track) => nodes(track.trkseg))
    .flatMap((segment) => nodes(segment.trkpt))
    .map((point) => ({
      latitude: Number(point.lat),
      longitude: Number(point.lon),
      elevation: Number(point.ele ?? 0),
      time: secondsOf(String(point.time ?? '')),
    }))
    .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
  if (points.length < 2) {
    throw new Error('The GPX track has fewer than two points');
  }
  return points;
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** The great-circle distance (m) between two points. */
function haversine(a: Point, b: Point): number {
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

/** The distance, climb, duration and profile of a GPX track. */
export function trackFacts(gpx: string): TrackFacts {
  const points = pointsOf(gpx);
  const distances = [0];
  for (let i = 1; i < points.length; i += 1) {
    distances.push((distances[i - 1] ?? 0) + haversine(points[i - 1] as Point, points[i] as Point));
  }
  const length = distances.at(-1) ?? 0;
  /** The elevation at `distance` m, linear between the points around it. */
  const elevationAt = (distance: number) => {
    let i = distances.findIndex((at) => at > distance);
    if (i <= 0) i = i === 0 ? 1 : points.length - 1;
    const from = distances[i - 1] ?? 0;
    const to = distances[i] ?? from;
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    const f = to > from ? Math.min(1, Math.max(0, (distance - from) / (to - from))) : 1;
    return a.elevation + (b.elevation - a.elevation) * f;
  };
  /** Elevations every `spacing` m, the last at the end. */
  const along = (spacing: number) => {
    const elevations = [];
    for (let distance = 0; distance < length; distance += spacing) elevations.push(elevationAt(distance));
    elevations.push(elevationAt(length));
    return elevations;
  };
  const profile = along(SPACING);
  const ascent = profile.slice(1).reduce((sum, elevation, i) => sum + Math.max(0, elevation - (profile[i] ?? 0)), 0);
  const first = points[0]?.time ?? Number.NaN;
  const last = points.at(-1)?.time ?? Number.NaN;
  const duration = last - first;
  return {
    distance: round(length, 0),
    ascent: round(ascent, 0),
    ...(Number.isFinite(duration) && duration > 0 ? { duration: round(duration, 0) } : {}),
    // By index, not by adding up a spacing: rounding would add a sample now and then.
    sparkline: Array.from({ length: SPARKLINE }, (_, i) => round(elevationAt((length * i) / (SPARKLINE - 1)), 1)),
  };
}
