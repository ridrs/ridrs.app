// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  type Control,
  controlFromRoute,
  decodeText,
  inspectPackage,
  parseControl,
  pictureOf,
  writeControl,
} from './index.ts';

const CONTROL = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<gpx-import>
    <name>FR_Col_de_Pennes</name>
    <video-file-path>FR_Col_de_Pennes.mp4</video-file-path>
    <gpx-file-path>FR_Col_de_Pennes.gpx</gpx-file-path>
    <framerate>30.0</framerate>
    <start-frame>12</start-frame>
	<informations>
		<information distance="20" de="Col de Pennes\\nL&auml;nge: 46,2 km" en="Col de Pennes\\nLength: 46.2 km" />
		<information distance="700" de="Recoubeau" en="Recoubeau" />
    </informations>
	<segments>
		<segment name="First climb: approach via Jansac (11.2 km)" start="0" end="11230" />
	</segments>
</gpx-import>`;

describe('decodeText', () => {
  it('reads UTF-16 by its byte order mark and UTF-8 without one', () => {
    expect(decodeText(new Uint8Array([0xfe, 0xff, 0, 0x41, 0, 0xe4]))).toBe('Aä');
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0]))).toBe('A');
    expect(decodeText(new TextEncoder().encode('Ä'))).toBe('Ä');
  });
});

describe('parseControl', () => {
  it('takes the files, the timing, the notes with HTML entities and the segments', () => {
    expect(parseControl(CONTROL)).toEqual({
      video: 'FR_Col_de_Pennes.mp4',
      name: 'Col de Pennes',
      gpx: 'FR_Col_de_Pennes.gpx',
      framerate: 30,
      startFrame: 12,
      notes: [
        {
          distance: 20,
          text: { de: 'Col de Pennes\nLänge: 46,2 km', en: 'Col de Pennes\nLength: 46.2 km' },
        },
        { distance: 700, text: { de: 'Recoubeau', en: 'Recoubeau' } },
      ],
      segments: [{ name: 'First climb: approach via Jansac (11.2 km)', start: 0, end: 11230 }],
    });
  });

  it('takes the title the control file names', () => {
    const titled = CONTROL.replace(
      '<video-file-path>',
      '<title>Col de Pennes &amp; Jansac</title>\n    <video-file-path>',
    );
    expect(parseControl(titled).title).toBe('Col de Pennes & Jansac');
    expect(parseControl(CONTROL)).not.toHaveProperty('title');
  });

  it('refuses a control file without video or track', () => {
    expect(() => parseControl('<gpx-import><name>x</name></gpx-import>')).toThrow('names no video');
  });
});

describe('inspectPackage', () => {
  const control = {
    name: 'pack/FR_Col_de_Pennes.xml',
    size: CONTROL.length,
    bytes: new TextEncoder().encode(CONTROL),
  };
  const video = { name: 'pack/FR_Col_de_Pennes.mp4', size: 15_000_000_000 };
  const track = { name: 'pack/FR_Col_de_Pennes.gpx', size: 1000, bytes: new Uint8Array(1000) };

  it('finds the track of a package, whatever else it holds', () => {
    const extra = { name: 'LIESMICH.txt', size: 10, bytes: new TextEncoder().encode('Hallo') };
    expect(inspectPackage([video, track, control, extra])).toEqual({
      ok: true,
      track: 'pack/FR_Col_de_Pennes.gpx',
      title: 'Col de Pennes',
    });
  });

  it('names the picture next to the video for the preview', () => {
    const picture = {
      name: 'pack/FR_Col_de_Pennes_preview.jpg',
      size: 3,
      bytes: new Uint8Array(3),
    };
    expect(inspectPackage([video, track, control, picture])).toEqual({
      ok: true,
      track: track.name,
      title: 'Col de Pennes',
      thumbnail: picture.name,
    });
  });

  it('names the title of the control file for the preview', () => {
    const text = CONTROL.replace(
      '<video-file-path>',
      '<title>Col de Pennes</title><video-file-path>',
    );
    const titled = { ...control, bytes: new TextEncoder().encode(text) };
    expect(inspectPackage([video, track, titled])).toEqual({
      ok: true,
      track: track.name,
      title: 'Col de Pennes',
    });
  });

  it('names the route by its name where the control file names no title', () => {
    expect(inspectPackage([video, track, control])).toMatchObject({ title: 'Col de Pennes' });
  });

  it('says why a ZIP is no package', () => {
    expect(inspectPackage([video])).toEqual({
      ok: false,
      reason: 'The package has no control file',
    });
    expect(inspectPackage([control, video])).toEqual({
      ok: false,
      reason: 'The package has no file "FR_Col_de_Pennes.gpx"',
    });
    const empty = { name: 'x.xml', size: 5, bytes: new TextEncoder().encode('<a/>') };
    expect(inspectPackage([empty])).toEqual({
      ok: false,
      reason: 'The control file names no video or no GPX track',
    });
  });
});

describe('pictureOf', () => {
  it("takes the picture Incyclist looks for next to the video, in Incyclist's order", () => {
    const video = 'pack/FR_Col.mp4';
    expect(
      pictureOf(bare(video), ['pack/FR_Col_preview.jpg', 'pack/preview.JPG', video], video),
    ).toBe('pack/preview.JPG');
    expect(
      pictureOf(bare(video), ['pack/FR_Col_preview.jpg', 'pack/FR_Col_preview.png'], video),
    ).toBe('pack/FR_Col_preview.png');
  });

  it('takes no thumbnail.png or .jpg: Incyclist shows neither; <preview> names any picture', () => {
    const video = 'pack/FR_Col.mp4';
    expect(
      pictureOf(bare(video), ['pack/thumbnail.jpg', 'pack/Thumbnail.PNG', video], video),
    ).toBeUndefined();
    const named = { ...bare(video), preview: 'thumbnail.jpg' };
    expect(pictureOf(named, ['pack/thumbnail.jpg', video], video)).toBe('pack/thumbnail.jpg');
  });

  it('ignores other pictures and pictures in another folder', () => {
    expect(
      pictureOf(
        bare('pack/FR_Col.mp4'),
        ['pack/FR_Col.png', 'preview.png', 'pack/profile.jpg'],
        'pack/FR_Col.mp4',
      ),
    ).toBeUndefined();
  });
});

/** A control file of `video` that names nothing else. */
const bare = (video: string): Control => ({
  video,
  gpx: 'x.gpx',
  framerate: 30,
  startFrame: 1,
  notes: [],
  segments: [],
});

describe('parseControl, as Incyclist reads', () => {
  it('takes a title per language in its first language', () => {
    const text = CONTROL.replace(
      '<video-file-path>',
      '<title><de>Amalfiküste</de><en>Amalfi Coast</en></title><video-file-path>',
    );
    expect(parseControl(text).title).toBe('Amalfiküste');
  });

  it('takes the name without its country, and the picture it names', () => {
    const text = CONTROL.replace(
      '<video-file-path>',
      '<preview>FR_Col.jpg</preview><video-file-path>',
    );
    expect(parseControl(text)).toMatchObject({ name: 'Col de Pennes', preview: 'FR_Col.jpg' });
    expect(parseControl(CONTROL.replace('FR_Col_de_Pennes</name>', 'Col-Pennes</name>')).name).toBe(
      'Col-Pennes',
    );
  });
});

describe('pictureOf, with a picture named', () => {
  it('takes the picture the control file names before the names Incyclist looks for', () => {
    const control = { ...bare('pack/FR_Col.mp4'), preview: 'pictures/col.JPG' };
    expect(
      pictureOf(control, ['pack/preview.jpg', 'pack/pictures/col.jpg'], 'pack/FR_Col.mp4'),
    ).toBe('pack/pictures/col.jpg');
    expect(pictureOf(control, ['pack/preview.jpg'], 'pack/FR_Col.mp4')).toBe('pack/preview.jpg');
  });
});

describe('writeControl', () => {
  it('writes a control file that reads back the same, characters XML needs escaped included', () => {
    const control: Control = {
      video: 'video.mp4',
      gpx: 'track.gpx',
      title: 'Col de Pennes & "Jansac" <2>',
      preview: 'thumbnail.jpg',
      framerate: 29.97,
      startFrame: 12,
      notes: [
        { distance: 20, text: { de: 'Col de Pennes\nLänge: 46,2 km', en: "It's <steep> & long" } },
      ],
      segments: [{ name: 'First climb & descent', start: 0, end: 11230 }],
    };
    expect(parseControl(writeControl(control))).toEqual(control);
  });

  it('writes notes as the sources do: a line break as \\n', () => {
    const text = writeControl({ ...bare('v.mp4'), notes: [{ distance: 0, text: { en: 'a\nb' } }] });
    expect(text).toContain('en="a\\nb"');
  });

  it('writes a control file without notes and segments that Incyclist reads', () => {
    expect(parseControl(writeControl(bare('v.mp4')))).toEqual(bare('v.mp4'));
  });
});

describe('controlFromRoute', () => {
  it('keeps the files of a route in the unified format and names its picture', () => {
    const control = controlFromRoute({
      format: 'ridrs-video-route',
      version: 1,
      title: 'Col',
      notes: [],
      segments: [],
      video: { file: 'video.mp4', framerate: 30, startFrame: 1 },
      track: { file: 'track.gpx' },
      thumbnail: { file: 'thumbnail.jpg' },
      imported: { by: 'video-import-incyclist', version: '1' },
    });
    expect(control).toEqual({
      ...bare('video.mp4'),
      gpx: 'track.gpx',
      title: 'Col',
      preview: 'thumbnail.jpg',
    });
  });
});
