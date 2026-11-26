// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RideWorkout } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { parseRideName, type RideSummary, rideName, ridePath, summaryOfText } from './index.ts';

const T0 = Date.UTC(2026, 10, 24, 10, 29, 8, 647);
const SESSION = '295f70db9baaa0e0:activity-session:1795516148647:0';

const summary: RideSummary = {
  sessionId: SESSION,
  startedAt: T0,
  timeZoneOffsetMinutes: 60,
  durationSeconds: 5431,
  planned: { provider: 'intervals.icu', id: '146155281' },
  name: 'The One That Stays Controlled 🎚️',
};

describe('ride names (ADR 0111)', () => {
  it('sum up a ride: local start, session, duration, plan and name', () => {
    expect(rideName(summary)).toBe(
      'ride-20261124T112908.647+0100~295f70db9baaa0e0_activity-session_1795516148647_0~5431s' +
        '~intervals.icu=146155281~The One That Stays Controlled 🎚️',
    );
    expect(ridePath(summary)).toBe(`recordings/${rideName(summary)}.ridrs`);
  });

  it('read back what they were made from', () => {
    expect(parseRideName(ridePath(summary))).toEqual(summary);
    const plain: RideSummary = {
      sessionId: '0badc0de-0000-4000-8000-000000000000',
      startedAt: Date.UTC(2026, 10, 1, 9, 0, 0, 0),
      timeZoneOffsetMinutes: -330,
      name: 'Ride',
    };
    expect(rideName(plain)).toBe(
      'ride-20261101T033000.000-0530~0badc0de-0000-4000-8000-000000000000~-~-~Ride',
    );
    expect(parseRideName(`${rideName(plain)}.ridrs`)).toEqual(plain);
  });

  it('encode what a file system forbids, the escape and the separator, and keep the rest', () => {
    const odd: RideSummary = {
      ...summary,
      sessionId: 'a_b:c~d',
      planned: { provider: 'intervals', id: 'evt/7~x' },
      name: '2×20 / "hard": 50% ~ ok? ⏳',
    };
    const name = rideName(odd);
    expect(name).toContain('~a%5Fb_c%7Ed~');
    expect(name).toContain('~intervals=evt%2F7%7Ex~');
    expect(name.endsWith('~2×20 %2F %22hard%22%3A 50%25 %7E ok%3F ⏳')).toBe(true);
    expect(parseRideName(`${name}.ridrs`)).toEqual(odd);
  });

  it('cut a long workout name at a grapheme, within 100 bytes', () => {
    const long = { ...summary, name: `${'Sehr lange Einheit '.repeat(5)}🌬️🌬️🌬️` };
    const name = parseRideName(`${rideName(long)}.ridrs`)?.name ?? '';
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(100);
    expect(name.endsWith('…')).toBe(true);
    expect(long.name.startsWith(name.slice(0, -1))).toBe(true);
    expect(new TextEncoder().encode(`${rideName(long)}.ridrs`).length).toBeLessThanOrEqual(255);
  });

  it('are not the names of other files', () => {
    for (const file of [
      'recordings/ride-20261124T102908Z-295f70db.ridrs',
      'recordings/ride-20261124T102908Z-295f70db.ridrs.jsonl',
      `recordings/${rideName(summary)}.fit`,
      'recordings/ride-20261124T102908Z-screenshot_00.jpg',
      'recordings/ride-2026~x~1s~-~Ride.ridrs',
      'recordings/ride-20261124T112908.647+0100~s~12~-~Ride.ridrs',
      'recordings/ride-20261124T112908.647+0100~s~-~nothing~Ride.ridrs',
      'recordings/ride-20261124T112908.647+0100~s%G1~-~-~Ride.ridrs',
    ]) {
      expect(parseRideName(file), file).toBeUndefined();
    }
  });
});

const workout: RideWorkout = {
  workout: {
    format: 'ridrs-workout',
    version: 1,
    id: 'ss',
    name: 'Sweet Spot',
    sport: 'virtual-ride',
    source: { kind: 'user' },
    steps: [],
  },
  planned: { provider: 'intervals', id: 'evt-7' },
};

function text(states: readonly unknown[], footer = true): string {
  const lines = [
    {
      kind: 'header',
      format: 'ridrs.recording',
      formatVersion: 1,
      ridrsVersion: '0.1.0',
      sessionId: SESSION,
      startedAt: T0,
      timeZoneOffsetMinutes: 60,
      platform: { runtime: 'node', os: 'test', appVersion: '0.1.0' },
      prerollMs: 60_000,
    },
    { kind: 'snapshot', host: {}, sections: {} },
    ...states.map((payload, i) => ({
      kind: 'event',
      seq: i + 1,
      preroll: false,
      envelope: {
        id: `e${i}`,
        type: 'activity.state-changed',
        source: 'activity-session',
        timestamp: T0,
        payload,
      },
    })),
    {
      kind: 'event',
      seq: 99,
      preroll: false,
      envelope: {
        id: 'p',
        type: 'physics.state',
        source: 'physics-engine',
        timestamp: T0,
        payload: { note: 'activity.state-changed' },
      },
    },
    ...(footer
      ? [
          {
            kind: 'footer',
            status: 'complete',
            endedAt: T0 + 5_431_400,
            lastSeq: 99,
            counts: { events: 3, diagnostics: 0, byType: {} },
          },
        ]
      : []),
  ];
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

describe('the summary of a recording', () => {
  it("takes the header, the footer's end and the last workout of the activity states", () => {
    const running = { state: 'running', sessionId: SESSION, startedAt: T0, workout };
    expect(summaryOfText(text([{ state: 'idle' }, running, { state: 'idle' }]))).toEqual({
      sessionId: SESSION,
      startedAt: T0,
      timeZoneOffsetMinutes: 60,
      durationSeconds: 5431,
      planned: { provider: 'intervals', id: 'evt-7' },
      name: 'Sweet Spot',
    });
  });

  it('names a ride without a workout "Ride", and one without a footer has no duration', () => {
    const states = [
      { state: 'running', sessionId: SESSION, startedAt: T0 },
      { state: 'running', workout: 'broken' },
    ];
    expect(summaryOfText(text(states, false))).toEqual({
      sessionId: SESSION,
      startedAt: T0,
      timeZoneOffsetMinutes: 60,
      name: 'Ride',
    });
  });

  it('rejects a text that is no recording', () => {
    expect(() => summaryOfText('{"kind":"snapshot"}\n')).toThrow();
  });
});
