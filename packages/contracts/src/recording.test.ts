// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as contracts from './index.ts';
import {
  assertAppFilePath,
  bytesToHex,
  type EventDefinition,
  hexToBytes,
  parseManifestJson,
  recordingRecordSchema,
} from './index.ts';
import { recordingJsonSchema } from './recording-json-schema.ts';

const T = 1_793_527_200_000;
const available = (unit: string) => ({
  status: 'available',
  value: 200.5,
  unit,
  deviceId: 'trainer-1',
  measuredAt: T,
  receivedAt: T + 1,
});
const temporal = {
  status: 'available',
  value: 200,
  at: T,
  quality: 'measured',
  sourceId: 'metric-power',
  sourceMeasuredAt: T,
};
const state = {
  sessionId: 's-1',
  step: 25,
  at: T + 250,
  speed: 1.0000000000000002,
  distance: 0.1,
  acceleration: -0.3333333333333333,
  mass: 85,
  riderPower: temporal,
  wheelPower: 200,
  driveForce: 200,
  resistance: { total: 3.3, contributions: [{ source: 'physics-aerodynamics', force: 0.2 }] },
  road: { gradient: 0.05, surface: 'gravel', origin: 'default' },
};

/** A valid payload for every event of the contracts: the recording stores them all verbatim. */
const SAMPLES: Record<string, unknown> = {
  'activity.start-requested': {},
  'activity.finish-requested': {},
  'activity.state-changed': { state: 'finished', sessionId: 's-1', startedAt: T, endedAt: T + 1 },
  'bridge.companions-changed': {
    companions: [{ companionId: 'c', name: 'Phone', address: '10.0.0.2:4711', paired: true }],
  },
  'bridge.connect-requested': {},
  'bridge.disconnect-requested': {},
  'bridge.forget-requested': {},
  'bridge.pair-requested': { address: '10.0.0.2:4711', code: '123456' },
  'bridge.pairing-offer': { uri: null },
  'bridge.state-changed': { state: 'disconnected', companionName: 'Phone', reason: 'by-ridrs' },
  'core.host.started': { startedPlugins: ['a', 'b'] },
  'core.ui-registry.changed': { revision: 3 },
  'device.connection-changed': {
    deviceId: 'sim-1',
    deviceName: 'SIM',
    kind: 'trainer',
    state: 'reconnecting',
    reason: 'lost',
    route: 'companion',
  },
  'device.candidates-changed': {
    kind: 'heart-rate',
    devices: [{ deviceId: 'sim-hr', deviceName: 'HRM', routes: ['local', 'companion'], rssi: -58 }],
  },
  'device.connect-requested': { kind: 'heart-rate', deviceId: 'sim-hr' },
  'device.forget-requested': { kind: 'heart-rate' },
  'device.discovery-requested': { active: true },
  'device.scan-changed': { kind: 'heart-rate', routes: ['local', 'companion'] },
  'controller.buttons-changed': { deviceId: 'sim-ride', buttons: ['a', 'shift-up-right'] },
  'device.status-changed': {
    devices: [
      {
        kind: 'trainer',
        deviceId: 'sim-1',
        deviceName: 'SIM',
        state: 'connected',
        route: 'local',
        candidates: [{ deviceId: 'sim-1', deviceName: 'SIM', routes: ['local'] }],
        scanning: ['local'],
      },
      { kind: 'heart-rate', deviceId: '', deviceName: '', state: 'searching' },
    ],
  },
  'device.raw-notification': {
    deviceId: 'sim-1',
    deviceName: 'SIM KICKR',
    serviceUuid: '1826',
    characteristicUuid: '2ad2',
    data: '44000000b400c800',
    receivedAt: T,
  },
  'export.fit-written': { sessionId: 's-1', file: 'recordings/a.fit', bytes: 10, records: 11 },
  'measurement.power': {
    deviceId: 'd',
    value: 200,
    measuredAt: T,
    receivedAt: T,
    timestampOrigin: 'receive',
  },
  'measurement.cadence': {
    deviceId: 'd',
    value: 90.5,
    measuredAt: T,
    receivedAt: T,
    timestampOrigin: 'device',
  },
  'measurement.heart-rate': {
    deviceId: 'd',
    value: 145,
    measuredAt: T,
    receivedAt: T,
    timestampOrigin: 'receive',
  },
  'metric.power': available('W'),
  'metric.cadence': { status: 'unavailable', unit: 'rpm', reason: 'stale', since: T },
  'metric.heart-rate': available('bpm'),
  'metric.power-heart-rate-ratio': available('W/bpm'),
  'physics.state': state,
  'physics.state-batch': {
    sessionId: 's-1',
    samples: [
      { step: 4, at: T + 40, speed: 0.1, distance: 0.002, acceleration: 2.5, gradient: 0 },
      { step: 5, at: T + 50, speed: 0.125, distance: 0.003, acceleration: 2.5, gradient: 0 },
    ],
  },
  'recording.completed': {
    sessionId: 's-1',
    file: 'recordings/a.ridrs',
    bytes: 1000,
    events: 42,
    distance: 41.94,
    durationMs: 10_000,
  },
  'recording.failed': { sessionId: 's-1', reason: 'disk full' },
  'ui.terrain-observed': {
    revision: 2,
    originDistance: 2999,
    spacing: 1,
    samples: [
      { gradient: 0.05, surface: 'asphalt' },
      { gradient: 0, surface: 'gravel' },
    ],
  },
  'world.terrain-preview': {
    revision: 3,
    originDistance: 1999,
    spacing: 1,
    // Without a surface (absent = asphalt) and with one.
    samples: [{ gradient: 0 }, { gradient: 0.05 }, { gradient: 0.05, surface: 'gravel' }],
  },
  'training.connect-requested': {},
  'training.disconnect-requested': {},
  'training.refresh-requested': {},
  'training.account-changed': { service: 'intervals.icu', state: 'connected', athleteName: 'Alex' },
  'training.plan-changed': {
    service: 'intervals.icu',
    fetchedAt: T,
    offline: false,
    athlete: { name: 'Alex', ftp: 250, weight: 72.5 },
    workouts: [
      {
        id: '90001',
        date: '2026-11-04',
        name: 'Sweet Spot',
        sport: 'ride',
        durationSeconds: 3600,
        trainingLoad: 70,
        // A ramp, and a repeat of two intervals.
        steps: [
          {
            kind: 'interval',
            durationSeconds: 600,
            phase: 'warm-up',
            power: { low: 50, high: 75, lowWatts: 125, highWatts: 188 },
          },
          {
            kind: 'repeat',
            reps: 3,
            steps: [
              { kind: 'interval', durationSeconds: 720, power: { low: 90, high: 90 } },
              { kind: 'interval', durationSeconds: 240, cadence: { low: 85, high: 95 } },
            ],
          },
        ],
      },
    ],
  },
};

