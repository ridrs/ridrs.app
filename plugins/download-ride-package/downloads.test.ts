// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DataArchive, DataFetch, MediaFiles } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { type Availability, type Downloadable, VideoDownloads } from './downloads.ts';

const ROUTE: Downloadable = {
  id: 'source/pass',
  url: 'https://example.org/pass.zip',
  size: 1000,
  etag: '"v1"',
};

/** The files of the package every download brings: its control file, video and track. */
const PACKAGE = ['route.xml', 'video.mp4', 'track.gpx'];

function setup(options: { failFetch?: string; noControl?: boolean; storedVideo?: boolean } = {}) {
  const files = new Set<string>();
  /** The control file every route on this fake device has (ADR 0094). */
  const CONTROL =
    '<gpx-import><title>Pass</title><video-file-path>video.mp4</video-file-path><gpx-file-path>track.gpx</gpx-file-path></gpx-import>';
  const removed: string[] = [];
  const package_ = options.noControl ? PACKAGE.slice(1) : PACKAGE;
  const media = {
    // A file, or a folder with files below it.
    exists: async (path: string) => files.has(path) || [...files].some((file) => file.startsWith(`${path}/`)),
    read: async () => new TextEncoder().encode(CONTROL),
    write: async (path: string) => void files.add(path),
    // A file, or a folder with everything below it.
    move: async (from: string, to: string) => {
      for (const file of [...files]) {
        if (file === from || file.startsWith(`${from}/`)) {
          files.delete(file);
          files.add(`${to}${file.slice(from.length)}`);
        }
      }
    },
    remove: async (path: string) => {
      removed.push(path);
      // A file, or a folder with everything below it (not `pass.zip` beside the folder `pass`).
      for (const file of [...files]) if (file === path || file.startsWith(`${path}/`)) files.delete(file);
    },
    url: (path: string) => `media:${path}`,
    // A route.ride in a folder lists the package's files, its video stored where it was made so.
    entries: async (folder: string) => [
      ...(files.has(`${folder}/route.ride`)
        ? package_.map((path) => ({ path, size: 1, stored: path === 'video.mp4' ? options.storedVideo === true : false }))
        : []),
      ...[...files]
        .filter((file) => file.startsWith(`${folder}/`) && file !== `${folder}/route.ride`)
        .map((file) => ({ path: file.slice(folder.length + 1), size: 1 })),
    ],
  } as unknown as MediaFiles;
  /** A route's folder as an unpacked package leaves it. */
  const route = (folder: string) => {
    for (const name of PACKAGE) files.add(`${folder}/${name}`);
  };
  const unpacked: string[] = [];
  const archive: DataArchive = {
    extract: async (pack, directory, onProgress) => {
      unpacked.push(pack);
      onProgress?.({ received: 1, size: 2 });
      onProgress?.({ received: 2, size: 2 });
      for (const name of package_) files.add(`${directory}/${name}`);
      return package_.map((name) => `${directory}/${name}`);
    },
  };
  const fetches: unknown[] = [];
  const fetch: DataFetch = {
    fetch: async (job, onProgress) => {
      fetches.push(job);
      onProgress?.({ received: 500, size: 1000 });
      if (options.failFetch) throw new Error(options.failFetch);
      files.add(job.target);
      return { size: 1000 };
    },
  };
  const states: Availability[] = [];
  const changed: string[] = [];
  const downloads = new VideoDownloads([ROUTE], (id) => {
    changed.push(id);
    states.push(downloads.availability(id));
  });
  return {
    downloads,
    files,
    route,
    removed,
    unpacked,
    fetches,
    states,
    changed,
    media,
    fetch,
    services: { media, fetch, archive },
  };
}

