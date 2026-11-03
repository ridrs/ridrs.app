// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EventEnvelope } from '@ridrs/contracts';
import { measurementPowerEvent } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildConfigSnapshot,
  fitPathFor,
  gunzip,
  gzip,
  parseRecording,
  RecordingWriter,
  readRecording,
  recordingName,
  recoverRecording,
  serializeEnvelope,
} from './index.ts';

const T0 = Date.UTC(2026, 10, 1, 10, 0, 0, 0);

function envelope(n: number, payload: unknown = { n }): EventEnvelope {
  return { id: `e${n}`, type: 'demo.thing', source: 'demo', timestamp: T0 + n, seq: n, payload };
}

function writeRide(events: number): { writer: RecordingWriter; lines: string[] } {
  const writer = new RecordingWriter();
  const lines = [
    writer.header({
      format: 'ridrs.recording',
      formatVersion: 1,
      ridrsVersion: '0.1.0',
      sessionId: '3f2a9c1d-0000-4000-8000-000000000000',
      startedAt: T0,
      timeZoneOffsetMinutes: 0,
      platform: { runtime: 'node', os: 'test', appVersion: '0.1.0' },
      prerollMs: 60_000,
    }),
    writer.snapshot({ host: {}, sections: {} }),
  ];
  for (let n = 1; n <= events; n += 1) {
    lines.push(writer.event(serializeEnvelope(envelope(n)), n === 1));
  }
  lines.push(writer.diagnostic({ code: 'malformed-packet', message: 'short' }, T0 + events));
  return { writer, lines };
}

describe('file names', () => {
  it('names a ride by its UTC start and session', () => {
    expect(recordingName(T0, '3f2a9c1d-1234')).toBe('ride-20261101T100000Z-3f2a9c1d');
    expect(fitPathFor('recordings/x.ridrs')).toBe('recordings/x.fit');
    expect(fitPathFor('recordings/x.ridrs.jsonl')).toBe('recordings/x.fit');
  });
});

describe('the writer', () => {
  it('numbers events and diagnostics with one seq and counts them for the footer', () => {
    const { writer, lines } = writeRide(3);
    lines.push(writer.footer('complete', T0 + 10));
    const recording = parseRecording(lines.join(''));
    expect(recording.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(recording.diagnostics.map((d) => d.seq)).toEqual([4]);
    expect(recording.events.map((e) => e.preroll)).toEqual([true, false, false]);
    expect(recording.footer).toMatchObject({
      status: 'complete',
      lastSeq: 4,
      counts: { events: 3, diagnostics: 1, byType: { 'demo.thing': 3 } },
    });
  });

  it('keeps the payload as observed, even if it changes later', () => {
    const payload = { n: 1 };
    const serialized = serializeEnvelope(envelope(1, payload));
    payload.n = 2;
    expect(JSON.parse(serialized.json).payload).toEqual({ n: 1 });
  });
});

describe('the reader', () => {
  it('reads gzip and plain recordings alike', async () => {
    const { writer, lines } = writeRide(2);
    lines.push(writer.footer('complete', T0 + 10));
    const bytes = new TextEncoder().encode(lines.join(''));
    const compressed = await gzip(bytes);
    expect(await gunzip(compressed)).toEqual(bytes);
    expect((await readRecording(compressed)).lines).toBe(6);
    expect((await readRecording(bytes)).lines).toBe(6);
  });

  it('ignores unknown record kinds and fields', () => {
    const { writer, lines } = writeRide(1);
    lines.push('{"kind":"marker","x":1}\n');
    lines.push(writer.footer('complete', T0 + 10).replace('}\n', ',"future":true}\n'));
    const recording = parseRecording(lines.join(''));
    expect(recording.ignoredKinds).toEqual({ marker: 1 });
    expect(recording.footer).toMatchObject({ future: true });
  });

  it('refuses newer format versions', () => {
    const { writer, lines } = writeRide(1);
    lines.push(writer.footer('complete', T0));
    lines[0] = lines[0]?.replace('"formatVersion":1', '"formatVersion":2') ?? '';
    expect(() => parseRecording(lines.join(''))).toThrowError(
      expect.objectContaining({ code: 'recording-unsupported-version' }),
    );
  });

  it('validates payloads of event types it knows', () => {
    const { writer, lines } = writeRide(0);
    lines.push(
      writer.event(
        serializeEnvelope({ ...envelope(1, { value: 'nope' }), type: 'measurement.power' }),
        false,
      ),
    );
    lines.push(writer.footer('complete', T0));
    const text = lines.join('');
    expect(() => parseRecording(text)).not.toThrow();
    expect(() => parseRecording(text, { events: [measurementPowerEvent] })).toThrowError(
      expect.objectContaining({ code: 'invalid-recording' }),
    );
  });

  it('needs a footer unless asked otherwise', () => {
    const text = writeRide(1).lines.join('');
    expect(() => parseRecording(text)).toThrowError(
      expect.objectContaining({ code: 'invalid-recording' }),
    );
    expect(parseRecording(text, { requireFooter: false }).footer).toBeUndefined();
  });
});

describe('recovery', () => {
  it('drops a torn last line and closes with a recovered footer at the last record', () => {
    const torn = `${writeRide(3).lines.join('')}{"kind":"event","seq":5,"pre`;
    const { recording, text } = recoverRecording(torn);
    expect(recording.footer).toEqual({
      kind: 'footer',
      status: 'recovered',
      endedAt: T0 + 3,
      lastSeq: 4,
      counts: { events: 3, diagnostics: 1, byType: { 'demo.thing': 3 } },
    });
    expect(text.endsWith('\n')).toBe(true);
    expect(parseRecording(text).lines).toBe(7);
  });

  it('keeps a file that already has its footer', () => {
    const { writer, lines } = writeRide(1);
    lines.push(writer.footer('complete', T0 + 5));
    expect(recoverRecording(lines.join('')).recording.footer?.status).toBe('complete');
  });

  it('cannot recover a file without its header', () => {
    expect(() => recoverRecording('{"kind":"head')).toThrowError(
      expect.objectContaining({ code: 'invalid-recording' }),
    );
  });
});

describe('the configuration snapshot', () => {
  it('sorts sections and records a failing provider as its error', () => {
    const failed: string[] = [];
    const host = {
      runId: 'r',
      platform: { ridrsVersion: '0.1.0', runtime: 'node', os: 'x', appVersion: '0.1.0' },
      plugins: [],
      disabledPlugins: [],
      resolution: {},
      coreDefaults: { temporal: {} },
    } as const;
    const snapshot = buildConfigSnapshot(
      host,
      [
        { section: 'b', snapshot: () => ({ v: 1 }) },
        {
          section: 'a',
          snapshot: () => {
            throw new Error('broken');
          },
        },
      ],
      (section) => failed.push(section),
    );
    expect(Object.keys(snapshot.sections)).toEqual(['a', 'b']);
    expect(snapshot.sections.a).toEqual({ error: 'broken' });
    expect(failed).toEqual(['a']);
  });
});
