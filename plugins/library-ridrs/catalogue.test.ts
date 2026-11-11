// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogue } from './catalogue.ts';
import { canonicalText, convertSource } from './convert.ts';

const dir = resolve(import.meta.dirname, 'resources/workouts');
const read = (...path: string[]) => readFileSync(resolve(dir, ...path), 'utf8');
const sources = readdirSync(resolve(dir, 'sources'))
  .filter((file) => file.endsWith('.zwo'))
  .map((file) => file.slice(0, -'.zwo'.length));
const canonical = readdirSync(dir)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length));

describe('the built-in catalogue (ADR 0086)', () => {
  it('has a canonical file for every source and a source for every canonical file', () => {
    expect(canonical.sort()).toEqual(sources.sort());
  });

  it('lists every canonical file in the bundled modules', () => {
    expect(
      catalogue()
        .map((workout) => workout.id)
        .sort(),
    ).toEqual(canonical);
  });

  it.each(sources)('%s: valid, with author and licence, and equal to its conversion', (name) => {
    const meta = JSON.parse(read('sources', `${name}.meta.json`));
    const converted = convertSource(name, read('sources', `${name}.zwo`), meta);
    expect(converted.author).toBeTruthy();
    expect(converted.license).toBe('CC-BY-SA-4.0');
    expect(converted.source.kind).toBe('builtin');
    // A forgotten `pnpm workouts:convert` fails here.
    expect(read(`${name}.json`)).toBe(canonicalText(converted));
  });

  it('detects a stale canonical file: a changed source gives another file', () => {
    const name = 'sweet-spot-3x12';
    const meta = JSON.parse(read('sources', `${name}.meta.json`));
    const changed = read('sources', `${name}.zwo`).replace('OnPower="0.90"', 'OnPower="0.95"');
    expect(read(`${name}.json`)).not.toBe(canonicalText(convertSource(name, changed, meta)));
  });

  it('refuses a source whose meta lacks nothing valid: an unknown focus fails', () => {
    const name = 'sweet-spot-3x12';
    const meta = { ...JSON.parse(read('sources', `${name}.meta.json`)), focus: 'nope' };
    expect(() => convertSource(name, read('sources', `${name}.zwo`), meta)).toThrow();
  });
});
