// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DataFetch, MediaFiles, VideoImporter } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { type Availability, type Downloadable, VideoDownloads } from './downloads.ts';

const ROUTE: Downloadable = {
  id: 'source/pass',
  url: 'https://example.org/pass.zip',
  size: 1000,
  etag: '"v1"',
  format: 'test-format',
  facts: { title: 'Pass', source: { name: 'S', author: 'A', url: 'https://example.org/', license: 'L' } },
};

function setup(options: { failFetch?: string; failImport?: string } = {}) {
  const files = new Set<string>();
  /** The control file every route on this fake device has (ADR 0094). */
  const CONTROL =
    '<gpx-import><title>Pass</title><video-file-path>video.mp4</video-file-path><gpx-file-path>track.gpx</gpx-file-path></gpx-import>';
  const removed: string[] = [];
  const media = {
    exists: async (path: string) => files.has(path),
    read: async () => new TextEncoder().encode(CONTROL),
    write: async (path: string) => void files.add(path),
    remove: async (path: string) => {
      removed.push(path);
      for (const file of [...files]) if (file.startsWith(path)) files.delete(file);
    },
    url: (path: string) => `media:${path}`,
    entries: async (folder: string) =>
      [...files]
        .filter((file) => file.startsWith(`${folder}/`))
        .map((file) => ({ path: file.slice(folder.length + 1), size: 1 })),
  } as unknown as MediaFiles;
  /** A route's folder as the importer leaves it. */
  const route = (folder: string) => {
    for (const name of ['route.xml', 'video.mp4', 'track.gpx']) files.add(`${folder}/${name}`);
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
  const importer: VideoImporter = {
    format: 'test-format',
    inspect: () => ({ ok: false, reason: 'Not inspected here' }),
    import: async (_pack, directory, facts) => {
      if (options.failImport) throw new Error(options.failImport);
      route(directory);
      return {
        format: 'ridrs-video-route',
        version: 1,
        title: facts.title ?? 'Pass',
        notes: [],
        segments: [],
        video: { file: 'video.mp4', framerate: 30, startFrame: 1 },
        track: { file: 'track.gpx' },
        imported: { by: 'test', version: '1' },
      };
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
    fetches,
    states,
    changed,
    media,
    fetch,
    services: { media, fetch, importers: () => [importer] },
  };
}

describe('VideoDownloads', () => {
  it('fetches, imports and keeps the route; the package goes', async () => {
    const { downloads, files, fetches, states, services } = setup();
    await downloads.connect(services);
    await downloads.fetch(ROUTE.id);
    expect(fetches).toEqual([{ url: ROUTE.url, target: 'videos/source/pass.zip', expected: { size: 1000, etag: '"v1"' } }]);
    // Only the download's own changes: no route was on the device.
    expect(states.map((s) => s.state)).toEqual(['fetching', 'fetching', 'ready']);
    expect(states[1]).toEqual({ state: 'fetching', received: 500, size: 1000 });
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

  it('says why a download cannot start, before it starts', async () => {
    const { downloads, media, fetch, services } = setup();
    expect(downloads.refusal(ROUTE.id)).toBe('This app cannot download routes yet');
    await downloads.connect({ media, fetch, importers: () => [] });
    expect(downloads.refusal(ROUTE.id)).toBe('No importer reads the format "test-format"');
    await downloads.connect(services);
    expect(downloads.refusal(ROUTE.id)).toBeUndefined();
    expect(downloads.refusal('source/nowhere')).toBe('There is no route "source/nowhere"');
  });

  it('says why a download failed and leaves no half route', async () => {
    const { downloads, removed, services } = setup({ failImport: 'The package has no control file' });
    await downloads.connect(services);
    await downloads.fetch(ROUTE.id);
    expect(downloads.availability(ROUTE.id)).toEqual({ state: 'failed', reason: 'The package has no control file', size: 1000 });
    expect(removed).toContain('videos/source/pass');
  });

  it('fails with a reason where the platform cannot download', async () => {
    const { downloads } = setup();
    await downloads.connect({ importers: () => [] });
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

