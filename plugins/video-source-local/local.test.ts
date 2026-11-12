// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DataPick, MediaFiles, RouteImport, RouteOffer, VideoImporter } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { LocalVideos, slugOf, titleOf } from './local.ts';

const GPX = `<gpx><trk><trkseg>${Array.from(
  { length: 21 },
  (_, i) => `<trkpt lat="${(44 + (i * 10) / 111_195).toFixed(6)}" lon="5"><ele>${100 + i}</ele></trkpt>`,
).join('')}</trkseg></trk></gpx>`;

/** The media storage in memory: a file is its bytes by path. */
function memoryMedia(files = new Map<string, Uint8Array>()): MediaFiles & { files: Map<string, Uint8Array> } {
  return {
    files,
    exists: async (path) => files.has(path),
    read: async (path) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`No file ${path}`);
      return bytes;
    },
    write: async (path, bytes) => void files.set(path, bytes),
    move: async (from, to) => {
      files.set(to, files.get(from) ?? new Uint8Array());
      files.delete(from);
    },
    remove: async (path) => {
      for (const file of [...files.keys()]) if (file === path || file.startsWith(`${path}/`)) files.delete(file);
    },
    location: (path) => `/media/${path}`,
    url: (path) => `media://${path}`,
  };
}

/** An importer that writes the route's files, or fails with `failure`. */
function importer(media: MediaFiles, failure?: string): VideoImporter {
  return {
    format: 'incyclist-gpx-import',
    async import(_pack, directory, facts) {
      if (failure) throw new Error(failure);
      await media.write(`${directory}/track.gpx`, new TextEncoder().encode(GPX));
      await media.write(`${directory}/video.mp4`, new Uint8Array(1));
      const route = {
        format: 'ridrs-video-route' as const,
        version: 1 as const,
        title: facts.title,
        notes: [],
        segments: [],
        video: { file: 'video.mp4', framerate: 30, startFrame: 1 },
        track: { file: 'track.gpx' },
        imported: { by: 'test', version: '1' },
      };
      await media.write(`${directory}/route.json`, new TextEncoder().encode(JSON.stringify(route)));
      return route;
    },
  };
}

function dialog(name: string | undefined): DataPick {
  return {
    pick: async () =>
      name === undefined ? undefined : { name, size: 3, copyTo: async (target) => void media.files.set(target, new Uint8Array(3)) },
  };
}

let media = memoryMedia();

function setup(options: { readonly chosen?: string; readonly failure?: string; readonly files?: Map<string, Uint8Array> } = {}) {
  media = memoryMedia(options.files);
  const offers = new Map<string, RouteOffer>();
  const imports: (RouteImport | undefined)[] = [];
  const videos = new LocalVideos({
    offer: (id, offer) => (offer ? offers.set(id, offer) : offers.delete(id)),
    importer: (state) => imports.push(state),
  });
  const services = { media, pick: dialog(options.chosen), importers: () => [importer(media, options.failure)] };
  return { videos, offers, imports, services };
}

describe('titleOf and slugOf', () => {
  it('name a route after its package', () => {
    expect(titleOf('Col_de_la_Madone.zip')).toBe('Col de la Madone');
    expect(slugOf('Côte d’Azur: Col de Vence 4K')).toBe('cote-d-azur-col-de-vence-4k');
    expect(slugOf('???')).toBe('video');
  });
});

describe('LocalVideos', () => {
  it('offers the import only when it can pick, store and import', async () => {
    const { videos, imports, services } = setup();
    await videos.connect({ ...services, pick: undefined });
    expect(imports).toEqual([]);
    await videos.connect(services);
    expect(imports).toEqual([{ kind: 'video', state: 'idle' }]);
  });

  it('imports a chosen package as a ready, removable offer and keeps no package', async () => {
    const { videos, offers, imports, services } = setup({ chosen: 'Col de Test.zip' });
    await videos.connect(services);
    expect(await videos.import()).toBe(true);
    await videos.settled();
    const offer = offers.get('video-source-local/col-de-test');
    expect(offer).toMatchObject({ title: 'Col de Test', distance: 200, ascent: 20, availability: { state: 'ready', removable: true } });
    expect(offer?.availability).toMatchObject({ files: { 'video.mp4': 'media://videos/video-source-local/col-de-test/video.mp4' } });
    expect(imports.at(-2)).toEqual({ kind: 'video', state: 'importing', file: 'Col de Test.zip' });
    expect(imports.at(-1)).toEqual({ kind: 'video', state: 'idle' });
    expect([...media.files.keys()].filter((file) => file.endsWith('.zip'))).toEqual([]);
  });

  it('offers the imported routes again after a restart', async () => {
    const first = setup({ chosen: 'Col de Test.zip' });
    await first.videos.connect(first.services);
    await first.videos.import();
    await first.videos.settled();
    const again = setup({ files: media.files });
    await again.videos.connect(again.services);
    expect([...again.offers.keys()]).toEqual(['video-source-local/col-de-test']);
    expect(again.offers.get('video-source-local/col-de-test')?.sparkline).toHaveLength(640);
  });

  it('gives the same package imported twice a second id', async () => {
    const { videos, offers, services } = setup({ chosen: 'Col de Test.zip' });
    await videos.connect(services);
    await videos.import();
    await videos.settled();
    await videos.import();
    await videos.settled();
    expect([...offers.keys()]).toEqual(['video-source-local/col-de-test', 'video-source-local/col-de-test-2']);
  });

  it('answers false and changes nothing when the rider cancels', async () => {
    const { videos, offers, imports, services } = setup();
    await videos.connect(services);
    expect(await videos.import()).toBe(false);
    expect(offers.size).toBe(0);
    expect(imports).toEqual([{ kind: 'video', state: 'idle' }]);
  });

  it('says why an import failed and leaves nothing behind', async () => {
    const { videos, offers, imports, services } = setup({ chosen: 'Holiday.zip', failure: 'The package has no control file' });
    await videos.connect(services);
    await videos.import();
    await videos.settled();
    expect(offers.size).toBe(0);
    expect(imports.at(-1)).toEqual({
      kind: 'video',
      state: 'failed',
      file: 'Holiday.zip',
      reason: 'The package has no control file',
    });
    expect([...media.files.keys()]).toEqual([]);
  });

  it('refuses a second import while one is on its way', async () => {
    const { videos, services } = setup({ chosen: 'Col de Test.zip' });
    await videos.connect(services);
    await videos.import();
    await expect(videos.import()).rejects.toThrow('An import is on its way');
    await videos.settled();
  });

  it('removes an imported route from the device and the offers', async () => {
    const { videos, offers, services } = setup({ chosen: 'Col de Test.zip' });
    await videos.connect(services);
    await videos.import();
    await videos.settled();
    await videos.remove('video-source-local/col-de-test');
    expect(offers.size).toBe(0);
    expect([...media.files.keys()]).toEqual(['videos/video-source-local/routes.json']);
  });
});
