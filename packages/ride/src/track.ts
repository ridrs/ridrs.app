// SPDX-License-Identifier: AGPL-3.0-or-later

import { XMLParser } from 'fast-xml-parser';

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
}

/**
 * Where the GPX track of a route runs: every track point with a position, in the order of its
 * tracks and segments; points without one are left out. For the map of a route, not its time.
 */
export function parseTrackPositions(text: string): TrackPosition[] {
  const gpx = (parser.parse(text) as { gpx?: { trk?: { trkseg?: { trkpt?: GpxPoint[] }[] }[] } })
    .gpx;
  const positions: TrackPosition[] = [];
  for (const track of gpx?.trk ?? []) {
    for (const segment of track.trkseg ?? []) {
      for (const point of segment.trkpt ?? []) {
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
    }
  }
  return positions;
}
