// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { describeSummary, durationText } from './describe.ts';
import { messages } from './i18n/index.ts';

const summary = {
  durationSeconds: 65 * 60,
  durationEstimated: false,
  mainIntervals: { count: 3, durationSeconds: 12 * 60, value: 90 },
};

describe('the description', () => {
  it('words the duration and the main set in English', () => {
    expect(describeSummary(summary, 'percent-ftp', messages.en)).toBe(
      '65 minutes, 3 intervals of 12 minutes at 90 %',
    );
  });

  it('words them in German', () => {
    expect(describeSummary(summary, 'percent-ftp', messages.de)).toBe(
      '65 Minuten, 3 Intervalle à 12 Minuten bei 90 %',
    );
  });

  it('says watts on a watt axis, and "about" for an estimated length', () => {
    expect(
      describeSummary({ ...summary, durationEstimated: true, mainIntervals: { count: 1, durationSeconds: 60, value: 212.4 } }, 'watts', messages.en),
    ).toBe('about 65 minutes, 1 interval of 1 minute at 212 W');
  });

  it('describes a workout without a main set by its duration only, and an empty one as such', () => {
    expect(describeSummary({ durationSeconds: 3600, durationEstimated: false }, 'percent-ftp', messages.en)).toBe('60 minutes');
    expect(describeSummary({ durationSeconds: 0, durationEstimated: false }, 'percent-ftp', messages.de)).toBe('Keine Schritte');
  });

  it('formats durations compactly', () => {
    expect([45, 600, 3600, 3900].map(durationText)).toEqual(['45 s', '10 min', '60 min', '65 min']);
  });
});
