// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import shipped from '../layout.json' with { type: 'json' };
import { breakpointAt, columnsAt, layoutSchema } from './layout.ts';

const tile = (contribution: string, wide: number, medium?: number) => ({
  contribution,
  columns: medium === undefined ? { wide } : { wide, medium },
});

describe('layoutSchema', () => {
  it('accepts the shipped layout', () => {
    expect(layoutSchema.safeParse(shipped).success).toBe(true);
  });

  it('accepts a layout without menu and top bar', () => {
    expect(layoutSchema.safeParse({ version: 1, tiles: [tile('a/b', 12)] }).success).toBe(true);
  });

  it('rejects a contribution placed twice', () => {
    const result = layoutSchema.safeParse({ version: 1, tiles: [tile('a/b', 6), tile('a/b', 6)] });
    expect(result.error?.issues[0]?.message).toBe('"a/b" is placed twice');
  });

  it.each([0, 13, 2.5])('rejects a span of %s', (columns) => {
    expect(layoutSchema.safeParse({ version: 1, tiles: [tile('a/b', columns)] }).success).toBe(false);
  });

  it('rejects a key without its contribution id', () => {
    expect(layoutSchema.safeParse({ version: 1, tiles: [tile('plugin', 6)] }).success).toBe(false);
  });

  it('places global actions in order, each once', () => {
    expect(layoutSchema.parse({ version: 1, tiles: [] }).actions).toEqual([]);
    const twice = layoutSchema.safeParse({ version: 1, tiles: [], actions: ['a/b', 'a/b'] });
    expect(twice.error?.issues[0]?.message).toBe('"a/b" is placed twice');
  });

  it('takes no screens over unless it names them', () => {
    expect(layoutSchema.parse({ version: 1, tiles: [] }).screens).toEqual([]);
    expect(layoutSchema.parse({ version: 1, tiles: [], screens: ['setup'] }).screens).toEqual([
      'setup',
    ]);
  });

  it('rejects a screen named twice or not as a screen id', () => {
    const twice = layoutSchema.safeParse({ version: 1, tiles: [], screens: ['setup', 'setup'] });
    expect(twice.error?.issues[0]?.message).toBe('"setup" is named twice');
    expect(layoutSchema.safeParse({ version: 1, tiles: [], screens: ['Setup'] }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields and versions', () => {
    expect(layoutSchema.safeParse({ version: 1, tiles: [], rows: 2 }).success).toBe(false);
    expect(layoutSchema.safeParse({ version: 2, tiles: [] }).success).toBe(false);
  });
});

describe('breakpoints', () => {
  it.each([
    [1400, 'wide'],
    [1200, 'wide'],
    [1199, 'medium'],
    [768, 'medium'],
    [767, 'compact'],
    [0, 'compact'],
  ] as const)('%i px is %s', (width, breakpoint) => {
    expect(breakpointAt(width)).toBe(breakpoint);
  });

  it('gives each breakpoint its span', () => {
    expect(columnsAt(tile('a/b', 8, 12), 'wide')).toBe(8);
    expect(columnsAt(tile('a/b', 8, 12), 'medium')).toBe(12);
    expect(columnsAt(tile('a/b', 4), 'medium')).toBe(4);
    expect(columnsAt(tile('a/b', 4, 6), 'compact')).toBe(12);
  });
});
