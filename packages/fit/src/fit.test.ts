// SPDX-License-Identifier: AGPL-3.0-or-later

// The official Garmin FIT SDK is a devDependency of the tests only (ADR 0034): it checks ridrs'
// own encoder here and is never imported by source code.
import { CrcCalculator, Decoder, Profile, Stream } from '@garmin/fitsdk';
import type { RecordingEvent, RecordingHeader } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import {
  type ActivityModel,
  BASE_TYPES,
  buildActivity,
  ENUMS,
  encodeActivity,
  FIT_PROFILE_VERSION,
  fitCrc,
  fitTimestamp,
  MESSAGES,
} from './index.ts';

const T0 = Date.UTC(2026, 10, 1, 10, 0, 0, 0);

const header: RecordingHeader = {
  kind: 'header',
  format: 'ridrs.recording',
  formatVersion: 1,
  ridrsVersion: '0.1.0',
  sessionId: 's-1',
  startedAt: T0,
  timeZoneOffsetMinutes: 60,
  platform: { runtime: 'node', os: 'test', appVersion: '0.1.0' },
  prerollMs: 60_000,
};

let seq = 0;
function event(type: string, timestamp: number, payload: unknown, preroll = false): RecordingEvent {
  seq += 1;
  return {
    kind: 'event',
    seq,
    preroll,
    envelope: { id: `e${seq}`, type, source: 'test', timestamp, payload },
  };
}

function power(at: number, value: number | undefined, preroll = false): RecordingEvent {
  return event(
    'metric.power',
    at,
    value === undefined
      ? { status: 'unavailable', unit: 'W', reason: 'no-source', since: at }
      : {
          status: 'available',
          value,
          unit: 'W',
          deviceId: 'd',
          measuredAt: at,
          receivedAt: at,
        },
    preroll,
  );
}

function batch(at: number, step: number, speed: number, distance: number): RecordingEvent {
  return event('physics.state-batch', at, {
    sessionId: 's-1',
    samples: [{ step, at, speed, distance, acceleration: 0, gradient: 0 }],
  });
}

function decode(bytes: Uint8Array) {
  const decoder = new Decoder(Stream.fromByteArray([...bytes]));
  expect(Decoder.isFIT(Stream.fromByteArray([...bytes]))).toBe(true);
  expect(decoder.checkIntegrity()).toBe(true);
  const { messages, errors } = decoder.read();
  expect(errors).toEqual([]);
  return messages;
}

type ProfileField = {
  num: number;
  name: string;
  baseType: string;
  scale: number | number[];
  offset: number | number[];
};
type ProfileMessage = { num: number; name: string; fields: Record<string, ProfileField> };

describe('the FIT CRC-16', () => {
  it('equals the official SDK on any bytes', () => {
    const bytes = Uint8Array.from({ length: 257 }, (_, i) => (i * 37 + 11) & 0xff);
    for (const end of [0, 1, 12, 100, 257]) {
      expect(fitCrc(bytes, 0, end)).toBe(CrcCalculator.calculateCRC(bytes, 0, end));
    }
  });
});

describe('the FIT profile subset', () => {
  const messages = Profile.messages as unknown as Record<string, ProfileMessage>;

  it.each(Object.values(MESSAGES))(
    '$name has the profile number, fields, base types and scales',
    (message) => {
      const official = messages[message.num];
      expect(official?.name).toBe(message.name);
      for (const field of message.fields) {
        const officialField = official?.fields[field.num];
        expect(officialField?.name, `${message.name}.${field.name}`).toBe(field.name);
        expect(officialField?.baseType).toBe(field.type.name);
        // The profile gives a scale as a number, or as an array for fields with components.
        const scale = [officialField?.scale].flat()[0] ?? 1;
        expect(scale, `${message.name}.${field.name} scale`).toBe(
          'scale' in field ? field.scale : 1,
        );
        const offset = [officialField?.offset].flat()[0] ?? 0;
        expect(offset, `${message.name}.${field.name} offset`).toBe(
          'offset' in field ? field.offset : 0,
        );
      }
    },
  );

  it('uses the profile enum values', () => {
    const types = Profile.types as unknown as Record<string, Record<number, string>>;
    for (const [type, values] of Object.entries(ENUMS)) {
      for (const [name, value] of Object.entries(values)) {
        expect(types[type]?.[value], `${type}.${name}`).toBe(name);
      }
    }
  });

  it('implements the SDK profile version and base type invalid values', () => {
    expect(FIT_PROFILE_VERSION).toEqual({
      major: Profile.version.major,
      minor: Profile.version.minor,
    });
    expect(BASE_TYPES.uint8.invalid).toBe(0xff);
    expect(BASE_TYPES.uint16.invalid).toBe(0xffff);
    expect(BASE_TYPES.uint32.invalid).toBe(0xffffffff);
    expect(BASE_TYPES.sint32.invalid).toBe(0x7fffffff);
  });
});

