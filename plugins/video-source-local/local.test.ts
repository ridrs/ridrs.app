// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DataDrop, DataPick, DroppedFile, MediaFiles, PickedFile, RouteImport, RouteOffer } from '@ridrs/contracts';
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
    entries: async (folder) =>
      [...files]
        .filter(([file]) => file.startsWith(`${folder}/`))
        .map(([file, bytes]) => ({ path: file.slice(folder.length + 1), size: bytes.length })),
  };
}

/** What a chosen package holds and how; `failure` leaves out its control file. */
interface PackageOptions {
  readonly failure?: string;
  readonly title?: string;
  readonly thumbnail?: string;
  readonly stored?: boolean;
}

/** The files of an Incyclist package by their names. */
function packageFiles(options: PackageOptions): Map<string, Uint8Array> {
  const text = (value: string) => new TextEncoder().encode(value);
  const files = new Map<string, Uint8Array>([
    ['Col.mp4', new Uint8Array(1)],
    ['Col.gpx', text(GPX)],
  ]);
  if (!options.failure) {
    const title = options.title ? `<title>${options.title}</title>` : '';
    files.set('Col.xml', text(`<gpx-import>${title}<video-file-path>Col.mp4</video-file-path><gpx-file-path>Col.gpx</gpx-file-path></gpx-import>`));
  }
  if (options.thumbnail) files.set(options.thumbnail, new Uint8Array(3));
  return files;
}

/**
 * A package the rider chose: peeked into, then copied as `route.ride` or unpacked into a folder
 * of the media storage in memory. A copy lays its files out beside it too, as the media storage
 * would read them from the package.
 */
function chosenFile(name: string, options: PackageOptions, stored: string[] = []): PickedFile {
  const files = packageFiles(options);
  const unpack = (folder: string) => {
    for (const [path, bytes] of files) media.files.set(`${folder}/${path}`, bytes);
  };
  return {
    name,
    size: 3,
    peek: async () => ({
      entries: [...files].map(([path, bytes]) => ({
        name: path,
        size: bytes.length,
        stored: options.stored === true && path.endsWith('.mp4'),
        ...(path.endsWith('.mp4') ? {} : { bytes }),
      })),
    }),
    copyTo: async (target) => {
      stored.push(target);
      unpack(target.slice(0, target.lastIndexOf('/')));
    },
    extractTo: async (folder) => unpack(folder),
  };
}

function dialog(name: string | undefined, options: PackageOptions = {}, stored: string[] = []): DataPick {
  return { pick: async () => (name === undefined ? undefined : chosenFile(name, options, stored)) };
}

let media = memoryMedia();

function setup(
  options: PackageOptions & {
    readonly chosen?: string;
    readonly files?: Map<string, Uint8Array>;
  } = {},
) {
  media = memoryMedia(options.files);
  const offers = new Map<string, RouteOffer>();
  const imports: (RouteImport | undefined)[] = [];
  const stored: string[] = [];
  const videos = new LocalVideos({
    offer: (id, offer) => (offer ? offers.set(id, offer) : offers.delete(id)),
    importer: (state) => imports.push(state),
  });
  const services = { media, pick: dialog(options.chosen, options, stored) };
  return { videos, offers, imports, services, stored };
}

describe('titleOf and slugOf', () => {
  it('name a route after its package', () => {
    expect(titleOf('Col_de_la_Madone.zip')).toBe('Col de la Madone');
    expect(titleOf('Col_de_la_Madone.RIDE')).toBe('Col de la Madone');
    expect(slugOf('Côte d’Azur: Col de Vence 4K')).toBe('cote-d-azur-col-de-vence-4k');
    expect(slugOf('???')).toBe('video');
  });
});

