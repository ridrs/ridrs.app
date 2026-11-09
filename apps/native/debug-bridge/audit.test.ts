// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { audit, contrast, type LayoutFact, type LayoutInput, parseColor } from './audit.ts';

const fact = (over: Partial<LayoutFact> = {}): LayoutFact => ({
  path: 'main > button:0',
  tag: 'button',
  text: 'Go',
  interactive: false,
  display: 'block',
  rect: { x: 0, y: 0, w: 100, h: 40 },
  scrollW: 100,
  clientW: 100,
  scrollH: 40,
  clientH: 40,
  overflowX: 'visible',
  overflowY: 'visible',
  fontSize: 16,
  fontWeight: 400,
  color: 'rgb(0, 0, 0)',
  background: 'rgb(255, 255, 255)',
  backgroundImage: false,
  clippedByAncestor: false,
  ...over,
});

const page = (facts: LayoutFact[], documentScrollWidth = 800): LayoutInput => ({
  viewport: { width: 800, height: 600 },
  documentScrollWidth,
  facts,
  truncated: false,
});

const kinds = (facts: LayoutFact[], width?: number) =>
  audit(page(facts, width)).map((issue) => issue.kind);

describe('colours', () => {
  it('parses computed colours', () => {
    expect(parseColor('rgb(1, 2, 3)')).toEqual([1, 2, 3, 1]);
    expect(parseColor('rgba(1, 2, 3, 0.5)')).toEqual([1, 2, 3, 0.5]);
    expect(parseColor('rgb(1 2 3 / 50%)')).toEqual([1, 2, 3, 0.5]);
    expect(parseColor('transparent')).toBeUndefined();
  });

  it('gives the WCAG ratio', () => {
    expect(contrast([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 1);
    expect(contrast([119, 119, 119, 1], [255, 255, 255, 1])).toBeCloseTo(4.48, 1);
    expect(contrast([255, 255, 255, 1], [255, 255, 255, 1])).toBe(1);
  });
});

describe('the layout audit', () => {
  it('finds nothing in a sound page', () => {
    expect(
      kinds([
        fact(),
        fact({ path: 'main > a:1', interactive: true, rect: { x: 0, y: 50, w: 100, h: 40 } }),
      ]),
    ).toEqual([]);
  });

  it('finds text that is cut off', () => {
    expect(kinds([fact({ overflowX: 'hidden', scrollW: 180 })])).toEqual(['clipped-text']);
    expect(kinds([fact({ overflowY: 'hidden', scrollH: 90 })])).toEqual(['clipped-text']);
    expect(kinds([fact({ overflowX: 'auto', scrollW: 180 })])).toEqual([]);
  });

  it('finds a page that is wider than the window, and what reaches past it', () => {
    const wide = fact({ path: 'main > div:0', rect: { x: 700, y: 0, w: 300, h: 40 }, text: '' });
    const found = audit(page([wide], 1000));
    expect(found.map((issue) => issue.path)).toEqual(['document', 'main > div:0']);
    expect(kinds([wide])).toEqual([]);
    expect(kinds([{ ...wide, clippedByAncestor: true }], 1000)).toEqual(['horizontal-overflow']);
  });

  it('finds an element with no size', () => {
    expect(kinds([fact({ rect: { x: 0, y: 0, w: 0, h: 40 } })])).toEqual(['zero-size']);
    expect(kinds([fact({ text: '', rect: { x: 0, y: 0, w: 0, h: 0 } })])).toEqual([]);
  });

  it('finds small targets, but not an inline link', () => {
    const small = fact({ interactive: true, rect: { x: 0, y: 0, w: 20, h: 40 } });
    expect(kinds([small])).toEqual(['small-target']);
    expect(kinds([{ ...small, display: 'inline' }])).toEqual([]);
  });

  it('finds low contrast, with a lower limit for large text, and no verdict over an image', () => {
    const grey = fact({ color: 'rgb(130, 130, 130)' });
    expect(kinds([grey])).toEqual(['low-contrast']);
    expect(kinds([{ ...grey, fontSize: 28 }])).toEqual([]);
    expect(kinds([{ ...grey, backgroundImage: true }])).toEqual([]);
  });

  it('finds targets that overlap, but not a target in a target', () => {
    const a = fact({
      path: 'main > div:0 > button:0',
      interactive: true,
      rect: { x: 0, y: 0, w: 100, h: 40 },
    });
    const b = fact({
      path: 'main > div:0 > button:1',
      interactive: true,
      rect: { x: 50, y: 0, w: 100, h: 40 },
    });
    expect(kinds([a, b])).toEqual(['overlap']);
    expect(kinds([a, { ...b, path: 'main > div:0 > button:0 > span:0' }])).toEqual([]);
    expect(kinds([a, { ...b, rect: { x: 95, y: 0, w: 100, h: 40 } }])).toEqual([]);
  });
});
