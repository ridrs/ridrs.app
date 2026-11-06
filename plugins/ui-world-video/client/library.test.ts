// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { parseControlFile, parseGpx } from './library.ts';

const CONTROL = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<gpx-import>
    <name>FR_Col_de_Pennes</name>
    <title>Col de Pennes - Climb it twice!</title>
    <video-file-path>FR_Col_de_Pennes.mp4</video-file-path>
    <gpx-file-path>FR_Col_de_Pennes.gpx</gpx-file-path>
    <framerate>30.0</framerate>
    <start-frame>31</start-frame>
    <informations>
      <information distance="20" de="L&auml;nge: 46,2 km" en="Col de Pennes\\nLength: 46.2 km - Total ascent: 1,177 hm" />
      <information distance="100" en="License" />
    </informations>
</gpx-import>`;

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gte="http://www.gpstrackeditor.com/xmlschemas/General/1">
  <trk><trkseg>
    <trkpt lat="44.660088" lon="5.419971"><ele>459.85</ele><time>1999-12-31T23:00:00Z</time>
      <extensions><gte:gps speed="16.8"/></extensions></trkpt>
    <trkpt lat="44.659966" lon="5.419930"><ele>459.71</ele><time>1999-12-31T23:00:05Z</time></trkpt>
    <trkpt lat="44.6599" lon="5.4199"><time>1999-12-31T23:00:07Z</time></trkpt>
    <trkpt lat="44.659843" lon="5.419851"><ele>459.41</ele><time>1999-12-31T23:00:11Z</time></trkpt>
  </trkseg></trk>
</gpx>`;

describe('parseControlFile', () => {
  it('reads the title, the files in the folder, the frame rate and the start frame', () => {
    expect(parseControlFile(CONTROL, 'FR Pennes', '/videos/')).toEqual({
      id: 'FR Pennes',
      title: 'Col de Pennes - Climb it twice!',
      summary: 'Col de Pennes · Length: 46.2 km - Total ascent: 1,177 hm',
      videoUrl: '/videos/FR%20Pennes/FR_Col_de_Pennes.mp4',
      gpxUrl: '/videos/FR%20Pennes/FR_Col_de_Pennes.gpx',
      framerate: 30,
      startFrame: 31,
    });
  });

  it('reads the HTML entities the control files use', () => {
    const control = CONTROL.replace('<title>Col de Pennes', '<title>Walnu&szlig;plantagen &amp; Col de Pennes');
    expect(parseControlFile(control, 'x').title).toBe('Walnußplantagen & Col de Pennes - Climb it twice!');
  });

  it('rejects a control file without a video', () => {
    expect(() => parseControlFile('<gpx-import><title>x</title></gpx-import>', 'x')).toThrow(/no video/);
  });
});

describe('parseGpx', () => {
  it('reads every point with its time since the first, leaving out points without an elevation', () => {
    expect(parseGpx(GPX)).toEqual([
      { latitude: 44.660088, longitude: 5.419971, elevation: 459.85, time: 0 },
      { latitude: 44.659966, longitude: 5.41993, elevation: 459.71, time: 5 },
      { latitude: 44.659843, longitude: 5.419851, elevation: 459.41, time: 11 },
    ]);
  });
});
