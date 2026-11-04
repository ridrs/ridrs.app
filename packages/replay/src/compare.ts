// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RecordedEnvelope } from '@ridrs/contracts';
import diff from 'microdiff';

/** One `(type, source)` stream of the ride, compared in order. */
export interface StreamComparison {
  readonly type: string;
  readonly source: string;
  readonly recorded: number;
  readonly replayed: number;
  /** Leading events that are equal in both; the index of the first difference if smaller. */
  readonly matched: number;
}

export interface Difference {
  readonly type: string;
  readonly source: string;
  /** Index in the stream. */
  readonly index: number;
  readonly timestamp: number;
  /** `timestamp`, `id`, a JSON path into the payload (e.g. `samples[1].speed`), or `` for a missing event. */
  readonly path: string;
  readonly recorded: unknown;
  readonly replayed: unknown;
}

/**
 * A replayed stream whose event type the recording never contained: a recording made before the
 * type existed cannot say what it should have been, so it is reported, not compared.
 */
export interface UncomparedStream {
  readonly type: string;
  readonly source: string;
  readonly replayed: number;
  readonly reason: 'not-in-recording';
}

export interface Comparison {
  /** Whether every compared stream is equal; `notCompared` lists what was left out. */
  readonly identical: boolean;
  /** Sorted by type, then source. */
  readonly streams: readonly StreamComparison[];
  /** Sorted by type, then source. */
  readonly notCompared: readonly UncomparedStream[];
  /** The difference with the earliest timestamp. */
  readonly firstDifference?: Difference;
}

export interface CompareOptions {
  /** The ride: only events with `from ≤ timestamp ≤ to` are compared. */
  readonly from: number;
  readonly to: number;
  /** Whether a stream takes part (inputs and lifecycle events do not). */
  readonly compared: (type: string, source: string) => boolean;
  /** Compare envelope ids too (they reproduce when both runs share the run id). */
  readonly ids?: boolean;
}

function pathOf(segments: readonly (string | number)[]): string {
  return segments
    .map((segment, i) =>
      typeof segment === 'number' ? `[${segment}]` : i === 0 ? segment : `.${segment}`,
    )
    .join('');
}

function differenceOf(
  type: string,
  source: string,
  index: number,
  recorded: RecordedEnvelope | undefined,
  replayed: RecordedEnvelope | undefined,
  ids: boolean,
): Difference | undefined {
  const timestamp = Math.min(
    recorded?.timestamp ?? Number.POSITIVE_INFINITY,
    replayed?.timestamp ?? Number.POSITIVE_INFINITY,
  );
  if (!recorded || !replayed) {
    return { type, source, index, timestamp, path: '', recorded, replayed };
  }
  if (recorded.timestamp !== replayed.timestamp) {
    return {
      type,
      source,
      index,
      timestamp,
      path: 'timestamp',
      recorded: recorded.timestamp,
      replayed: replayed.timestamp,
    };
  }
  const a = recorded.payload;
  const b = replayed.payload;
  const payloadDifference = payloadDifferenceOf(type, source, index, timestamp, a, b);
  if (payloadDifference || !ids || recorded.id === replayed.id) {
    return payloadDifference;
  }
  return {
    type,
    source,
    index,
    timestamp,
    path: 'id',
    recorded: recorded.id,
    replayed: replayed.id,
  };
}

function payloadDifferenceOf(
  type: string,
  source: string,
  index: number,
  timestamp: number,
  a: unknown,
  b: unknown,
): Difference | undefined {
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const [first] = diff(a as Record<string, unknown>, b as Record<string, unknown>);
    if (!first) {
      return undefined;
    }
    return {
      type,
      source,
      index,
      timestamp,
      path: pathOf(first.path),
      recorded: first.type === 'CREATE' ? undefined : first.oldValue,
      replayed: first.type === 'REMOVE' ? undefined : first.value,
    };
  }
  return Object.is(a, b)
    ? undefined
    : { type, source, index, timestamp, path: '', recorded: a, replayed: b };
}

function streamsOf(
  envelopes: readonly RecordedEnvelope[],
  options: CompareOptions,
): Map<string, RecordedEnvelope[]> {
  const streams = new Map<string, RecordedEnvelope[]>();
  for (const envelope of envelopes) {
    if (
      envelope.timestamp < options.from ||
      envelope.timestamp > options.to ||
      !options.compared(envelope.type, envelope.source)
    ) {
      continue;
    }
    const key = JSON.stringify([envelope.type, envelope.source]);
    const stream = streams.get(key) ?? [];
    stream.push(envelope);
    streams.set(key, stream);
  }
  return streams;
}

/**
 * Compares the ride's derived events per `(type, source)` stream, in order, with exact equality
 * of timestamp and payload (and envelope ids with `ids`). Streams of an event type that occurs
 * nowhere in the recording are listed in `notCompared` instead.
 */
export function compare(
  recorded: readonly RecordedEnvelope[],
  replayed: readonly RecordedEnvelope[],
  options: CompareOptions,
): Comparison {
  const left = streamsOf(recorded, options);
  const right = streamsOf(replayed, options);
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  const recordedTypes = new Set(recorded.map((envelope) => envelope.type));
  const streams: StreamComparison[] = [];
  const notCompared: UncomparedStream[] = [];
  let firstDifference: Difference | undefined;
  for (const key of keys) {
    const [type, source] = JSON.parse(key) as [string, string];
    const a = left.get(key) ?? [];
    const b = right.get(key) ?? [];
    if (!recordedTypes.has(type)) {
      notCompared.push({ type, source, replayed: b.length, reason: 'not-in-recording' });
      continue;
    }
    let matched = Math.max(a.length, b.length);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const difference = differenceOf(
        type,
        source,
        index,
        a[index],
        b[index],
        options.ids ?? false,
      );
      if (difference) {
        matched = index;
        if (!firstDifference || difference.timestamp < firstDifference.timestamp) {
          firstDifference = difference;
        }
        break;
      }
    }
    streams.push({ type, source, recorded: a.length, replayed: b.length, matched });
  }
  return { identical: firstDifference === undefined, streams, notCompared, firstDifference };
}
