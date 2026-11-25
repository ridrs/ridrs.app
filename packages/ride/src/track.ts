// SPDX-License-Identifier: AGPL-3.0-or-later

import { XMLParser } from 'fast-xml-parser';
import type { TrackPoint } from './route-track.ts';

/** A point of a route's GPX track where it lies: WGS 84 degrees, and m above sea level if known. */
export interface TrackPosition {
  readonly latitude: number;
  readonly longitude: number;
  readonly elevation?: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  isArray: (name) => name === 'trk' || name === 'trkseg' || name === 'trkpt',
});

interface GpxPoint {
  readonly '@lat'?: string;
  readonly '@lon'?: string;
  readonly ele?: number | string;
  readonly time?: string;
}

/** The track points of a GPX file, in the order of its tracks and segments. */
function gpxPoints(text: string): GpxPoint[] {
  const gpx = (parser.parse(text) as { gpx?: { trk?: { trkseg?: { trkpt?: GpxPoint[] }[] }[] } })
    .gpx;
  return (gpx?.trk ?? []).flatMap((track) =>
    (track.trkseg ?? []).flatMap((segment) => segment.trkpt ?? []),
  );
}

/**
 * Where the GPX track of a route runs: every track point with a position, in the order of its
 * tracks and segments; points without one are left out. For the map of a route, not its time.
 */
export function parseTrackPositions(text: string): TrackPosition[] {
  const positions: TrackPosition[] = [];
  for (const point of gpxPoints(text)) {
    const latitude = Number(point['@lat']);
    const longitude = Number(point['@lon']);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const elevation = Number(point.ele);
    positions.push(
      Number.isFinite(elevation) && point.ele !== undefined && point.ele !== ''
        ? { latitude, longitude, elevation }
        : { latitude, longitude },
    );
  }
  return positions;
}

/**
 * The points of a GPX track in order, each with its time since the first point: the time of the
 * video at that point. Points without a position, an elevation or a time are left out. As the
 * video world's `parseGpx` reads a track, without a DOM (ADR 0110).
 */
export function parseTimedTrack(text: string): TrackPoint[] {
  const points: TrackPoint[] = [];
  let start: number | undefined;
  for (const point of gpxPoints(text)) {
    const latitude = Number(point['@lat']);
    const longitude = Number(point['@lon']);
    const elevation = point.ele === undefined || point.ele === '' ? Number.NaN : Number(point.ele);
    const at = Date.parse(String(point.time ?? '').trim());
    if (![latitude, longitude, elevation, at].every(Number.isFinite)) continue;
    start ??= at;
    points.push({ latitude, longitude, elevation, time: (at - start) / 1000 });
  }
  return points;
}
