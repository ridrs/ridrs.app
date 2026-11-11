// SPDX-License-Identifier: AGPL-3.0-or-later

// The FIT workout importer on the hand-written vectors and on workouts made by the official
// Garmin FIT SDK at test time (a devDependency of the tests only, ADR 0034, 0084).
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Decoder, Encoder, Profile, Stream } from '@garmin/fitsdk';
import { workoutSchema } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { importFit } from './index.ts';

const VECTORS = resolve(import.meta.dirname, '../../../test-vectors/fit');

function vector(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(VECTORS, name)));
}

type Fields = Record<string, unknown>;

/** A workout file made by the SDK's encoder: raw values, as the profile stores them. */
function sdkWorkout(steps: readonly Fields[], workout: Fields = {}, fileType = 'workout') {
  const encoder = new Encoder();
  const write = (mesg: Fields) => encoder.writeMesg(mesg as never);
  write({ mesgNum: Profile.MesgNum.FILE_ID, type: fileType, manufacturer: 'development' });
  write({ mesgNum: Profile.MesgNum.WORKOUT, sport: 'cycling', wktName: 'Test', ...workout });
  for (const [messageIndex, step] of steps.entries()) {
    write({ mesgNum: Profile.MesgNum.WORKOUT_STEP, messageIndex, ...step });
  }
  return encoder.close();
}

const time = (seconds: number) => ({ durationType: 'time', durationValue: seconds * 1000 });

/** Reads a file with the SDK and writes the same messages again with the SDK's encoder. */
function sdkCopy(bytes: Uint8Array): Uint8Array {
  const encoder = new Encoder();
  const { errors } = new Decoder(Stream.fromByteArray([...bytes])).read({
    mesgListener: (num, mesg) => encoder.onMesg(num, mesg),
    fieldDescriptionListener: (key, id, description) =>
      encoder.addDeveloperField(key, id, description),
    expandSubFields: false,
    expandComponents: false,
    applyScaleAndOffset: false,
    convertTypesToStrings: false,
    convertDateTimesToDates: false,
    mergeHeartRates: false,
  });
  expect(errors).toEqual([]);
  return encoder.close();
}

