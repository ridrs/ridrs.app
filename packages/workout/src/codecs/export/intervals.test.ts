// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout, WorkoutStep } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { importIntervalsText } from '../text/index.ts';
import { exportIntervalsDoc, exportIntervalsText } from './index.ts';
import { intervalsTime } from './intervals-text.ts';

const workout = (steps: WorkoutStep[], extra: Partial<Workout> = {}): Workout => ({
  format: 'ridrs-workout',
  version: 1,
  id: 'w',
  name: 'W',
  sport: 'ride',
  source: { kind: 'user' },
  steps,
  ...extra,
});

const imported = (text: string): Workout => {
  const result = importIntervalsText(text, { id: 'w', fileName: 'w.txt' });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const [first] = result.workouts;
  if (!first) throw new Error('no workout');
  return first;
};

const codes = (diagnostics: readonly { code: string }[]) => diagnostics.map((d) => d.code);

describe('exportIntervalsText', () => {
  it('writes durations as intervals.icu does', () => {
    expect(intervalsTime(600)).toBe('10m');
    expect(intervalsTime(90)).toBe('1m30s');
    expect(intervalsTime(3725)).toBe('1h2m5s');
    expect(intervalsTime(3600)).toBe('1h');
    expect(intervalsTime(12.5)).toBe('12.5s');
    expect(intervalsTime(0)).toBe('0s');
  });

  it.each([
    ['watts and zones', '- 5m 200w\n- 5m 200-220w\n- 5m Z2\n- 5m Z2-Z3\n- 5m Z3 HR'],
    ['heart rate', '- 10m 80-85% LTHR\n- 10m 75% HR\n- 10m 140-150bpm'],
    [
      'ramps up and down, in watts and zones',
      '- 10m ramp 50-75%\n- 5m ramp 65-45%\n- 5m ramp 100-200w\n- 5m ramp Z1-Z3',
    ],
    [
      'cadence beside power and a free ride',
      '- 5m 90% 95-105rpm\n- 5m freeride 90rpm\n- 10s maxeffort',
    ],
    ['distances', '- 2km 75%\n- 500mtr 75%'],
    ['names, notes and intensity', '- Warm up 10m 60% intensity=warmup\n- 5m RPE 4 Keep it easy'],
    ['prompts', '- Seated 33^Stand up <!> 5m 75%'],
    [
      'blocks and sections',
      'Warmup\n- 10m 60%\n\nMain set 3x\n- 5m 105%\n- 3m 55%\n\n2x\n- 1m 120%\n- 1m 50%\n\n- 5m 50%',
    ],
    ['unknown targets kept as written', '- 5m 80% MMP 5m'],
  ])('round-trips %s through importIntervalsText', (_case, text) => {
    const first = imported(text);
    const exported = exportIntervalsText(first);
    expect(exported.diagnostics).toEqual([]);
    expect(imported(exported.text)).toEqual(first);
    expect(exportIntervalsText(imported(exported.text)).text).toBe(exported.text);
  });

  it('writes the canonical text of a workout from elsewhere', () => {
    const exported = exportIntervalsText(
      workout([
        {
          kind: 'interval',
          id: '1',
          intensity: 'warm-up',
          duration: { kind: 'time', seconds: 600 },
          effort: {
            kind: 'target',
            primary: {
              unit: 'watts',
              start: { low: 100, high: 100 },
              end: { low: 200, high: 200 },
            },
          },
        },
        {
          kind: 'repeat',
          id: '2',
          until: { kind: 'count', reps: 4 },
          steps: [
            {
              kind: 'interval',
              id: '2.1',
              duration: { kind: 'time', seconds: 240 },
              effort: {
                kind: 'target',
                primary: { unit: 'power-zone', start: { low: 5, high: 5 } },
                secondary: [{ unit: 'rpm', start: { low: 95, high: 105 } }],
              },
            },
            {
              kind: 'interval',
              id: '2.2',
              duration: { kind: 'time', seconds: 240 },
              effort: { kind: 'free' },
            },
          ],
        },
        {
          kind: 'interval',
          id: '3',
          duration: { kind: 'open' },
          effort: {
            kind: 'target',
            primary: { unit: 'percent-ftp', start: { low: 50, high: 50 } },
          },
        },
      ]),
    );
    expect(exported.text).toBe(
      '- 10m ramp 100-200w intensity=warmup\n\n4x\n- 4m Z5 95-105rpm\n- 4m freeride\n\n- press lap 50%',
    );
    expect(exported.diagnostics).toEqual([]);
  });

  it('warns where the syntax falls short', () => {
    const exported = exportIntervalsText(
      workout([
        {
          kind: 'interval',
          id: '1',
          name: 'Lost',
          intensity: 'other',
          duration: { kind: 'until', unit: 'bpm', comparison: 'below', value: 120 },
          effort: {
            kind: 'target',
            primary: {
              unit: 'percent-ftp',
              start: { low: 50, high: 60 },
              end: { low: 70, high: 80 },
              averaging: '3s',
            },
            secondary: [{ unit: 'rpm', start: { low: 80, high: 80 }, end: { low: 90, high: 90 } }],
          },
          cues: [{ offsetSeconds: 0, durationSeconds: 5, text: 'Go' }],
        },
        {
          kind: 'interval',
          id: '2',
          duration: { kind: 'time', seconds: 60 },
          effort: { kind: 'free', flatRoad: true },
        },
        {
          kind: 'repeat',
          id: '3',
          until: { kind: 'time', seconds: 600 },
          steps: [
            {
              kind: 'interval',
              id: '3.1',
              duration: { kind: 'time', seconds: 60 },
              effort: { kind: 'max-effort' },
            },
          ],
        },
      ]),
    );
    expect(exported.text).toBe(
      '- Go <!> press lap ramp 50-70% 80rpm\n- 1m freeride\n- 1m maxeffort',
    );
    expect(codes(exported.diagnostics)).toEqual([
      'name-with-cues',
      'cue-length-not-expressible',
      'duration-not-expressible',
      'averaging-not-expressible',
      'ramp-of-ranges',
      'ramp-not-expressible',
      'intensity-not-expressible',
      'flat-road-not-expressible',
      'repeat-not-expressible',
    ]);
  });
});

