// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { fitted } from './picture.ts';

describe('fitted', () => {
  it('makes a wide picture 800 px wide and keeps its proportions', () => {
    expect(fitted(2752, 1536, 800)).toEqual({ width: 800, height: 447 });
  });

  it('keeps a smaller picture as it is', () => {
    expect(fitted(640, 360, 800)).toEqual({ width: 640, height: 360 });
  });
});
