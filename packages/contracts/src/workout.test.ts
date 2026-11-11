// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activityStartRequestedEvent } from './activity.ts';
import { athleteProfileSchema } from './athlete.ts';
import { filesSaveService } from './files.ts';
import { trainingLibraryRemoveService, trainingLibrarySaveService } from './training.ts';
import { uiManifestSectionSchema } from './ui.ts';
import { defineUiCapability } from './ui-capabilities.ts';
import {
  rideBriefingState,
  type Workout,
  workoutChartCapability,
  workoutEditorCapability,
  workoutExportCapability,
  workoutSchema,
} from './workout.ts';
import { workoutJsonSchema } from './workout-json-schema.ts';
import { workoutStepChangedEvent } from './workout-player.ts';

const sweetSpot: Workout = {
  format: 'ridrs-workout',
  version: 1,
  id: 'sweet-spot-3x12',
  name: 'Sweet Spot 3×12',
  sport: 'virtual-ride',
  author: 'ridrs',
  license: 'CC-BY-SA-4.0',
  focus: 'sweet-spot',
  source: { kind: 'builtin', format: 'zwo', fileName: 'sweet-spot-3x12.zwo' },
  steps: [
    {
      kind: 'interval',
      id: 'warm-up',
      intensity: 'warm-up',
      duration: { kind: 'time', seconds: 600 },
      effort: {
        kind: 'target',
        primary: { unit: 'percent-ftp', start: { low: 50, high: 50 }, end: { low: 75, high: 75 } },
      },
    },
    {
      kind: 'repeat',
      id: 'main',
      until: { kind: 'count', reps: 3 },
      steps: [
        {
          kind: 'interval',
          id: 'on',
          duration: { kind: 'time', seconds: 720 },
          effort: {
            kind: 'target',
            primary: { unit: 'watts', start: { low: 200, high: 220 }, averaging: '3s' },
            secondary: [{ unit: 'rpm', start: { low: 90, high: 95 } }],
          },
          cues: [{ offsetSeconds: 10, durationSeconds: 5, text: 'Settle in' }],
        },
        {
          kind: 'interval',
          id: 'off',
          intensity: 'recovery',
          duration: { kind: 'until', unit: 'bpm', comparison: 'below', value: 120 },
          effort: { kind: 'free', flatRoad: true },
          extensions: { zwo: { CadenceResting: 85 } },
        },
      ],
      extensions: { zwo: { element: 'IntervalsT' } },
    },
    { kind: 'interval', id: 'lap', duration: { kind: 'open' }, effort: { kind: 'max-effort' } },
  ],
};

