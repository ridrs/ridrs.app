// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { demoCourseOffer } from './offer.ts';

describe('demoCourseOffer', () => {
  it('describes the demo course up to where it stays flat', () => {
    const offer = demoCourseOffer();
    expect(offer).toMatchObject({ distance: 4500, ascent: 50, world: { landscape: 'ui-landscape-demo/landscape' } });
    // 2 km flat, 1 km at 5 %, 500 m flat, 1 km at −5 %.
    expect(offer.sparkline?.[8]).toBe(0);
    expect(offer.sparkline?.[12]).toBe(50);
    expect(offer.sparkline?.[14]).toBe(50);
    expect(offer.sparkline?.at(-1)).toBe(0);
  });
});
