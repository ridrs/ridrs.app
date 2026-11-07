// SPDX-License-Identifier: AGPL-3.0-or-later

import { routeOfferSchema } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import catalog from './catalog/index.json' with { type: 'json' };
import { catalogOffers } from './offers.ts';

const offers = catalogOffers(catalog, (id) => `/assets/${id}/thumbnail.jpg`);

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
      thumbnail: '/assets/col-de-pennes/thumbnail.jpg',
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
});
