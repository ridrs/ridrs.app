// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { greetingAt, msUntilNextHour } from './greeting.ts';

describe('greetingAt', () => {
  it.each([
    [0, 'Good evening'],
    [4, 'Good evening'],
    [5, 'Good morning'],
    [11, 'Good morning'],
    [12, 'Good afternoon'],
    [17, 'Good afternoon'],
    [18, 'Good evening'],
    [23, 'Good evening'],
  ])('%i h is "%s"', (hour, greeting) => {
    expect(greetingAt(hour)).toBe(greeting);
  });
});

describe('msUntilNextHour', () => {
  it('counts to the next full hour', () => {
    expect(msUntilNextHour(new Date(2026, 10, 5, 17, 59, 30))).toBe(30_000);
    expect(msUntilNextHour(new Date(2026, 10, 5, 23, 0, 0))).toBe(3_600_000);
  });
});
