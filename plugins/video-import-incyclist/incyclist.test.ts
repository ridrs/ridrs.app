// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DataArchive, MediaFiles } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { createIncyclistImporter, decodeText, inspectIncyclist, parseControl, thumbnailOf } from './incyclist.ts';

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
      gpx: 'FR_Col_de_Pennes.gpx',
      framerate: 30,
      startFrame: 12,
      notes: [
        { distance: 20, text: { de: 'Col de Pennes\nLänge: 46,2 km', en: 'Col de Pennes\nLength: 46.2 km' } },
        { distance: 700, text: { de: 'Recoubeau', en: 'Recoubeau' } },
      ],
      segments: [{ name: 'First climb: approach via Jansac (11.2 km)', start: 0, end: 11230 }],
    });
  });

  it('takes the title the control file names', () => {
    const titled = CONTROL.replace('<video-file-path>', '<title>Col de Pennes &amp; Jansac</title>\n    <video-file-path>');
    expect(parseControl(titled).title).toBe('Col de Pennes & Jansac');
    expect(parseControl(CONTROL)).not.toHaveProperty('title');
  });

  it('refuses a control file without video or track', () => {
    expect(() => parseControl('<gpx-import><name>x</name></gpx-import>')).toThrow('names no video');
  });
});

describe('inspectIncyclist', () => {
  const control = { name: 'pack/FR_Col_de_Pennes.xml', size: CONTROL.length, bytes: new TextEncoder().encode(CONTROL) };
  const video = { name: 'pack/FR_Col_de_Pennes.mp4', size: 15_000_000_000 };
  const track = { name: 'pack/FR_Col_de_Pennes.gpx', size: 1000, bytes: new Uint8Array(1000) };

  it('finds the track of a package, whatever else it holds', () => {
    const extra = { name: 'LIESMICH.txt', size: 10, bytes: new TextEncoder().encode('Hallo') };
    expect(inspectIncyclist([video, track, control, extra])).toEqual({ ok: true, track: 'pack/FR_Col_de_Pennes.gpx' });
  });

  it('names the picture next to the video for the preview', () => {
    const picture = { name: 'pack/FR_Col_de_Pennes_preview.jpg', size: 3, bytes: new Uint8Array(3) };
    expect(inspectIncyclist([video, track, control, picture])).toEqual({
      ok: true,
      track: track.name,
      thumbnail: picture.name,
    });
  });

  it('names the title of the control file for the preview', () => {
    const text = CONTROL.replace('<video-file-path>', '<title>Col de Pennes</title><video-file-path>');
    const titled = { ...control, bytes: new TextEncoder().encode(text) };
    expect(inspectIncyclist([video, track, titled])).toEqual({ ok: true, track: track.name, title: 'Col de Pennes' });
  });

  it('says why a ZIP is no package', () => {
    expect(inspectIncyclist([video])).toEqual({ ok: false, reason: 'The package has no control file' });
    expect(inspectIncyclist([control, video])).toEqual({
      ok: false,
      reason: 'The package has no file "FR_Col_de_Pennes.gpx"',
    });
    const empty = { name: 'x.xml', size: 5, bytes: new TextEncoder().encode('<a/>') };
    expect(inspectIncyclist([empty])).toEqual({ ok: false, reason: 'The control file names no video or no GPX track' });
  });
});

describe('thumbnailOf', () => {
  it("takes the picture Incyclist looks for next to the video, in Incyclist's order", () => {
    const video = 'pack/FR_Col.mp4';
    expect(thumbnailOf(['pack/FR_Col_preview.jpg', 'pack/preview.JPG', video], video)).toBe('pack/preview.JPG');
    expect(thumbnailOf(['pack/FR_Col_preview.jpg', 'pack/FR_Col_preview.png'], video)).toBe('pack/FR_Col_preview.png');
  });

  it('takes thumbnail.png or .jpg after the names Incyclist looks for', () => {
    const video = 'pack/FR_Col.mp4';
    expect(thumbnailOf(['pack/thumbnail.jpg', video], video)).toBe('pack/thumbnail.jpg');
    expect(thumbnailOf(['pack/Thumbnail.PNG', 'pack/thumbnail.jpg'], video)).toBe('pack/Thumbnail.PNG');
    expect(thumbnailOf(['pack/thumbnail.jpg', 'pack/FR_Col_preview.jpg'], video)).toBe('pack/FR_Col_preview.jpg');
  });

  it('ignores other pictures and pictures in another folder', () => {
    expect(thumbnailOf(['pack/FR_Col.png', 'preview.png', 'pack/profile.jpg'], 'pack/FR_Col.mp4')).toBeUndefined();
  });
});

