// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { parseTimedTrack, parseTrackPositions } from './track.ts';

describe('parseTrackPositions', () => {
  it('reads every point with a position, across tracks and segments, in order', () => {
    const gpx = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="46.1" lon="7.2"><ele>512.5</ele></trkpt>
    <trkpt lat="46.2" lon="7.3"/>
  </trkseg><trkseg>
    <trkpt lat="x" lon="7.4"><ele>1</ele></trkpt>
  </trkseg></trk>
  <trk><trkseg><trkpt lat="46.3" lon="7.5"><ele>530</ele></trkpt></trkseg></trk>
</gpx>`;
    expect(parseTrackPositions(gpx)).toEqual([
      { latitude: 46.1, longitude: 7.2, elevation: 512.5 },
      { latitude: 46.2, longitude: 7.3 },
      { latitude: 46.3, longitude: 7.5, elevation: 530 },
    ]);
  });

  it('finds none in a file without a track', () => {
    expect(parseTrackPositions('<gpx version="1.1"/>')).toEqual([]);
  });
});

describe('parseTimedTrack', () => {
  it('reads each point with its time since the first, leaving out points without one', () => {
    const gpx = `<?xml version="1.0"?><gpx><trk><trkseg>
      <trkpt lat="45.1" lon="5.2"><ele>500.5</ele><time>2024-06-01T10:00:00Z</time></trkpt>
      <trkpt lat="45.2" lon="5.3"><ele>501</ele></trkpt>
      <trkpt lat="45.3" lon="5.4"><ele>502</ele><time>2024-06-01T10:00:02.500Z</time></trkpt>
    </trkseg><trkseg>
      <trkpt lat="45.4" lon="5.5"><ele>0</ele><time>2024-06-01T10:00:04Z</time></trkpt>
    </trkseg></trk></gpx>`;
    expect(parseTimedTrack(gpx)).toEqual([
      { latitude: 45.1, longitude: 5.2, elevation: 500.5, time: 0 },
      { latitude: 45.3, longitude: 5.4, elevation: 502, time: 2.5 },
      { latitude: 45.4, longitude: 5.5, elevation: 0, time: 4 },
    ]);
  });
});