const events = (Object.values(contracts) as unknown[]).filter(
  (value): value is EventDefinition =>
    typeof value === 'object' && value !== null && 'schema' in value && 'id' in value,
);

describe('event payloads are JSON without loss', () => {
  it('has a sample for every event of the contracts', () => {
    expect(events.map((e) => e.id).sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it.each(events.map((e) => [e.id, e] as const))('%s', (id, event) => {
    const payload = event.schema.parse(SAMPLES[id]);
    expect(event.schema.parse(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });
});

describe('hex', () => {
  it('round-trips bytes as lowercase hex', () => {
    const bytes = Uint8Array.of(0x44, 0x00, 0xb4, 0xff, 0x0a);
    expect(bytesToHex(bytes)).toBe('4400b4ff0a');
    expect(hexToBytes('4400B4ff0a')).toEqual(bytes);
    expect(bytesToHex(new Uint8Array())).toBe('');
  });

  it.each(['4', 'zz', '44 00'])('rejects "%s"', (hex) => {
    expect(() => hexToBytes(hex)).toThrow();
  });
});

describe('app file paths', () => {
  it.each(['recordings/a.ridrs', 'a', 'recordings/ride-20261101T100000Z-3f2a9c1d.fit'])(
    'accepts "%s"',
    (path) => {
      expect(assertAppFilePath(path)).toBe(path);
    },
  );

  it.each(['', '/abs', '../up', 'a/../b', 'a//b', './a', 'a/', 'C:/x', 'a\\b'])(
    'rejects "%s" as invalid-path',
    (path) => {
      expect(() => assertAppFilePath(path)).toThrowError(
        expect.objectContaining({ code: 'invalid-path' }),
      );
    },
  );
});

describe('manifest permissions', () => {
  const manifest = (permissions: unknown) =>
    JSON.stringify({
      id: 'recorder',
      name: 'Recorder',
      version: '1.0.0',
      types: ['recording'],
      provides: [],
      requires: [],
      entry: 'index.ts',
      permissions,
    });

  it('accepts observe-host', () => {
    expect(parseManifestJson(manifest(['observe-host'])).success).toBe(true);
  });

  it('rejects unknown permissions', () => {
    expect(parseManifestJson(manifest(['read-everything'])).success).toBe(false);
  });
});

describe('recording records', () => {
  const header = {
    kind: 'header',
    format: 'ridrs.recording',
    formatVersion: 1,
    ridrsVersion: '0.1.0',
    sessionId: 's-1',
    startedAt: T,
    timeZoneOffsetMinutes: 60,
    platform: { runtime: 'node', os: 'darwin', appVersion: '0.1.0' },
    prerollMs: 60_000,
  };

  it.each([
    header,
    { kind: 'snapshot', host: { plugins: [] }, sections: { 'physics-rider': { mass: 75 } } },
    {
      kind: 'event',
      seq: 1,
      preroll: true,
      envelope: { id: 'e', type: 'future.thing', source: 'x', timestamp: T, payload: [1] },
    },
    { kind: 'diagnostic', seq: 2, at: T, code: 'malformed-packet', message: 'short' },
    {
      kind: 'footer',
      status: 'recovered',
      endedAt: T,
      lastSeq: 2,
      counts: { events: 1, diagnostics: 1, byType: { 'future.thing': 1 } },
    },
  ])('accepts a $kind record', (record) => {
    expect(recordingRecordSchema.safeParse(record).success).toBe(true);
  });

  it('keeps unknown fields: readers ignore them, writers may add them', () => {
    const parsed = recordingRecordSchema.parse({ ...header, futureField: 1 });
    expect(parsed).toMatchObject({ futureField: 1 });
  });

  it('rejects records that break the format', () => {
    expect(recordingRecordSchema.safeParse({ ...header, format: 'other' }).success).toBe(false);
    expect(
      recordingRecordSchema.safeParse({ kind: 'event', seq: 0, preroll: false, envelope: {} })
        .success,
    ).toBe(false);
  });

  it('matches the checked-in JSON Schema (run scripts/generate-recording-schema.ts)', () => {
    const file = resolve(
      import.meta.dirname,
      '../../../docs/formats/ridrs-recording-v1.schema.json',
    );
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(recordingJsonSchema());
  });
});
