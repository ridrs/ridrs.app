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
  const ROUTE_JSON = JSON.stringify({
    format: 'ridrs-video-route',
    version: 1,
    title: 'Pass',
    source: { name: 'S', author: 'A', url: 'https://example.org/', license: 'L' },
    notes: [],
    segments: [],
    video: { file: 'video.mp4', framerate: 30, startFrame: 1 },
    track: { file: 'track.gpx' },
    imported: { by: 'test', version: '1' },
  });
  const removed: string[] = [];
  const media = {
    exists: async (path: string) => files.has(path),
    read: async () => new TextEncoder().encode(ROUTE_JSON),
    remove: async (path: string) => {
      removed.push(path);
      for (const file of [...files]) if (file.startsWith(path)) files.delete(file);
    },
    url: (path: string) => `media:${path}`,
  } as unknown as MediaFiles;
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
    import: async (_pack, directory, facts) => {
      if (options.failImport) throw new Error(options.failImport);
      files.add(`${directory}/route.json`);
      return { ...JSON.parse(ROUTE_JSON), title: facts.title };
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
        'route.json': 'media:videos/source/pass/route.json',
        'video.mp4': 'media:videos/source/pass/video.mp4',
        'track.gpx': 'media:videos/source/pass/track.gpx',
      },
      removable: true,
    });
    expect([...files]).toEqual(['videos/source/pass/route.json']);
  });

  it('finds the routes already on the device', async () => {
    const { downloads, files, changed, services } = setup();
    files.add('videos/source/pass/route.json');
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