describe('the canonical workout format', () => {
  it('holds ramps, ranges, repeats, cues, open and until durations and extensions', () => {
    expect(workoutSchema.parse(sweetSpot)).toEqual(sweetSpot);
  });

  it('refuses another sport, an unknown unit and an unknown field', () => {
    expect(workoutSchema.safeParse({ ...sweetSpot, sport: 'run' }).success).toBe(false);
    expect(
      workoutSchema.safeParse({
        ...sweetSpot,
        steps: [
          {
            kind: 'interval',
            id: 'x',
            duration: { kind: 'time', seconds: 60 },
            effort: { kind: 'target', primary: { unit: 'furlongs', start: { low: 1, high: 1 } } },
          },
        ],
      }).success,
    ).toBe(false);
    expect(workoutSchema.safeParse({ ...sweetSpot, power: 1 }).success).toBe(false);
  });

  it('refuses extensions of a format ridrs does not import', () => {
    expect(workoutSchema.safeParse({ ...sweetSpot, extensions: { plan: {} } }).success).toBe(false);
  });

  it('matches the JSON Schema in docs/formats', () => {
    const file = resolve(import.meta.dirname, '../../../docs/formats/ridrs-workout-v1.schema.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(workoutJsonSchema());
  });
});

describe('zones in the athlete profile', () => {
  it('takes rising upper bounds with an open last zone', () => {
    const powerZones = [55, 75, 90, 105, 120, 150].map((upTo) => ({ upTo }));
    const profile = { ftp: 250, powerZones: [...powerZones, { name: 'Neuromuscular' }] };
    expect(athleteProfileSchema.parse(profile)).toEqual(profile);
  });

  it('refuses falling bounds, an open zone before the last, and more than ten zones', () => {
    const parse = (powerZones: unknown) => athleteProfileSchema.safeParse({ powerZones }).success;
    expect(parse([{ upTo: 75 }, { upTo: 55 }, {}])).toBe(false);
    expect(parse([{}, { upTo: 55 }])).toBe(false);
    expect(parse(Array.from({ length: 11 }, (_, i) => ({ upTo: i + 1 })))).toBe(false);
  });
});

describe('UI capabilities', () => {
  it('are dotted ids starting with "ui."', () => {
    expect(() => defineUiCapability('chart.workout', { input: z.object({}) })).toThrow(/ui\./);
    expect(defineUiCapability('ui.thing', { input: z.object({}) }).output).toEqual({});
  });

  it('check the input of the workout chart', () => {
    const input = { workout: sweetSpot, variant: 'mini', athlete: { ftp: 250 } };
    expect(workoutChartCapability.input.parse(input)).toEqual(input);
    expect(workoutChartCapability.input.safeParse({ ...input, variant: 'huge' }).success).toBe(
      false,
    );
    expect(workoutChartCapability.output['step-focused'].parse({ stepId: 'on' })).toEqual({
      stepId: 'on',
    });
  });

  it('are provided and used as the manifest declares, each provided once', () => {
    const ui = uiManifestSectionSchema.parse({
      client: 'client/index.tsx',
      provides: [{ capability: 'ui.workout-chart', export: 'WorkoutChart' }],
      uses: ['ui.route-profile'],
    });
    expect(ui.provides).toEqual([{ capability: 'ui.workout-chart', export: 'WorkoutChart' }]);
    expect(ui.uses).toEqual(['ui.route-profile']);
    const twice = { capability: 'ui.workout-chart', export: 'A' };
    expect(
      uiManifestSectionSchema.safeParse({ client: 'c.ts', provides: [twice, twice] }).success,
    ).toBe(false);
    expect(uiManifestSectionSchema.safeParse({ provides: [twice] }).success).toBe(false);
    expect(
      uiManifestSectionSchema.safeParse({
        client: 'c.ts',
        provides: [{ capability: 'workout-chart', export: 'A' }],
      }).success,
    ).toBe(false);
  });
});

describe('the editor and the writable library', () => {
  it('opens the editor for a new workout, an own one or a copy', () => {
    const parse = (input: unknown) => workoutEditorCapability.input.safeParse(input).success;
    expect(parse({ kind: 'new' })).toBe(true);
    expect(parse({ kind: 'copy', from: 'ridrs', workoutId: 'sweet-spot-3x12' })).toBe(true);
    expect(parse({ kind: 'edit', from: 'ridrs' })).toBe(false);
  });

  it('saves a workout with its original file and removes one by id', () => {
    const save = trainingLibrarySaveService.request.safeParse({
      key: 'ridrs',
      workout: sweetSpot,
      original: { fileName: 'sweet-spot.zwo', data: 'PHdvcmtvdXRfZmlsZS8+' },
    });
    expect(save.success).toBe(true);
    expect(trainingLibrarySaveService.id).toBe('training.library.save');
    expect(
      trainingLibraryRemoveService.request.safeParse({ key: 'ridrs', workoutId: 'x' }).success,
    ).toBe(true);
  });
});

describe('the export', () => {
  it('opens for a library workout and saves through files.save', () => {
    expect(workoutExportCapability.input.safeParse({ from: 'ridrs', workoutId: 'w' }).success).toBe(
      true,
    );
    expect(
      filesSaveService.request.safeParse({
        fileName: 'w.zwo',
        mediaType: 'application/xml',
        data: '',
      }).success,
    ).toBe(true);
  });
});

describe('the workout of a ride', () => {
  it('enters the ride whole, with where it came from', () => {
    const payload = {
      workout: { workout: sweetSpot, planned: { provider: 'intervals.icu', id: '42' } },
    };
    expect(activityStartRequestedEvent.schema.parse(payload)).toEqual(payload);
    expect(
      workoutStepChangedEvent.schema.safeParse({ stepId: 'on', index: 2, startedAt: 1 }).success,
    ).toBe(true);
  });

  it('keeps the briefing as a draft by its last choice', () => {
    expect(
      rideBriefingState.schema.safeParse({
        workout: { kind: 'library', from: 'ridrs', workoutId: 'sweet-spot-3x12' },
        bicycle: 'Road',
      }).success,
    ).toBe(true);
  });
});