describe('VideoDownloads', () => {
  it('fetches a package with a compressed video and unpacks it into the folder; the package goes', async () => {
    const { downloads, files, fetches, states, services } = setup();
    await downloads.connect(services);
    await downloads.fetch(ROUTE.id);
    expect(fetches).toEqual([{ url: ROUTE.url, target: 'videos/source/pass.zip', expected: { size: 1000, etag: '"v1"' } }]);
    // Only the download's own changes: no route was on the device.
    expect(states.map((s) => s.state)).toEqual(['fetching', 'fetching', 'importing', 'importing', 'importing', 'ready']);
    expect(states[1]).toEqual({ state: 'fetching', received: 500, size: 1000 });
    // Unpacking says how far it is, as the import of an own package does.
    expect(states.slice(2, 5)).toEqual([
      { state: 'importing' },
      { state: 'importing', progress: 0.5 },
      { state: 'importing', progress: 1 },
    ]);
    expect(downloads.availability(ROUTE.id)).toEqual({
      state: 'ready',
      files: {
        'route.xml': 'media:videos/source/pass/route.xml',
        'video.mp4': 'media:videos/source/pass/video.mp4',
        'track.gpx': 'media:videos/source/pass/track.gpx',
      },
      removable: true,
    });
    expect([...files].sort()).toEqual([
      'videos/source/pass/route.xml',
      'videos/source/pass/track.gpx',
      'videos/source/pass/video.mp4',
    ]);
  });

  it('finds the routes already on the device', async () => {
    const { downloads, route, changed, services } = setup();
    route('videos/source/pass');
    await downloads.connect(services);
    expect(downloads.availability(ROUTE.id).state).toBe('ready');
    expect(changed).toEqual([ROUTE.id]);
  });

  it('moves a route a former source downloaded into its own folder', async () => {
    const { downloads, route, files, services } = setup();
    route('videos/old/pass');
    await downloads.connect(services);
    await downloads.setRoutes([ROUTE, { ...ROUTE, id: 'source/other', former: 'videos/old/pass' }]);
    expect(downloads.availability('source/other').state).toBe('ready');
    expect([...files].filter((file) => file.startsWith('videos/old/'))).toEqual([]);
    expect([...files].filter((file) => file.startsWith('videos/source/other/')).sort()).toEqual([
      'videos/source/other/route.xml',
      'videos/source/other/track.gpx',
      'videos/source/other/video.mp4',
    ]);
  });

  it("fetches the catalog's overlay from where ridrs Scenic serves it, beside the downloaded route", async () => {
    const { downloads, fetches, services } = setup();
    await downloads.connect(services);
    const overlay = [{ path: 'preview.jpg', size: 3, sha256: 'abc', url: 'https://scenic.example/vg/pass/overlay/preview.jpg' }];
    await downloads.setRoutes([{ ...ROUTE, overlay }]);
    await downloads.fetch(ROUTE.id);
    expect(fetches).toContainEqual({ url: overlay[0]?.url, target: 'videos/source/pass/preview.jpg', expected: { size: 3 } });
  });

  it('says why a download cannot start, before it starts', async () => {
    const { downloads, media, fetch, services } = setup();
    expect(downloads.refusal(ROUTE.id)).toBe('This app cannot download routes yet');
    await downloads.connect(services);
    expect(downloads.refusal(ROUTE.id)).toBeUndefined();
    expect(downloads.refusal('source/nowhere')).toBe('There is no route "source/nowhere"');
  });

  it('says why a download failed and leaves no half route', async () => {
    const { downloads, removed, services } = setup({ noControl: true });
    await downloads.connect(services);
    await downloads.fetch(ROUTE.id);
    expect(downloads.availability(ROUTE.id)).toEqual({
      state: 'failed',
      reason: 'The downloaded package has no control file that names its video and track',
      size: 1000,
    });
    expect(removed).toContain('videos/source/pass');
  });

  it('fails with a reason where the platform cannot download', async () => {
    const { downloads } = setup();
    await downloads.connect({});
    await downloads.fetch(ROUTE.id);
    expect(downloads.availability(ROUTE.id)).toMatchObject({ state: 'failed', reason: 'This app cannot download routes yet' });
  });

  it('removes a downloaded route, which can then be fetched again', async () => {
    const { downloads, files, services } = setup();
    await downloads.connect(services);
    await downloads.fetch(ROUTE.id);
    await downloads.remove(ROUTE.id);
    expect(files.size).toBe(0);
    expect(downloads.availability(ROUTE.id)).toEqual({ state: 'fetchable', size: 1000 });
  });

  it('keeps a package with a stored video as route.ride, unpacking nothing', async () => {
    const { downloads, files, unpacked, services } = setup({ storedVideo: true });
    await downloads.connect(services);
    await downloads.fetch(ROUTE.id);
    expect(downloads.availability(ROUTE.id).state).toBe('ready');
    expect(unpacked).toEqual([]);
    expect([...files]).toEqual(['videos/source/pass/route.ride']);
  });

  it('lets a downloaded package be unpacked to the end: no cancel then', async () => {
    const { downloads, services } = setup();
    let unpacking: () => void = () => {};
    const unpacked = new Promise<void>((done) => {
      unpacking = done;
    });
    let goOn: () => void = () => {};
    const archive = {
      extract: async (pack: string, directory: string, onProgress?: (p: { received: number; size?: number }) => void) => {
        onProgress?.({ received: 1, size: 2 });
        unpacking();
        await new Promise<void>((resume) => {
          goOn = resume;
        });
        return services.archive.extract(pack, directory, onProgress);
      },
    };
    await downloads.connect({ ...services, archive });
    const download = downloads.fetch(ROUTE.id);
    await unpacked;
    expect(downloads.availability(ROUTE.id)).toEqual({ state: 'importing', progress: 0.5 });
    downloads.cancel(ROUTE.id);
    goOn();
    await download;
    expect(downloads.availability(ROUTE.id).state).toBe('ready');
  });

  it('cancels a download on its way: the route can be fetched again', async () => {
    const { downloads, services, removed } = setup();
    let started: () => void = () => {};
    const running = new Promise<void>((done) => {
      started = done;
    });
    const fetch: DataFetch = {
      fetch: (_job, onProgress, signal) => {
        onProgress?.({ received: 100, size: 1000 });
        started();
        return new Promise((_, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      },
    };
    await downloads.connect({ ...services, fetch });
    const download = downloads.fetch(ROUTE.id);
    await running;
    expect(downloads.availability(ROUTE.id).state).toBe('fetching');
    downloads.cancel(ROUTE.id);
    await download;
    expect(downloads.availability(ROUTE.id)).toEqual({ state: 'fetchable', size: 1000 });
    expect(removed).not.toContain('videos/source/pass');
  });
});

