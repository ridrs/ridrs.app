// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DataArchive, MediaFiles } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { createIncyclistImporter } from './incyclist.ts';

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