describe('LocalVideos', () => {
  it('offers the import only when it can pick and store', async () => {
    const { videos, imports, services } = setup();
    await videos.connect({ ...services, pick: undefined });
    expect(imports).toEqual([]);
    await videos.connect(services);
    expect(imports).toEqual([{ kind: 'video', state: 'idle' }]);
  });

  it('unpacks a chosen package with a compressed video into a ready, removable route', async () => {
    const { videos, offers, imports, services } = setup({ chosen: 'Col de Test.zip' });
    await videos.connect(services);
    expect(await videos.import()).toBe(true);
    await videos.settled();
    const offer = offers.get('video-source-local/col-de-test');
    expect(offer).toMatchObject({ title: 'Col de Test', distance: 200, ascent: 20, availability: { state: 'ready', removable: true } });
    expect(offer?.availability).toMatchObject({ files: { 'Col.mp4': 'media://videos/video-source-local/col-de-test/Col.mp4' } });
    expect(imports.at(-2)).toEqual({ kind: 'video', state: 'importing', file: 'Col de Test.zip' });
    expect(imports.at(-1)).toEqual({ kind: 'video', state: 'idle' });
    expect([...media.files.keys()].filter((file) => file.endsWith('.zip'))).toEqual([]);
  });

  it('keeps a package with a stored video as it is: route.ride in the folder', async () => {
    const { videos, offers, services, stored } = setup({ chosen: 'Col de Test.zip', stored: true });
    await videos.connect(services);
    await videos.import();
    await videos.settled();
    expect(stored).toEqual(['videos/video-source-local/col-de-test/route.ride']);
    expect(offers.get('video-source-local/col-de-test')?.availability.state).toBe('ready');
  });

  it('lists the route under the title its package names', async () => {
    const { videos, offers, services } = setup({ chosen: 'IT_Amalfi.zip', title: 'Driving the Amalfi Coast' });
    await videos.connect(services);
    await videos.import();
    await videos.settled();
    expect(offers.get('video-source-local/it-amalfi')).toMatchObject({ title: 'Driving the Amalfi Coast' });
    expect(JSON.parse(new TextDecoder().decode(media.files.get('videos/video-source-local/routes.json')))).toMatchObject({
      routes: [{ title: 'Driving the Amalfi Coast' }],
    });
  });

  it("offers the package's picture as the route's thumbnail, after a restart too", async () => {
    const { videos, offers, services } = setup({ chosen: 'Col.zip', thumbnail: 'Col_preview.jpg' });
    await videos.connect(services);
    await videos.import();
    await videos.settled();
    const url = 'media://videos/video-source-local/col/Col_preview.jpg';
    expect(offers.get('video-source-local/col')).toMatchObject({ thumbnail: url });
    const again = setup({ files: media.files });
    await again.videos.connect(again.services);
    expect(again.offers.get('video-source-local/col')).toMatchObject({ thumbnail: url });
  });

  it('previews the picture of a dragged package, also a photo of several MB', async () => {
    const track = new TextEncoder().encode(GPX);
    const picture = new Uint8Array(4_400_000).fill(7);
    const dropped = {
      id: 'drop-1',
      name: 'Col.zip',
      size: picture.length,
      copyTo: async () => undefined,
      extractTo: async () => undefined,
      removeOriginal: async () => undefined,
      peek: async () => ({
        entries: [
          { name: 'Col.xml', size: 1, bytes: packageFiles({}).get('Col.xml') },
          { name: 'Col.mp4', size: 1 },
          { name: 'Col.gpx', size: track.length, bytes: track },
          { name: 'preview.jpg', size: picture.length, bytes: picture },
        ],
      }),
    } as DroppedFile;
    const { videos, services } = setup();
    const drop = { file: () => dropped } as unknown as DataDrop;
    await videos.connect({ ...services, drop });
    const answer = await videos.preview('drop-1');
    const url = answer.ok ? (answer.preview.thumbnail ?? '') : '';
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
    // Compared as one buffer: an element-wise comparison of 4.4 MB takes longer than the test may.
    expect(Buffer.from(url.split(',')[1] ?? '', 'base64').equals(picture)).toBe(true);
  });

  it('says how far an import is, once per whole percent', async () => {
    media = memoryMedia();
    const shown: RouteOffer['availability'][] = [];
    const videos = new LocalVideos({
      offer: (_id, offer) => offer && shown.push(offer.availability),
      importer: () => {},
    });
    const chosen = chosenFile('Col de Test.zip', {});
    await videos.connect({
      media,
      pick: {
        pick: async () => ({
          ...chosen,
          extractTo: async (folder, onProgress) => {
            onProgress?.({ received: 1, size: 4 });
            onProgress?.({ received: 1.01, size: 4 });
            onProgress?.({ received: 3, size: 4 });
            await chosen.extractTo(folder);
          },
        }),
      },
    });
    await videos.import();
    await videos.settled();
    // A step of less than a percent says nothing new.
    expect(shown.map((availability) => availability.state === 'importing' && availability.progress)).toEqual([
      undefined,
      0.25,
      0.75,
      false,
    ]);
    expect(shown.at(-1)?.state).toBe('ready');
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
