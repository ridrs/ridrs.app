// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { BT2020_TO_DISPLAY_P3, isPqBt2020, pqToNits, yuvToRgb } from './hdr.ts';

describe('the HDR colour maths', () => {
  it('takes PQ with BT.2020 primaries and matrix only', () => {
    expect(isPqBt2020({ primaries: 9, transfer: 16, matrix: 9, fullRange: false })).toBe(true);
    expect(isPqBt2020({ primaries: 9, transfer: 18, matrix: 9, fullRange: false })).toBe(false); // HLG
    expect(isPqBt2020({ primaries: 1, transfer: 1, matrix: 1, fullRange: false })).toBe(false);
    expect(isPqBt2020(undefined)).toBe(false);
  });

  it('keeps white white from BT.2020 to Display P3', () => {
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0, i = 0] = BT2020_TO_DISPLAY_P3;
    // columns: the rows of the matrix are (a d g), (b e h), (c f i)
    for (const sum of [a + d + g, b + e + h, c + f + i]) {
      expect(sum).toBeCloseTo(1, 4);
    }
  });

  it('follows SMPTE ST 2084 at its ends and at 100 cd/m²', () => {
    expect(pqToNits(0)).toBe(0);
    expect(pqToNits(1)).toBeCloseTo(10000, 6);
    expect(pqToNits(0.5080784)).toBeCloseTo(100, 1);
  });

  it('maps full-range grey to equal R′G′B′', () => {
    const m = yuvToRgb(true);
    const sample = [0.5, 128 / 255, 128 / 255, 1];
    const rgb = [0, 1, 2].map((r) => sample.reduce((sum, v, j) => sum + v * (m[4 * r + j] ?? Number.NaN), 0));
    for (const v of rgb) {
      expect(v).toBeCloseTo(0.5, 6);
    }
  });
});
