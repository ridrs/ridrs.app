// SPDX-License-Identifier: AGPL-3.0-or-later

import { routeOfferSchema } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
// The answer of ridrs Scenic for the scenarios, and the test vector of the format, shared with Scenic's own tests.
import scenic from '../../tests/fixtures/scenic/ride-catalog.json' with { type: 'json' };
import vector from '../../web/scenic/test/fixtures/ride-catalog/catalog.example.json' with { type: 'json' };
import { parseCatalog, type RideCatalog } from './catalog.ts';
import { catalogOffers, routeDownloads } from './offers.ts';

const catalogOf = (value: unknown) => parseCatalog(value) as RideCatalog;

describe('catalogOffers', () => {
  it('offers every route of the catalog within the contract', () => {
    for (const catalog of [catalogOf(scenic), catalogOf(vector)]) {
      const offers = catalogOffers(catalog);
      expect(offers).toHaveLength(catalog.routes.length);
      for (const offer of offers) expect(routeOfferSchema.safeParse(offer).error).toBeUndefined();
    }
  });

  it("credits the source's author and license, names the country, and needs a download first", () => {
    expect(catalogOffers(catalogOf(vector))[0]).toMatchObject({
      id: 'video-source-scenic/vg-test-climb',
      kind: 'video',
      title: 'Test Climb - Part 1 - Col de Test',
      distance: 1400,
      ascent: 100,
      duration: 300,
      thumbnail: expect.stringMatching(/^https:\/\/ridrs\.example\.org\/scenic\/vg\/test-climb\/overlay\/preview\.jpg\?h=[0-9a-f]{12}$/),
      tile: expect.stringMatching(/^https:\/\/ridrs\.example\.org\/scenic\/vg\/test-climb\/thumbnail\.jpg\?h=[0-9a-f]{12}$/),
      tags: { country: 'France', level: 'Moderate', tour: { name: 'Test Climb', part: 1 } },
      credits: {
        author: 'Test Author',
        source: 'Van Gestel – Cycling pages',
        url: 'https://cycling.example.org/indoor/videos/france/test-climb/',
        license: 'CC BY-NC-SA 4.0',
      },
      availability: { state: 'fetchable', size: 2_000_012_345 },
      world: { landscape: 'ui-world-video/landscape', route: 'video-source-scenic/vg-test-climb' },
    });
  });

  it("shows the Drôme routes' pictures under the PNG names their packages give them", () => {
    const offer = catalogOffers(catalogOf(scenic)).find((o) => o.id === 'video-source-scenic/vg-source-1');
    expect(offer?.thumbnail).toMatch(/\/scenic\/vg\/source-1\/overlay\/FR_Source_Drome_Part_1\.png\?h=/);
  });
});

describe('routeDownloads', () => {
  it('describes each download by its kind: a package with its URL, ETag and overlay, and where the former Van Gestel source kept it', () => {
    const [route] = routeDownloads(catalogOf(vector));
    expect(route).toMatchObject({
      id: 'video-source-scenic/vg-test-climb',
      kind: 'ride-package',
      size: 2_000_012_345,
      former: 'videos/video-source-vangestel/test-climb',
      details: {
        url: 'https://cycling.example.org/rlv/XX_Test_Climb.zip',
        etag: '"abc-123"',
        overlay: [{ path: 'preview.jpg', size: 26, url: expect.stringContaining('/vg/test-climb/overlay/preview.jpg?h=') }],
      },
    });
    expect((route?.details.overlay as { sha256: string }[])[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("takes a route's kind from the catalog where it names one", () => {
    const catalog = catalogOf(vector);
    const [first] = catalog.routes;
    const named = { ...catalog, routes: [{ ...first, download: { ...first?.download, kind: 'other' } }] } as RideCatalog;
    expect(routeDownloads(named)[0]?.kind).toBe('other');
  });

  it("hands a YouTube video's download to the downloader with its video, frame rate and package", () => {
    const catalog = catalogOf(vector);
    const youtube = { ...catalog, routes: [YOUTUBE] } as RideCatalog;
    expect(routeDownloads(youtube)).toEqual([
      {
        id: 'video-source-scenic/YTYTYTYTY02',
        kind: 'youtube',
        size: 600_000_000,
        details: {
          url: 'https://ridrs.example.org/scenic/api/videos/YTYTYTYTY02/incyclist.zip',
          format: 'incyclist-gpx-import',
          video: 'YTYTYTYTY02',
          fps: 30,
          overlay: [],
        },
      },
    ]);
  });
});

/** A YouTube video of the catalog, as ridrs Scenic lists it (docs/formats/scenic-ride-catalog-v1.md). */
const YOUTUBE = {
  id: 'YTYTYTYTY02',
  source: 'youtube',
  title: 'Passo di Test',
  page: 'https://www.youtube.com/watch?v=YTYTYTYTY02',
  author: 'Test Channel',
  country: 'IT',
  distance: 1200,
  ascent: 120,
  duration: 600,
  sparkline: [500, 560, 620],
  climbs: [],
  overlay: [],
  download: {
    kind: 'youtube',
    url: 'https://ridrs.example.org/scenic/api/videos/YTYTYTYTY02/incyclist.zip',
    format: 'incyclist-gpx-import',
    size: 600_000_000,
    video: 'YTYTYTYTY02',
    fps: 30,
  },
};

const YOUTUBE_SOURCE = {
  name: 'YouTube',
  url: 'https://www.youtube.com/',
  license: { id: null, name: 'Standard YouTube License', url: 'https://www.youtube.com/t/terms' },
};

describe('a YouTube video', () => {
  it("is credited to its channel under YouTube's license", () => {
    const catalog = { ...catalogOf(vector), sources: { youtube: YOUTUBE_SOURCE }, routes: [YOUTUBE] } as unknown as RideCatalog;
    const [offer] = catalogOffers(catalog);
    expect(routeOfferSchema.safeParse(offer).error).toBeUndefined();
    expect(offer?.credits).toEqual({
      author: 'Test Channel',
      source: 'YouTube',
      url: 'https://www.youtube.com/watch?v=YTYTYTYTY02',
      license: 'Standard YouTube License',
    });
  });

  it('uses its catalog tile as both card tile and detail thumbnail', () => {
    const tile = 'https://ridrs.example.org/scenic/api/images/bbbbbbbbbbbbbbbbbbbbbbbb';
    const catalog = { ...catalogOf(vector), sources: { youtube: YOUTUBE_SOURCE }, routes: [{ ...YOUTUBE, tile }] } as unknown as RideCatalog;
    const [offer] = catalogOffers(catalog);
    expect(routeOfferSchema.safeParse(offer).error).toBeUndefined();
    expect(offer?.tile).toBe(tile);
    expect(offer?.thumbnail).toBe(tile);
  });
});
