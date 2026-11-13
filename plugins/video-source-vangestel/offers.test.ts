// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeOfferSchema } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import catalog from './catalog/index.json' with { type: 'json' };
import { catalogOffers } from './offers.ts';

const files = {
  tile: (id: string) => `/assets/${id}/thumbnail.jpg`,
  overlay: (id: string, path: string) => `/assets/${id}/overlay/${path}`,
};
const offers = catalogOffers(catalog, files);

describe('catalogOffers', () => {
  it('offers every route of the shipped catalog within the contract', () => {
    expect(offers).toHaveLength(catalog.routes.length);
    for (const offer of offers) {
      expect(routeOfferSchema.safeParse(offer).error).toBeUndefined();
    }
  });

  it('credits the author and the license, and needs a download first', () => {
    expect(offers.find((offer) => offer.id === 'video-source-vangestel/col-de-pennes')).toMatchObject({
      kind: 'video',
      title: 'Col de Pennes - Climb it twice!',
      thumbnail: '/assets/col-de-pennes/overlay/preview.jpg',
      tile: '/assets/col-de-pennes/thumbnail.jpg',
      tags: { country: 'France', level: 'Hard' },
      credits: {
        author: 'Fred Van Gestel',
        source: 'Van Gestel – Cycling pages',
        url: 'https://cycling.vangestel.online/indoor/videos/france/col-de-pennes/',
        license: 'CC BY-NC-SA 4.0',
      },
      availability: { state: 'fetchable', size: 11_213_923_126 },
    });
  });

  it("shows the Drôme routes' pictures under the PNG names their packages give them", () => {
    expect(offers.find((offer) => offer.id === 'video-source-vangestel/source-1')?.thumbnail).toBe(
      '/assets/source-1/overlay/FR_Source_Drome_Part_1.png',
    );
  });

  it('lists every overlay file of the catalog with its hash', () => {
    for (const route of catalog.routes) {
      expect(route.overlay.length, route.id).toBeGreaterThan(0);
      for (const file of route.overlay) {
        // The hash a downloaded route compares at start is that of the file the app ships.
        const bytes = readFileSync(join(import.meta.dirname, 'catalog', route.id, 'overlay', file.path));
        expect(createHash('sha256').update(bytes).digest('hex'), `${route.id}/${file.path}`).toBe(file.sha256);
        expect(bytes.length).toBe(file.size);
      }
    }
  });
});
