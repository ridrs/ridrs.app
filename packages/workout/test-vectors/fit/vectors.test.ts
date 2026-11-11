// SPDX-License-Identifier: AGPL-3.0-or-later

// The hand-written FIT vectors: every `*.fit` is exactly what its annotated `*.fit.hex` says.
// `WRITE_FIT_VECTORS=1 npx vitest run packages/workout/test-vectors/fit` writes them again.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleFitHex } from './assemble.ts';

const HERE = import.meta.dirname;
const SOURCES = readdirSync(HERE).filter((name) => name.endsWith('.fit.hex'));

describe('the hand-written FIT vectors', () => {
  it('has sources', () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(10);
  });

  it.each(SOURCES)('%s matches its .fit file', (source) => {
    const bytes = assembleFitHex(readFileSync(join(HERE, source), 'utf8'));
    const target = join(HERE, source.replace(/\.hex$/, ''));
    if (process.env.WRITE_FIT_VECTORS) {
      writeFileSync(target, bytes);
    }
    expect(new Uint8Array(readFileSync(target))).toEqual(bytes);
  });
});

describe('assembleFitHex', () => {
  it('writes integers in the chosen byte order, strings padded, and the header fields', () => {
    const bytes = assembleFitHex(`
      0e 10 u16:21218 {size} 2e 46 49 54 {hcrc}   # header
      u16:258 !be u16:258 u32:1 str4"ab" !le       # data
      {crc}`);
    expect([...bytes.subarray(0, 4)]).toEqual([0x0e, 0x10, 0xe2, 0x52]);
    expect([...bytes.subarray(4, 8)]).toEqual([12, 0, 0, 0]);
    expect([...bytes.subarray(14, 26)]).toEqual([2, 1, 1, 2, 0, 0, 0, 1, 0x61, 0x62, 0, 0]);
  });

  it('refuses an unknown token and a value too big for its type', () => {
    expect(() => assembleFitHex('zz')).toThrow(/Unknown token/);
    expect(() => assembleFitHex('u8:256')).toThrow(/does not fit/);
  });
});
