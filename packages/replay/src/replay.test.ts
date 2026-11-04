// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RecordedEnvelope } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { compare } from './index.ts';

const T0 = Date.UTC(2026, 10, 1, 10, 0, 0, 0);

function envelope(
  type: string,
  source: string,
  timestamp: number,
  payload: unknown,
): RecordedEnvelope {
  return { id: `${type}@${timestamp}`, type, source, timestamp, payload };
}

const everything = { from: T0, to: T0 + 10_000, compared: () => true };

describe('compare', () => {
  it('is identical for equal streams, whatever the envelope ids and the interleaving', () => {
    const a = envelope('x', 'p', T0, { v: 1 });
    const b = envelope('y', 'q', T0, { v: 2 });
    const result = compare(
      [a, b],
      [
        { ...b, id: 'other' },
        { ...a, id: 'another' },
      ],
      everything,
    );
    expect(result).toEqual({
      identical: true,
      streams: [
        { type: 'x', source: 'p', recorded: 1, replayed: 1, matched: 1 },
        { type: 'y', source: 'q', recorded: 1, replayed: 1, matched: 1 },
      ],
      notCompared: [],
      firstDifference: undefined,
    });
  });

  it('names the JSON path of the first difference and the earliest one overall', () => {
    const recorded = [
      envelope('s', 'p', T0, { samples: [{ speed: 1 }, { speed: 2 }] }),
      envelope('t', 'p', T0 + 5, { v: 1 }),
    ];
    const replayed = [
      envelope('s', 'p', T0, { samples: [{ speed: 1 }, { speed: 3 }] }),
      envelope('t', 'p', T0 + 5, { v: 2 }),
    ];
    expect(compare(recorded, replayed, everything).firstDifference).toEqual({
      type: 's',
      source: 'p',
      index: 0,
      timestamp: T0,
      path: 'samples[1].speed',
      recorded: 2,
      replayed: 3,
    });
  });

  it('compares per stream in order, timestamps exactly, and counts missing events', () => {
    const recorded = [envelope('x', 'p', T0, { v: 1 }), envelope('x', 'p', T0 + 10, { v: 2 })];
    const late = compare(
      recorded,
      [recorded[0] as RecordedEnvelope, envelope('x', 'p', T0 + 11, { v: 2 })],
      everything,
    );
    expect(late.firstDifference).toMatchObject({
      index: 1,
      path: 'timestamp',
      recorded: T0 + 10,
      replayed: T0 + 11,
    });
    const missing = compare(recorded, [recorded[0] as RecordedEnvelope], everything);
    expect(missing.streams).toEqual([
      { type: 'x', source: 'p', recorded: 2, replayed: 1, matched: 1 },
    ]);
    expect(missing.firstDifference).toMatchObject({ index: 1, path: '', replayed: undefined });
  });

  it('leaves out events outside the ride and streams that are not compared', () => {
    const result = compare(
      [envelope('x', 'p', T0 - 1, { v: 1 }), envelope('core.host.started', 'core.host', T0, {})],
      [],
      { from: T0, to: T0 + 1, compared: (type) => !type.startsWith('core.') },
    );
    expect(result).toMatchObject({ identical: true, streams: [] });
  });

  it('lists, but does not compare, an event type the recording never contained', () => {
    const recorded = [envelope('x', 'p', T0, { v: 1 })];
    const replayed = [
      envelope('x', 'p', T0, { v: 1 }),
      envelope('new.type', 'w', T0, { v: 1 }),
      envelope('new.type', 'w', T0 + 5, { v: 2 }),
    ];
    expect(compare(recorded, replayed, everything)).toEqual({
      identical: true,
      streams: [{ type: 'x', source: 'p', recorded: 1, replayed: 1, matched: 1 }],
      notCompared: [{ type: 'new.type', source: 'w', replayed: 2, reason: 'not-in-recording' }],
      firstDifference: undefined,
    });
  });

  it('still compares a type the recording contains, from any source and outside the ride too', () => {
    // The recording holds an "x" only before the ride: the type is known, so a new "x" differs.
    const recorded = [envelope('x', 'p', T0 - 1, { v: 1 })];
    const result = compare(recorded, [envelope('x', 'q', T0, { v: 1 })], everything);
    expect(result.identical).toBe(false);
    expect(result.notCompared).toEqual([]);
    expect(result.firstDifference).toMatchObject({ type: 'x', source: 'q', recorded: undefined });
  });
});