describe('importFit on the hand-written vectors', () => {
  it('imports 5 × (4 min at 115 % with 95–105 rpm, 4 min at 50 %) as the model', () => {
    const result = importFit(vector('repeat-cadence.fit'), {
      fileName: 'repeat-cadence.fit',
      importedAt: '2026-11-11T10:00:00Z',
      originalHash: 'sha256-abc',
    });
    expect(result).toEqual({
      ok: true,
      diagnostics: [],
      workouts: [
        {
          format: 'ridrs-workout',
          version: 1,
          id: 'repeat-cadence',
          name: 'VO2max 5x4',
          sport: 'ride',
          subSport: 'indoor_cycling',
          source: {
            kind: 'imported',
            format: 'fit',
            fileName: 'repeat-cadence.fit',
            originalHash: 'sha256-abc',
            importedAt: '2026-11-11T10:00:00Z',
          },
          steps: [
            {
              kind: 'interval',
              id: '0',
              name: 'Warm up',
              intensity: 'warm-up',
              duration: { kind: 'time', seconds: 600 },
              effort: {
                kind: 'target',
                primary: { unit: 'percent-ftp', start: { low: 55, high: 65 } },
              },
            },
            {
              kind: 'repeat',
              id: '3',
              until: { kind: 'count', reps: 5 },
              steps: [
                {
                  kind: 'interval',
                  id: '1',
                  name: 'On',
                  intensity: 'interval',
                  duration: { kind: 'time', seconds: 240 },
                  effort: {
                    kind: 'target',
                    primary: { unit: 'percent-ftp', start: { low: 115, high: 115 } },
                    secondary: [{ unit: 'rpm', start: { low: 95, high: 105 } }],
                  },
                },
                {
                  kind: 'interval',
                  id: '2',
                  name: 'Off',
                  intensity: 'recovery',
                  duration: { kind: 'time', seconds: 240 },
                  effort: {
                    kind: 'target',
                    primary: { unit: 'percent-ftp', start: { low: 50, high: 50 } },
                  },
                },
              ],
            },
            {
              kind: 'interval',
              id: '4',
              name: 'Cool down',
              intensity: 'cool-down',
              duration: { kind: 'time', seconds: 600 },
              effort: { kind: 'free' },
            },
          ],
          extensions: {
            fit: {
              workout: { numValidSteps: 5 },
              messages: [
                {
                  num: 0,
                  fields: { type: 5, manufacturer: 255, timeCreated: 1_100_000_000 },
                },
              ],
            },
          },
        },
      ],
    });
  });

  it.each(
    readdirSync(VECTORS).filter(
      (name) =>
        name.endsWith('.fit') &&
        !['bad-crc.fit', 'truncated.fit', 'running.fit'].includes(name) &&
        !name.startsWith('activity'),
    ),
  )('imports %s as a valid workout, and its copy by the SDK the same', (name) => {
    const ours = importFit(vector(name));
    expect(ours.ok).toBe(true);
    if (!ours.ok) return;
    expect(workoutSchema.safeParse(ours.workouts[0]).success).toBe(true);
    // The SDK writes the same messages with its own definitions and byte order.
    const copy = importFit(sdkCopy(vector(name)));
    expect(copy.ok && copy.workouts[0]?.steps).toEqual(ours.workouts[0]?.steps);
  });

  it('keeps the developer data messages and the developer field of a step', () => {
    const result = importFit(vector('developer-fields.fit'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fit = result.workouts[0]?.extensions?.fit as { messages: Fields[] };
    expect(fit.messages[1]).toEqual({
      num: 207,
      // Fields the profile of @ridrs/fit does not name are kept by number.
      fields: {
        1: [
          0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
          0xff,
        ],
        3: 0,
      },
    });
    expect(fit.messages[2]).toEqual({
      num: 206,
      fields: { 0: 0, 1: 0, 2: 0x84, 3: 'target_feel' },
    });
    expect(result.workouts[0]?.steps[0]?.extensions).toEqual({
      fit: { developerFields: [{ developerDataIndex: 0, num: 0, bytes: '0700' }] },
    });
  });

  it('keeps a speed zone, which the model has no unit for, as FIT fields', () => {
    const result = importFit(vector('targets.fit'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const speedZone = result.workouts[0]?.steps[9];
    expect(speedZone).toMatchObject({
      effort: { kind: 'free' },
      extensions: { fit: { fields: { targetType: 0, targetValue: 4 } } },
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'unsupported-target', at: 'workout_step[9]' }),
    ]);
  });

  it('refuses activities, other sports and broken files with their reason', () => {
    const code = (name: string) => {
      const result = importFit(vector(name));
      return result.ok ? 'ok' : result.diagnostics[0]?.code;
    };
    expect(code('activity-compressed-timestamps.fit')).toBe('not-a-workout');
    expect(code('running.fit')).toBe('not-cycling');
    expect(code('bad-crc.fit')).toBe('bad-crc');
    expect(code('truncated.fit')).toBe('truncated');
    expect(importFit('<workout_file/>')).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'not-fit' }],
    });
  });
});

