// SPDX-License-Identifier: AGPL-3.0-or-later

import { routeOfferSchema } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
// The answer of ridrs Scenic for the scenarios, and the test vector of the format, shared with Scenic's own tests.
import scenic from '../../tests/fixtures/scenic/ride-catalog.json' with { type: 'json' };
import vector from '../../web/scenic/test/fixtures/ride-catalog/catalog.example.json' with { type: 'json' };
import { parseCatalog, type RideCatalog } from './catalog.ts';
import { catalogOffers, downloadables } from './offers.ts';

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

describe('downloadables', () => {
  it('names the download, the overlay with sizes and hashes, and where the former Van Gestel source kept it', () => {
    const [route] = downloadables(catalogOf(vector));
    expect(route).toMatchObject({
      id: 'video-source-scenic/vg-test-climb',
      url: 'https://cycling.example.org/rlv/XX_Test_Climb.zip',
      size: 2_000_012_345,
      etag: '"abc-123"',
      former: 'videos/video-source-vangestel/test-climb',
      overlay: [{ path: 'preview.jpg', size: 26, url: expect.stringContaining('/vg/test-climb/overlay/preview.jpg?h=') }],
    });
    expect(route?.overlay?.[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
