// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { secondsOf, trackFacts } from './track-facts.ts';

/** `count` points 5 m apart northwards, 0.2 m up each, a second apart. */
function gpx(count: number, { times = true } = {}): string {
  const points = Array.from({ length: count }, (_, i) => {
    const time = times ? `<time>${new Date(Date.UTC(2022, 0, 1, 9, 0, i)).toISOString()}</time>` : '';
    return `<trkpt lat="${(44.66 + (i * 5) / 111_195).toFixed(6)}" lon="5.42"><ele>${(433 + i * 0.2).toFixed(1)}</ele>${time}</trkpt>`;
  });
  return `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>${points.join('')}</trkseg></trk></gpx>`;
}

describe('trackFacts', () => {
  it('measures the distance, climb and duration of a track', () => {
    const facts = trackFacts(gpx(61));
    expect(facts.distance).toBe(300);
    expect(facts.ascent).toBe(12);
    expect(facts.duration).toBe(60);
  });

  it('samples the profile evenly from the start to the end', () => {
    const { sparkline } = trackFacts(gpx(61));
    expect(sparkline).toHaveLength(640);
    expect(sparkline[0]).toBe(433);
    expect(sparkline.at(-1)).toBe(445);
  });

  it('has no duration without times', () => {
    expect(trackFacts(gpx(61, { times: false })).duration).toBeUndefined();
  });

  it('refuses a track of fewer than two points', () => {
    expect(() => trackFacts(gpx(1))).toThrow('fewer than two points');
  });
});

describe('secondsOf', () => {
  it('reads GPX times as s since 1970', () => {
    for (const time of ['2022-12-28T09:00:05Z', '2024-02-29T23:59:59.5Z', '1999-01-01T00:00:00+02:00', '2026-11-12T10:00:00-0130']) {
      expect(secondsOf(time)).toBe(Date.parse(time) / 1000);
    }
    expect(secondsOf('yesterday')).toBeNaN();
  });
});