describe('exportIntervalsDoc', () => {
  it('writes ranges, ramps, zones, watts, cadence, heart rate and the kinds of step', () => {
    const exported = exportIntervalsDoc(
      imported(
        '- Warm up 10m ramp 50-75% intensity=warmup\n\nMain set 2x\n- 5m 200-220w 95rpm\n- 3m Z2\n\n- 2km Z2 HR\n- 5m 80-85% LTHR\n- 1m freeride\n- 10s maxeffort\n- 5m 75% intensity=rest',
      ),
    );
    expect(exported.doc).toEqual({
      steps: [
        {
          text: 'Warm up',
          duration: 600,
          warmup: true,
          ramp: true,
          power: { units: '%ftp', start: 50, end: 75 },
        },
        {
          text: 'Main set 2x',
          reps: 2,
          steps: [
            {
              duration: 300,
              power: { units: 'w', start: 200, end: 220 },
              cadence: { units: 'rpm', value: 95 },
            },
            { duration: 180, power: { units: 'power_zone', value: 2 } },
          ],
        },
        { distance: 2000, hr: { units: 'hr_zone', value: 2 } },
        { duration: 300, hr: { units: '%lthr', start: 80, end: 85 } },
        { duration: 60, freeride: true },
        { duration: 10, maxeffort: true },
        { duration: 300, intensity: 'rest', power: { units: '%ftp', value: 75 } },
      ],
    });
    expect(exported.diagnostics).toEqual([]);
  });

  it('warns where a document falls short', () => {
    const exported = exportIntervalsDoc(
      workout(
        [
          {
            kind: 'interval',
            id: '1',
            notes: 'n',
            duration: { kind: 'energy', kilocalories: 50 },
            effort: {
              kind: 'target',
              primary: { unit: 'rpe', start: { low: 5, high: 5 } },
              secondary: [
                { unit: 'watts', start: { low: 200, high: 200 } },
                { unit: 'watts', start: { low: 210, high: 210 } },
              ],
            },
            cues: [{ offsetSeconds: 0, text: 'Go' }],
          },
        ],
        { extensions: { intervals: { lines: [{ text: 'Warmup', before: '1' }] } } },
      ),
    );
    expect(exported.doc).toEqual({
      steps: [{ until_lap_press: true, power: { units: 'w', value: 200 } }],
    });
    expect(codes(exported.diagnostics)).toEqual([
      'text-lines-not-expressible',
      'duration-not-expressible',
      'notes-not-expressible',
      'cues-not-expressible',
      'target-not-expressible',
      'target-not-expressible',
    ]);
  });
});
