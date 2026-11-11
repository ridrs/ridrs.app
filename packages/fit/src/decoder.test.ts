// SPDX-License-Identifier: AGPL-3.0-or-later

// ridrs' own FIT decoder against the official Garmin FIT SDK, a devDependency of the tests only
// (ADR 0034, 0084): files made by the SDK's encoder at test time, the hand-written vectors of
// packages/workout/test-vectors/fit and the activity files of ridrs' own encoder are read by both
// decoders and compared message by message.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Decoder, Encoder, Profile, Stream } from '@garmin/fitsdk';
import { describe, expect, it } from 'vitest';
import { type DecodedFitMessage, decodeFit, encodeActivity, fitCrc } from './index.ts';

const VECTORS = resolve(import.meta.dirname, '../../workout/test-vectors/fit');

function vector(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(VECTORS, name)));
}

type Plain = Record<string, unknown>;
type ProfileMessages = Record<number, { fields: Record<number, { name: string }> } | undefined>;
const PROFILE = Profile.messages as unknown as ProfileMessages;

/** The SDK's reading: raw values, no sub-fields, no components, unknown fields by number. */
function sdkRead(bytes: Uint8Array) {
  const messages: [number, Plain][] = [];
  const decoder = new Decoder(Stream.fromByteArray([...bytes]));
  const { errors } = decoder.read({
    mesgListener: (num, mesg) => messages.push([num, mesg as unknown as Plain]),
    expandSubFields: false,
    expandComponents: false,
    applyScaleAndOffset: false,
    convertTypesToStrings: false,
    convertDateTimesToDates: false,
    includeUnknownData: true,
    mergeHeartRates: false,
  });
  return { messages, errors };
}

/** Ours, in the SDK's shape: fields by the SDK profile's name, else by number. */
function sdkShape(message: DecodedFitMessage): [number, Plain] {
  const fields: Plain = {};
  for (const field of Object.values(message.fields)) {
    const name = PROFILE[message.num]?.fields[field.num]?.name ?? String(field.num);
    fields[name] = Array.isArray(field.value) ? [...field.value] : field.value;
  }
  return [message.num, fields];
}

/** The SDK's message without what it adds itself (developer values, field description keys). */
function withoutSdkExtras([num, mesg]: [number, Plain]): [number, Plain] {
  const { developerFields: _developer, key: _key, ...fields } = mesg;
  return [num, fields];
}

function expectSameAsSdk(bytes: Uint8Array) {
  const ours = decodeFit(bytes);
  expect(ours.ok, JSON.stringify(ours.diagnostics)).toBe(true);
  const sdk = sdkRead(bytes);
  expect(sdk.errors).toEqual([]);
  if (ours.ok) {
    expect(ours.messages.map(sdkShape)).toEqual(sdk.messages.map(withoutSdkExtras));
  }
  return ours;
}

/** A workout file made by the SDK's encoder at test time (never committed: its licence). */
function sdkWorkout(steps: readonly Plain[], workout: Plain = {}): Uint8Array {
  const encoder = new Encoder();
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: 'workout',
    manufacturer: 'development',
    product: 0,
    serialNumber: 1234,
    timeCreated: new Date(Date.UTC(2026, 10, 11)),
  } as never);
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.WORKOUT,
    sport: 'cycling',
    subSport: 'indoorCycling',
    numValidSteps: steps.length,
    wktName: 'SDK workout',
    ...workout,
  } as never);
  for (const [messageIndex, step] of steps.entries()) {
    encoder.writeMesg({ mesgNum: Profile.MesgNum.WORKOUT_STEP, messageIndex, ...step } as never);
  }
  return encoder.close();
}

