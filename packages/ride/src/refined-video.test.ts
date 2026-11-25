// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { parseRefinement } from './refined-video.ts';

const text = (segments: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, video: 'video.mp4', segments, ...extra });
const stretch = (from: number, to: number, file = 'a.mp4', factor = 4) => ({
  from,
  to,
  factor,
  file,
});

describe('parseRefinement', () => {
  it('reads the stretches in the order of their time', () => {
    const refinement = parseRefinement(text([stretch(10, 20, 'b.mp4'), stretch(0, 5, 'a.mp4', 2)]));
    expect(refinement).toEqual({
      version: 1,
      video: 'video.mp4',
      segments: [stretch(0, 5, 'a.mp4', 2), stretch(10, 20, 'b.mp4')],
    });
  });

  it('lets one stretch end where the next begins', () => {
    expect(parseRefinement(text([stretch(0, 5), stretch(5, 9, 'b.mp4')])).segments).toHaveLength(2);
  });

  it.each([
    ['another version', text([], { version: 2 }), 'not a refinement of version 1'],
    ['no video', text([], { video: '' }), 'names no video'],
    ['no stretches', JSON.stringify({ version: 1, video: 'v.mp4' }), 'names no stretches'],
    [
      'a stretch that ends before it begins',
      text([stretch(5, 5)]),
      'stretch 1 has no time from 0 on',
    ],
    ['a stretch before 0', text([stretch(-1, 5)]), 'stretch 1 has no time from 0 on'],
    ['a factor of 1', text([stretch(0, 5, 'a.mp4', 1)]), 'stretch 1 has no factor of 2 or more'],
    [
      'a factor that is no whole number',
      text([stretch(0, 5, 'a.mp4', 2.5)]),
      'stretch 1 has no factor of 2 or more',
    ],
    [
      'a file outside refine/',
      text([stretch(0, 5, '../video.mp4')]),
      'stretch 1 names no file below refine/',
    ],
    [
      'an absolute file',
      text([stretch(0, 5, '/etc/passwd')]),
      'stretch 1 names no file below refine/',
    ],
    [
      'overlapping stretches',
      text([stretch(0, 5), stretch(4, 9, 'b.mp4')]),
      'stretches overlap at 4 s',
    ],
  ])('refuses %s', (_, input, reason) => {
    expect(() => parseRefinement(input)).toThrow(`refine/refine.json: ${reason}`);
  });
});
