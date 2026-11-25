// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { loadDownloadedRoute, parseGpx } from './library.ts';

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

describe('parseGpx', () => {
  it('reads every point with its time since the first, leaving out points without an elevation', () => {
    expect(parseGpx(GPX)).toEqual([
      { latitude: 44.660088, longitude: 5.419971, elevation: 459.85, time: 0 },
      { latitude: 44.659966, longitude: 5.41993, elevation: 459.71, time: 5 },
      { latitude: 44.659843, longitude: 5.419851, elevation: 459.41, time: 11 },
    ]);
  });
});

describe('loadDownloadedRoute', () => {
  /** As Tauri's `convertFileSrc` makes them: the whole path is one encoded segment. */
  const asset = (path: string) => `asset://localhost/${encodeURIComponent(path)}`;
  const folder = '/Users/rider/Library/Application Support/org.ridrs.app/media/videos/source/pennes';
  const files = {
    'FR_Col_de_Pennes.xml': asset(`${folder}/FR_Col_de_Pennes.xml`),
    'fr_col_de_pennes.MP4': asset(`${folder}/fr_col_de_pennes.MP4`),
    'FR_Col_de_Pennes.gpx': asset(`${folder}/FR_Col_de_Pennes.gpx`),
    'LIESMICH.txt': asset(`${folder}/LIESMICH.txt`),
  };

  it('reads the control file among the offer\'s files and takes the URL of every file from the offer', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return new Response(CONTROL);
    });
    try {
      expect(await loadDownloadedRoute('source/pennes', files)).toEqual({
        id: 'source/pennes',
        title: 'Col de Pennes - Climb it twice!',
        videoUrl: files['fr_col_de_pennes.MP4'],
        gpxUrl: files['FR_Col_de_Pennes.gpx'],
        framerate: 30,
        startFrame: 31,
        refined: [],
      });
      expect(fetched).toEqual([files['FR_Col_de_Pennes.xml']]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('names the route by its name where the control file names no title', async () => {
    vi.stubGlobal('fetch', async () => new Response(CONTROL.replace(/<title>.*<\/title>/, '')));
    try {
      expect((await loadDownloadedRoute('source/pennes', files)).title).toBe('Col de Pennes');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says when no control file of the offer names a video and a track it holds', async () => {
    vi.stubGlobal('fetch', async () => new Response(CONTROL));
    try {
      const { 'FR_Col_de_Pennes.gpx': _, ...withoutTrack } = files;
      await expect(loadDownloadedRoute('source/pennes', withoutTrack)).rejects.toThrow(
        'The downloaded route "source/pennes" has no control file',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
