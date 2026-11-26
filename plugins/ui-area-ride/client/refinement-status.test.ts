// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { estimateEnd } from './refinement-status.ts';

describe('estimateEnd', () => {
  it('goes on at the pace since the first sample', () => {
    // 10 % in 60 s from 20 %: the 70 % left take 420 s more.
    expect(estimateEnd({ at: 0, progress: 0.2 }, { at: 60_000, progress: 0.3 })).toBeCloseTo(480_000);
  });

  it('says nothing while too little time has passed', () => {
    expect(estimateEnd({ at: 0, progress: 0 }, { at: 10_000, progress: 0.2 })).toBeUndefined();
  });

  it('says nothing while too little of the refinement has passed', () => {
    expect(estimateEnd({ at: 0, progress: 0.5 }, { at: 60_000, progress: 0.5 })).toBeUndefined();
  });
});