describe('importFit on workouts of the official SDK', () => {
  it('takes the id from the options, else the file name, else the workout name', () => {
    const bytes = sdkWorkout([time(60)], { wktName: 'Sweet Spot 3x12' });
    const id = (options: Parameters<typeof importFit>[1]) => {
      const result = importFit(bytes, options);
      return result.ok ? result.workouts[0]?.id : undefined;
    };
    expect(id({ id: 'mine', fileName: 'a.fit' })).toBe('mine');
    expect(id({ fileName: 'folder/My Workout.FIT' })).toBe('my-workout');
    expect(id({})).toBe('sweet-spot-3x12');
  });

  it('names a workout without a name after its file', () => {
    const result = importFit(sdkWorkout([time(60)], { wktName: undefined }), {
      fileName: 'Threshold.fit',
      sourceKind: 'builtin',
    });
    expect(result).toMatchObject({
      ok: true,
      workouts: [{ name: 'Threshold', source: { kind: 'builtin' } }],
    });
  });

  it('keeps the notes, the description and a sub sport it does not name', () => {
    const result = importFit(
      sdkWorkout([{ ...time(60), notes: 'Stay seated', targetType: 'open' }], {
        wktDescription: 'Easy',
        subSport: 'treadmill',
        capabilities: 0x20,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      workouts: [
        {
          description: 'Easy',
          steps: [{ notes: 'Stay seated', effort: { kind: 'free' } }],
          extensions: { fit: { workout: { subSport: 1, capabilities: 0x20 } } },
        },
      ],
    });
    expect(result.ok && result.workouts[0]?.subSport).toBeUndefined();
  });

  it('reads a workout without a sport as cycling, with a warning', () => {
    const result = importFit(sdkWorkout([time(60)], { sport: undefined }));
    expect(result).toMatchObject({ ok: true, diagnostics: [{ code: 'no-sport' }] });
  });

  it('refuses a workout file of another sport and a FIT file of another type', () => {
    expect(importFit(sdkWorkout([time(60)], { sport: 'generic' }))).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'not-cycling' }],
    });
    expect(importFit(sdkWorkout([time(60)], {}, 'course'))).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'not-a-workout' }],
    });
  });

  it('reads one bound of a custom target as an exact value, with a warning', () => {
    const result = importFit(
      sdkWorkout([
        { ...time(60), targetType: 'power', targetValue: 0, customTargetValueLow: 1200 },
      ]),
    );
    expect(result).toMatchObject({
      ok: true,
      diagnostics: [{ code: 'one-sided-target' }],
      workouts: [
        { steps: [{ effort: { primary: { unit: 'watts', start: { low: 200, high: 200 } } } }] },
      ],
    });
  });

  it('keeps the FIT duration type that the model does not tell apart', () => {
    const result = importFit(
      sdkWorkout([{ durationType: 'repetitionTime', durationValue: 30_000, targetType: 'open' }]),
    );
    expect(result).toMatchObject({
      ok: true,
      workouts: [
        {
          steps: [
            {
              duration: { kind: 'time', seconds: 30 },
              extensions: { fit: { fields: { durationType: 28 } } },
            },
          ],
        },
      ],
    });
  });

  it.each([
    [
      'a target low in % and high in watts',
      [
        {
          ...time(60),
          targetType: 'power',
          targetValue: 0,
          customTargetValueLow: 90,
          customTargetValueHigh: 1200,
        },
      ],
      'mixed-target-units',
    ],
    [
      'a TSS duration',
      [{ durationType: 'trainingPeaksTss', durationValue: 50 }],
      'unsupported-duration',
    ],
    ['a time step without its time', [{ durationType: 'time' }], 'missing-duration-value'],
    [
      'a repeat into the middle of a repeat',
      [
        time(60),
        time(60),
        { durationType: 'repeatUntilStepsCmplt', durationValue: 0, targetValue: 2 },
        { durationType: 'repeatUntilStepsCmplt', durationValue: 1, targetValue: 2 },
      ],
      'bad-repeat',
    ],
    [
      'a repeat forward',
      [{ durationType: 'repeatUntilStepsCmplt', durationValue: 3, targetValue: 2 }, time(60)],
      'bad-repeat',
    ],
    [
      'a repeat of 0 times',
      [time(60), { durationType: 'repeatUntilStepsCmplt', durationValue: 0, targetValue: 0 }],
      'bad-repeat',
    ],
    [
      'a TSS repeat',
      [
        time(60),
        { durationType: 'repeatUntilTrainingPeaksTss', durationValue: 0, targetValue: 50 },
      ],
      'unsupported-repeat',
    ],
  ])('refuses %s', (_name, steps, code) => {
    expect(importFit(sdkWorkout(steps))).toMatchObject({
      ok: false,
      diagnostics: [{ severity: 'error', code }],
    });
  });

  it('refuses two steps with the same message index', () => {
    const encoder = new Encoder();
    encoder.writeMesg({ mesgNum: Profile.MesgNum.FILE_ID, type: 'workout' } as never);
    encoder.writeMesg({ mesgNum: Profile.MesgNum.WORKOUT, sport: 'cycling' } as never);
    for (let i = 0; i < 2; i += 1) {
      encoder.writeMesg({
        mesgNum: Profile.MesgNum.WORKOUT_STEP,
        messageIndex: 0,
        ...time(60),
      } as never);
    }
    expect(importFit(encoder.close())).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'bad-step-index' }],
    });
  });
});
