// SPDX-License-Identifier: AGPL-3.0-or-later

// The official Garmin FIT SDK is a devDependency of the tests only (ADR 0034): it reads what
// ridrs' own encoder writes, as the decoder does.
import { createHash } from 'node:crypto';
import { Decoder, Stream } from '@garmin/fitsdk';
import { describe, expect, it } from 'vitest';
import {
  decodeFit,
  ENUMS,
  encodeActivity,
  encodeFitMessages,
  type FitWriteMessage,
} from './index.ts';

const fileId: FitWriteMessage = {
  message: 'fileId',
  values: { type: ENUMS.file.workout, manufacturer: ENUMS.manufacturer.development, product: 0 },
};

const sdk = (bytes: Uint8Array) => {
  const stream = Stream.fromByteArray([...bytes]);
  expect(Decoder.isFIT(stream)).toBe(true);
  const decoder = new Decoder(stream);
  expect(decoder.checkIntegrity()).toBe(true);
  return decoder.read();
};

describe('encodeFitMessages', () => {
  const messages: FitWriteMessage[] = [
    fileId,
    {
      message: 'workout',
      values: {
        sport: ENUMS.sport.cycling,
        capabilities: 32,
        numValidSteps: 2,
        wktName: 'Sweet spot ö',
      },
    },
    {
      message: 'workoutStep',
      values: {
        messageIndex: 0,
        wktStepName: 'Warm up',
        durationType: 0,
        durationValue: 600_000,
        intensity: 2,
      },
    },
    {
      message: 'workoutStep',
      values: { messageIndex: 1, durationType: 5, notes: 'Press lap', targetType: 2 },
    },
  ];

  it('writes strings and uint32z that the decoder and the official SDK read back', () => {
    const bytes = encodeFitMessages(messages);
    const decoded = decodeFit(bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.diagnostics).toEqual([]);
    const workout = decoded.messages.find((m) => m.num === 26);
    expect(workout?.fields[8]?.value).toBe('Sweet spot ö');
    expect(workout?.fields[5]?.value).toBe(32);
    expect(workout?.fields[5]?.baseType).toBe('uint32z');
    const steps = decoded.messages.filter((m) => m.num === 27);
    expect(steps.map((s) => s.fields[0]?.value)).toEqual(['Warm up', undefined]);
    expect(steps[1]?.fields[8]?.value).toBe('Press lap');

    const { messages: sdkMessages, errors } = sdk(bytes);
    expect(errors).toEqual([]);
    expect(sdkMessages.workoutMesgs?.[0]).toMatchObject({
      wktName: 'Sweet spot ö',
      capabilities: 'tcx',
    });
    expect(sdkMessages.workoutStepMesgs).toHaveLength(2);
  });

  it('does not write a uint32z of 0 (its invalid value) or a value out of range', () => {
    const bytes = encodeFitMessages([
      fileId,
      { message: 'workout', values: { sport: 2, capabilities: 0, poolLength: 1e12 } },
    ]);
    const decoded = decodeFit(bytes);
    if (!decoded.ok) throw new Error('not decodable');
    const workout = decoded.messages.find((m) => m.num === 26);
    expect(workout?.fields[5]).toBeUndefined();
    expect(workout?.fields[14]).toBeUndefined();
  });

  it('redefines a message type when its fields change, and only then', () => {
    const bytes = encodeFitMessages(messages);
    const definitions = [...bytes.slice(14)].filter(
      (b, i, all) => (b & 0xc0) === 0x40 && all[i + 1] === 0,
    );
    // file_id, workout, workout_step twice (the second step has other fields): 4 plausible hits
    expect(definitions.length).toBeGreaterThanOrEqual(4);
    const same = encodeFitMessages([
      fileId,
      messages[2] as FitWriteMessage,
      messages[2] as FitWriteMessage,
    ]);
    expect(decodeFit(same).ok).toBe(true);
    expect(same.length).toBeLessThan(
      encodeFitMessages([fileId, messages[2] as FitWriteMessage, messages[3] as FitWriteMessage])
        .length + 20,
    );
  });

  it('carries over fields the profile lacks, by number, and developer data', () => {
    const bytes = encodeFitMessages([
      fileId,
      { message: 'workout', values: { sport: 2, '99': 7, '98': 'odd', '97': -3 } },
      {
        message: 'workoutStep',
        values: { durationType: 5 },
        developerFields: [{ developerDataIndex: 0, num: 1, bytes: new Uint8Array([1, 2, 3, 4]) }],
      },
    ]);
    expect(bytes[1]).toBe(0x20);
    const decoded = decodeFit(bytes);
    if (!decoded.ok) throw new Error('not decodable');
    const workout = decoded.messages.find((m) => m.num === 26);
    expect(workout?.fields[99]?.value).toBe(7);
    expect(workout?.fields[98]?.value).toBe('odd');
    expect(workout?.fields[97]?.value).toBe(-3);
    const step = decoded.messages.find((m) => m.num === 27);
    expect([...(step?.developerFields[0]?.bytes ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it('gives the same bytes every time', () => {
    expect(encodeFitMessages(messages)).toEqual(encodeFitMessages(messages));
  });
});

describe('encodeActivity', () => {
  it('still writes the same bytes as before the workout encoder', () => {
    const t0 = Date.UTC(2026, 10, 1, 10, 0, 0, 0);
    const records = Array.from({ length: 20 }, (_, i) => ({
      at: t0 + i * 1000,
      power: 200 + i,
      heartRate: 120 + i,
      cadence: 90,
      speed: 8.3,
      distance: i * 8.3,
      latitude: 46.5,
      longitude: 8.1,
      altitude: 400 + i,
    }));
    const bytes = encodeActivity({
      startedAt: t0,
      endedAt: t0 + 19_000,
      timeZoneOffsetMinutes: 60,
      softwareVersion: '0.1.0',
      records,
      pauses: [{ from: t0 + 5500, to: t0 + 8500 }],
      summary: {
        totalElapsedMs: 19_000,
        totalTimerMs: 16_000,
        totalDistance: 150,
        avgSpeed: 8.3,
        maxSpeed: 9,
        avgPower: 210,
        maxPower: 219,
        avgCadence: 90,
        maxCadence: 90,
        avgHeartRate: 130,
        maxHeartRate: 139,
      },
    });
    // The digest of the file as the encoder wrote it before workouts were added.
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '619b0ba5e6538fef262b1b6d96406e4e6af488860bb10a8f46e9b8bfb3231dd5',
    );
  });
});
