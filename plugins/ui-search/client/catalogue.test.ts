// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { CATALOGUE, search } from './catalogue.ts';

const names = (query: string, kinds: Parameters<typeof search>[2] = []) =>
  search(CATALOGUE, query, kinds).map((result) => result.name);

describe('search', () => {
  it('finds routes, workouts and events by part of their name, ignoring case', () => {
    expect(names('SUN')).toEqual(['Sunday Club Race']);
    expect(names(' sweet ')).toEqual(['Sweet Spot 3×12']);
    expect(names('alp')).toEqual(['Alpine Loop']);
  });

  it('finds nothing without a query and keeps only the chosen kinds', () => {
    expect(names('  ')).toEqual([]);
    expect(names('r', ['event'])).toEqual(['Tuesday Tempo Ride', 'Sunday Club Race', 'Everest Challenge']);
  });
});