describe('decodeFit on files of the official SDK', () => {
  it('reads a workout as the SDK does, message by message', () => {
    const bytes = sdkWorkout([
      {
        wktStepName: 'On',
        durationType: 'time',
        durationValue: 240_000,
        targetType: 'power',
        targetValue: 0,
        customTargetValueLow: 1250,
        customTargetValueHigh: 1270,
        intensity: 'interval',
        notes: 'Stay seated',
        secondaryTargetType: 'cadence',
        secondaryTargetValue: 0,
        secondaryCustomTargetValueLow: 95,
        secondaryCustomTargetValueHigh: 105,
      },
      { durationType: 'repeatUntilStepsCmplt', durationValue: 0, targetValue: 5 },
    ]);
    const decoded = expectSameAsSdk(bytes);
    if (!decoded.ok) return;
    const step = decoded.messages.find((message) => message.num === 27);
    expect(step?.name).toBe('workoutStep');
    expect(step?.fields[0]).toEqual({
      num: 0,
      name: 'wktStepName',
      baseType: 'string',
      value: 'On',
    });
    expect(step?.fields[5]?.value).toBe(1250);
    expect(decoded.header).toMatchObject({ headerSize: 14, profileVersion: 21218 });
  });

  it('reads a workout with a description and developer data as the SDK does', () => {
    const encoder = new Encoder();
    const developerDataIdMesg = {
      mesgNum: Profile.MesgNum.DEVELOPER_DATA_ID,
      applicationId: Array.from({ length: 16 }, (_, i) => i),
      developerDataIndex: 0,
    };
    const fieldDescriptionMesg = {
      mesgNum: Profile.MesgNum.FIELD_DESCRIPTION,
      developerDataIndex: 0,
      fieldDefinitionNumber: 1,
      fitBaseTypeId: 0x84,
      fieldName: 'feel',
    };
    encoder.writeMesg({ mesgNum: Profile.MesgNum.FILE_ID, type: 'workout' } as never);
    encoder.writeMesg(developerDataIdMesg as never);
    encoder.writeMesg(fieldDescriptionMesg as never);
    encoder.addDeveloperField(0, developerDataIdMesg as never, fieldDescriptionMesg as never);
    encoder.writeMesg({
      mesgNum: Profile.MesgNum.WORKOUT,
      sport: 'cycling',
      wktName: 'Developer',
      wktDescription: 'With a developer field',
      poolLength: 25, // m: the SDK encoder applies the scale of 100
    } as never);
    encoder.writeMesg({
      mesgNum: Profile.MesgNum.WORKOUT_STEP,
      messageIndex: 0,
      durationType: 'open',
      targetType: 'open',
      developerFields: { 0: 7 },
    } as never);
    const decoded = expectSameAsSdk(encoder.close());
    if (!decoded.ok) return;
    const workout = decoded.messages.find((message) => message.num === 26);
    expect(workout?.fields[14]).toMatchObject({ value: 2500, scaled: 25 });
    const step = decoded.messages.find((message) => message.num === 27);
    expect(step?.developerFields).toEqual([
      { developerDataIndex: 0, num: 1, bytes: Uint8Array.from([7, 0]) },
    ]);
  });
});