describe('buildActivity', () => {
  it('puts a record at every whole second from the start, the end included', () => {
    const model = buildActivity({
      header: { ...header, startedAt: T0 + 300 },
      events: [],
      footer: {
        kind: 'footer',
        status: 'complete',
        endedAt: T0 + 3000,
        lastSeq: 0,
        counts: { events: 0, diagnostics: 0, byType: {} },
      },
    });
    expect(model.records.map((r) => r.at - T0)).toEqual([1000, 2000, 3000]);
  });

  it('takes the latest value at or before each record and never invents one', () => {
    const model = buildActivity({
      header,
      events: [
        power(T0 - 500, 999, true),
        power(T0 + 400, 150),
        power(T0 + 1000, 160),
        power(T0 + 1500, undefined),
        batch(T0, 0, 0, 0),
        batch(T0 + 1000, 100, 2, 1),
      ],
      footer: {
        kind: 'footer',
        status: 'complete',
        endedAt: T0 + 2000,
        lastSeq: 6,
        counts: { events: 6, diagnostics: 0, byType: {} },
      },
    });
    expect(model.records).toEqual([
      { at: T0, power: undefined, cadence: undefined, heartRate: undefined, speed: 0, distance: 0 },
      {
        at: T0 + 1000,
        power: 160,
        cadence: undefined,
        heartRate: undefined,
        speed: 2,
        distance: 1,
      },
      {
        at: T0 + 2000,
        power: undefined,
        cadence: undefined,
        heartRate: undefined,
        speed: 2,
        distance: 1,
      },
    ]);
    expect(model.summary.avgPower).toBe(160);
    expect(model.summary.avgSpeed).toBe(0.5);
  });
});

function position(
  at: number,
  distance: number,
  [latitude, longitude, altitude]: readonly [number, number, number?],
  preroll = false,
): RecordingEvent {
  const place = { distance, latitude, longitude, ...(altitude === undefined ? {} : { altitude }) };
  return event('world.position', at, place, preroll);
}

describe('buildActivity with a world position', () => {
  it('takes the latest position at or before each record, and none before the first', () => {
    const activity = buildActivity({
      header,
      events: [
        position(T0 - 500, 0, [44.1, 5.1, 400], true),
        position(T0 + 500, 1, [44.2, 5.2, 401.5]),
        position(T0 + 2000, 5, [44.3, 5.3]),
      ],
      footer: {
        kind: 'footer',
        status: 'complete',
        endedAt: T0 + 2000,
        lastSeq: 3,
        counts: { events: 3, diagnostics: 0, byType: {} },
      },
    });
    expect(
      activity.records.map(({ latitude, longitude, altitude }) => [latitude, longitude, altitude]),
    ).toEqual([
      [undefined, undefined, undefined],
      [44.2, 5.2, 401.5],
      [44.3, 5.3, undefined],
    ]);
  });

  it('has no position in a ride without a world', () => {
    const activity = buildActivity({ header, events: [batch(T0, 1, 5, 0)] });
    expect(activity.records[0]?.latitude).toBeUndefined();
  });
});

describe('encodeActivity', () => {
  const model: ActivityModel = {
    startedAt: T0,
    endedAt: T0 + 2000,
    timeZoneOffsetMinutes: 60,
    softwareVersion: '0.1.0',
    pauses: [],
    records: [
      { at: T0, power: 200, heartRate: 150, speed: 0, distance: 0 },
      {
        at: T0 + 1000,
        power: 201,
        speed: 1.2345,
        distance: 0.5,
        latitude: 44.660217,
        longitude: -5.420908,
        altitude: 498.13,
      },
      { at: T0 + 2000 },
    ],
    summary: {
      totalElapsedMs: 2000,
      totalTimerMs: 2000,
      totalDistance: 0.5,
      avgSpeed: 0.25,
      maxSpeed: 1.2345,
      avgPower: 200.5,
      maxPower: 201,
      avgHeartRate: 150,
      maxHeartRate: 150,
    },
  };

  it('gives the same bytes for the same model', () => {
    expect(encodeActivity(model)).toEqual(encodeActivity(structuredClone(model)));
  });

  it('writes a file the official SDK reads without errors', () => {
    const messages = decode(encodeActivity(model));
    expect(messages.fileIdMesgs).toHaveLength(1);
    expect(messages.recordMesgs).toHaveLength(3);
    expect(messages.sessionMesgs?.[0]?.avgPower).toBe(201);
    expect(messages.activityMesgs?.[0]?.localTimestamp).toBe(fitTimestamp(T0 + 2000) + 3600);
  });

  it('omits invalid values instead of writing zero', () => {
    const records = decode(encodeActivity(model)).recordMesgs ?? [];
    expect(records[1]?.heartRate).toBeUndefined();
    expect(records[1]?.speed).toBeCloseTo(1.235, 3);
    expect(records[2]?.power).toBeUndefined();
    expect(records[2]?.distance).toBeUndefined();
    expect(records[0]?.positionLat).toBeUndefined();
    expect(records[0]?.enhancedAltitude).toBeUndefined();
  });

  it('writes the position in semicircles and the altitude', () => {
    const record = (decode(encodeActivity(model)).recordMesgs ?? [])[1];
    const degrees = (semicircles: number | undefined) =>
      ((semicircles ?? Number.NaN) * 180) / 2 ** 31;
    expect(degrees(record?.positionLat)).toBeCloseTo(44.660217, 6);
    expect(degrees(record?.positionLong)).toBeCloseTo(-5.420908, 6);
    // FIT stores the altitude in steps of 0.2 m.
    expect(Math.abs((record?.enhancedAltitude ?? 0) - 498.13)).toBeLessThanOrEqual(0.1);
  });
});
