// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DataArchive, MediaFiles } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { createIncyclistImporter, decodeText, parseControl } from './incyclist.ts';

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

  it('refuses a control file without video or track', () => {
    expect(() => parseControl('<gpx-import><name>x</name></gpx-import>')).toThrow('names no video');
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
      extract: async (_archive, directory) => {
        files.set(`${directory}/FR_Col_de_Pennes.mp4`, new Uint8Array([1]));
        files.set(`${directory}/FR_Col_de_Pennes.gpx`, new Uint8Array([2]));
        return [...files.keys()].filter((key) => key.startsWith(directory));
      },
    };
    const source = { name: 'Van Gestel', author: 'Fred Van Gestel', url: 'https://example.org/', license: 'CC BY-NC-SA 4.0' };
    const route = await createIncyclistImporter(media, archive).import('r.zip', 'r', { title: 'Col de Pennes', source });
    expect(route).toMatchObject({ title: 'Col de Pennes', video: { file: 'video.mp4', startFrame: 12 }, track: { file: 'track.gpx' } });
    expect([...files.keys()].sort()).toEqual(['r/route.json', 'r/track.gpx', 'r/video.mp4']);
  });
});