describe('decodeFit on the hand-written vectors', () => {
  const valid = readdirSync(VECTORS).filter(
    (name) =>
      name.endsWith('.fit') &&
      !['bad-crc.fit', 'truncated.fit', 'activity-compressed-timestamps.fit'].includes(name),
  );

  it.each(valid)('reads %s as the SDK does', (name) => {
    expectSameAsSdk(vector(name));
  });

  it('reads big-endian messages and a 12-byte header', () => {
    const decoded = expectSameAsSdk(vector('big-endian.fit'));
    if (!decoded.ok) return;
    expect(decoded.header.headerSize).toBe(12);
    const steps = decoded.messages.filter((message) => message.num === 27);
    expect(steps[0]?.fields[2]?.value).toBe(1_200_000);
    expect(steps[0]?.fields[5]?.value).toBe(1250);
  });

  it('keeps developer fields opaque', () => {
    const decoded = decodeFit(vector('developer-fields.fit'));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const step = decoded.messages.find((message) => message.num === 27);
    expect(step?.developerFields).toEqual([
      { developerDataIndex: 0, num: 0, bytes: Uint8Array.from([7, 0]) },
    ]);
    const id = decoded.messages.find((message) => message.num === 207);
    expect(id?.fields[1]?.value).toEqual([
      0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
      0xff,
    ]);
  });

  it('resolves compressed timestamps, rolling over every 32 s', () => {
    const bytes = vector('activity-compressed-timestamps.fit');
    const decoded = decodeFit(bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const records = decoded.messages.filter((message) => message.num === 20);
    expect(records.map((record) => record.fields[253]?.value)).toEqual([
      1_100_000_028, 1_100_000_030, 1_100_000_034, 1_100_000_037,
    ]);
    expect(records.map((record) => record.compressedTimestamp ?? false)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    // Invalid values are absent; an array keeps its invalid element as null.
    expect(records.map((record) => record.fields[3]?.value)).toEqual([150, 151, undefined, 152]);
    expect(records.map((record) => record.fields[7]?.value)).toEqual([200, 210, 220, undefined]);
    expect(records[0]?.fields[200]).toEqual({ num: 200, baseType: 'uint8', value: [1, 2, null] });
    // The SDK reads no compressed timestamps: the messages before the first one agree.
    const sdk = sdkRead(bytes);
    expect(String(sdk.errors[0])).toMatch(/compressed timestamp/);
    expect(decoded.messages.slice(0, 2).map(sdkShape)).toEqual(sdk.messages.map(withoutSdkExtras));
  });

  it('refuses a broken file CRC, as the SDK does', () => {
    const bytes = vector('bad-crc.fit');
    expect(decodeFit(bytes)).toMatchObject({
      ok: false,
      diagnostics: [{ severity: 'error', code: 'bad-crc', offset: 99 }],
    });
    expect(new Decoder(Stream.fromByteArray([...bytes])).checkIntegrity()).toBe(false);
  });

  it('refuses a truncated file, as the SDK does', () => {
    const bytes = vector('truncated.fit');
    expect(decodeFit(bytes)).toMatchObject({
      ok: false,
      diagnostics: [{ severity: 'error', code: 'truncated' }],
    });
    expect(new Decoder(Stream.fromByteArray([...bytes])).checkIntegrity()).toBe(false);
  });
});

describe('decodeFit on ridrs activity files', () => {
  it("reads ridrs' own encoder as the SDK does", () => {
    const T0 = Date.UTC(2026, 10, 1, 10);
    const bytes = encodeActivity({
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
          latitude: 44.6,
          longitude: -5.4,
        },
        { at: T0 + 2000 },
      ],
      summary: { totalElapsedMs: 2000, totalTimerMs: 2000, totalDistance: 0.5 },
    });
    const decoded = expectSameAsSdk(bytes);
    if (!decoded.ok) return;
    const record = decoded.messages.filter((message) => message.num === 20)[1];
    expect(record?.fields[6]).toMatchObject({ name: 'speed', value: 1235, scaled: 1.235 });
    expect(record?.fields[1]?.value).toBe(Math.round((-5.4 * 2 ** 31) / 180));
  });
});

describe('decodeFit diagnostics', () => {
  const good = vector('running.fit');

  it('refuses what is not FIT', () => {
    expect(decodeFit(new TextEncoder().encode('<workout_file/>'))).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'not-fit' }],
    });
    expect(decodeFit(new Uint8Array())).toMatchObject({ ok: false });
  });

  it('refuses a broken header CRC and accepts a header CRC of 0', () => {
    const broken = good.slice();
    broken[12] = (broken[12] ?? 0) ^ 0xff;
    expect(decodeFit(broken)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'bad-header-crc' }],
    });
    const unset = good.slice();
    unset[12] = 0;
    unset[13] = 0;
    const view = new DataView(unset.buffer);
    view.setUint16(unset.length - 2, fitCrc(unset, 0, unset.length - 2), true);
    expect(decodeFit(unset).ok).toBe(true);
  });

  it('refuses a data message without a definition', () => {
    const bytes = Uint8Array.from([...good.subarray(0, 14), 0x05, 0, 0]);
    new DataView(bytes.buffer).setUint32(4, 1, true);
    bytes.set([fitCrc(bytes, 0, 12) & 0xff, fitCrc(bytes, 0, 12) >> 8], 12);
    new DataView(bytes.buffer).setUint16(15, fitCrc(bytes, 0, 15), true);
    expect(decodeFit(bytes)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'undefined-local-type', offset: 14 }],
    });
  });

  it('warns about bytes after the file CRC', () => {
    const decoded = decodeFit(Uint8Array.from([...good, 1, 2, 3]));
    expect(decoded).toMatchObject({ ok: true, diagnostics: [{ code: 'trailing-data' }] });
  });
});