describe('createIncyclistImporter', () => {
  it('makes a ridrs video route of the package and keeps nothing else', async () => {
    const files = new Map<string, Uint8Array>([['r/package/FR_Col-de-Pennes.xml', new TextEncoder().encode(CONTROL)]]);
    const media = {
      read: async (path: string) => files.get(path) ?? new Uint8Array(),
      write: async (path: string, bytes: Uint8Array) => void files.set(path, bytes),
      move: async (from: string, to: string) => {
        files.set(to, files.get(from) ?? new Uint8Array());
        files.delete(from);
      },
      remove: async (path: string) => [...files.keys()].filter((key) => key.startsWith(path)).forEach((key) => files.delete(key)),
    } as unknown as MediaFiles;
    const archive: DataArchive = {
      extract: async (_archive, directory, onProgress) => {
        onProgress?.({ received: 1, size: 4 });
        onProgress?.({ received: 2 });
        files.set(`${directory}/FR_Col_de_Pennes.mp4`, new Uint8Array([1]));
        files.set(`${directory}/FR_Col_de_Pennes.gpx`, new Uint8Array([2]));
        return [...files.keys()].filter((key) => key.startsWith(directory));
      },
    };
    const source = { name: 'Van Gestel', author: 'Fred Van Gestel', url: 'https://example.org/', license: 'CC BY-NC-SA 4.0' };
    const heard: number[] = [];
    const route = await createIncyclistImporter(media, archive).import('r.zip', 'r', { title: 'Col de Pennes', source }, (share) =>
      heard.push(share),
    );
    // Unpacking is the import's work; a word without the size in all says nothing.
    expect(heard).toEqual([0.25]);
    expect(route).toMatchObject({ title: 'Col de Pennes', video: { file: 'video.mp4', startFrame: 12 }, track: { file: 'track.gpx' } });
    expect(route).not.toHaveProperty('thumbnail');
    expect([...files.keys()].sort()).toEqual(['r/route.json', 'r/track.gpx', 'r/video.mp4']);
  });

  it('titles the route as its control file does, not as its package is named', async () => {
    const text = CONTROL.replace('<video-file-path>', '<title>Driving the Amalfi Coast</title><video-file-path>');
    const files = new Map<string, Uint8Array>([['r/package/c.xml', new TextEncoder().encode(text)]]);
    const media = {
      read: async (path: string) => files.get(path) ?? new Uint8Array(),
      write: async (path: string, bytes: Uint8Array) => void files.set(path, bytes),
      move: async () => undefined,
      remove: async () => undefined,
    } as unknown as MediaFiles;
    const archive: DataArchive = {
      extract: async (_archive, directory) => [
        ...files.keys(),
        `${directory}/FR_Col_de_Pennes.mp4`,
        `${directory}/FR_Col_de_Pennes.gpx`,
      ],
    };
    const route = await createIncyclistImporter(media, archive).import('r.zip', 'r', { fallbackTitle: 'IT Driving the Amalfi Coast' });
    expect(route.title).toBe('Driving the Amalfi Coast');
    const named = await createIncyclistImporter(media, archive).import('r.zip', 'r', { title: 'Amalfi', fallbackTitle: 'x' });
    expect(named.title).toBe('Amalfi');
  });

  it('keeps the picture Incyclist would show as thumbnail.png', async () => {
    const files = new Map<string, Uint8Array>([['r/package/c.xml', new TextEncoder().encode(CONTROL)]]);
    const media = {
      read: async (path: string) => files.get(path) ?? new Uint8Array(),
      write: async (path: string, bytes: Uint8Array) => void files.set(path, bytes),
      move: async (from: string, to: string) => {
        files.set(to, files.get(from) ?? new Uint8Array());
        files.delete(from);
      },
      remove: async (path: string) => [...files.keys()].filter((key) => key.startsWith(path)).forEach((key) => files.delete(key)),
    } as unknown as MediaFiles;
    const archive: DataArchive = {
      extract: async (_archive, directory) => {
        for (const name of ['FR_Col_de_Pennes.mp4', 'FR_Col_de_Pennes.gpx', 'FR_Col_de_Pennes.png', 'FR_Col_de_Pennes_preview.PNG']) {
          files.set(`${directory}/${name}`, new TextEncoder().encode(name));
        }
        return [...files.keys()].filter((key) => key.startsWith(directory));
      },
    };
    const route = await createIncyclistImporter(media, archive).import('r.zip', 'r', { fallbackTitle: 'Col' });
    expect(route.thumbnail).toEqual({ file: 'thumbnail.png' });
    expect(new TextDecoder().decode(files.get('r/thumbnail.png'))).toBe('FR_Col_de_Pennes_preview.PNG');
    expect([...files.keys()].sort()).toEqual(['r/route.json', 'r/thumbnail.png', 'r/track.gpx', 'r/video.mp4']);
  });
});
