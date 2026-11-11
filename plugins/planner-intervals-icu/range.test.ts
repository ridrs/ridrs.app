// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { holds, isSpanFresh, KEPT_SPANS, mergeDays, spanDays, withSpan } from './range.ts';

const MINUTE = 60_000;

describe('isSpanFresh', () => {
  const spans = [{ oldest: '2026-11-30', newest: '2027-01-03', at: 0 }];
  it('is fresh inside a span read within the validity', () => {
    expect(isSpanFresh(spans, '2026-11-30', '2027-01-03', 14 * MINUTE, 15 * MINUTE)).toBe(true);
    expect(isSpanFresh(spans, '2026-12-07', '2026-12-13', 0, 15 * MINUTE)).toBe(true);
  });
  it('is stale after the validity, before the read, or beyond the span', () => {
    expect(isSpanFresh(spans, '2026-11-30', '2027-01-03', 15 * MINUTE, 15 * MINUTE)).toBe(false);
    expect(isSpanFresh(spans, '2026-11-30', '2027-01-03', -1, 15 * MINUTE)).toBe(false);
    expect(isSpanFresh(spans, '2026-11-29', '2027-01-03', 0, 15 * MINUTE)).toBe(false);
  });
});

describe('withSpan', () => {
  it('replaces the spans the new one covers and keeps the others', () => {
    const next = withSpan(
      [
        { oldest: '2026-12-07', newest: '2026-12-13', at: 1 },
        { oldest: '2026-10-26', newest: '2026-12-06', at: 2 },
      ],
      { oldest: '2026-11-30', newest: '2027-01-03', at: 3 },
    );
    expect(next).toEqual([
      { oldest: '2026-10-26', newest: '2026-12-06', at: 2 },
      { oldest: '2026-11-30', newest: '2027-01-03', at: 3 },
    ]);
  });
  it(`keeps the ${KEPT_SPANS} latest`, () => {
    let spans = withSpan([], { oldest: '2000-01-01', newest: '2000-01-01', at: 0 });
    for (let at = 1; at <= KEPT_SPANS; at++) {
      spans = withSpan(spans, { oldest: `2001-01-${String(at).padStart(2, '0')}`, newest: `2001-01-${String(at).padStart(2, '0')}`, at });
    }
    expect(spans).toHaveLength(KEPT_SPANS);
    expect(spans[0]?.at).toBe(1);
  });
});

describe('mergeDays', () => {
  const everything = () => true;
  it('replaces the days read and keeps the others, in date order', () => {
    const merged = mergeDays(
      [
        { date: '2026-11-02', id: 'a' },
        { date: '2026-12-10', id: 'b' },
      ],
      { oldest: '2026-11-30', newest: '2027-01-03' },
      [{ date: '2026-12-17', id: 'c' }],
      everything,
    );
    expect(merged.map((item) => item.id)).toEqual(['a', 'c']);
  });
  it('drops what no span holds any more', () => {
    const merged = mergeDays([{ date: '2026-01-01', id: 'old' }], { oldest: '2026-11-04', newest: '2026-11-17' }, [], (date) => date >= '2026-11-01');
    expect(merged).toEqual([]);
  });
});

describe('holds and spanDays', () => {
  it('holds the window and the spans', () => {
    const held = holds({ oldest: '2026-11-04', newest: '2026-11-17' }, [{ oldest: '2026-11-30', newest: '2027-01-03', at: 0 }]);
    expect(held('2026-11-10')).toBe(true);
    expect(held('2026-12-24')).toBe(true);
    expect(held('2026-11-20')).toBe(false);
  });
  it('counts the days of a span, across a change of the year', () => {
    expect(spanDays('2026-11-30', '2027-01-03')).toBe(35);
    expect(spanDays('2026-10-26', '2026-12-06')).toBe(42);
    expect(spanDays('2026-11-02', '2026-11-01')).toBe(0);
  });
});
