// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { athleteProfileSchema } from './athlete.ts';
import { defineUiCapability } from './ui-capabilities.ts';

/**
 * The canonical workout format `ridrs-workout`, model v2 (ADR 0081): everything ZWO, FIT, ERG,
 * MRC, TCX and intervals.icu can express. Three layers keep an import without loss: the typed
 * model (what ridrs shows, rides and edits), `extensions.<format>` (what the typed model has no
 * field for, restored by an export to the same format) and the original file, referenced by its
 * hash. Importing translates; it never converts units: watts stay watts, % FTP stays % FTP.
 * Format document: docs/formats/ridrs-workout-v1.md.
 */

export const WORKOUT_SOURCE_FORMATS = ['zwo', 'fit', 'erg', 'mrc', 'tcx', 'intervals'] as const;
export const workoutSourceFormatSchema = z.enum(WORKOUT_SOURCE_FORMATS);
export type WorkoutSourceFormat = z.infer<typeof workoutSourceFormatSchema>;

/**
 * What a source holds that the typed model has no field for, by the format it came from: JSON
 * data, opaque to every format but its own. An export to the same format restores it.
 */
export const workoutExtensionsSchema = z.partialRecord(workoutSourceFormatSchema, z.unknown());
export type WorkoutExtensions = z.infer<typeof workoutExtensionsSchema>;

export const WORKOUT_TARGET_UNITS = [
  // power
  'percent-ftp',
  'watts',
  /** The 1-based number of a power zone of the athlete profile. */
  'power-zone',
  // heart rate
  'percent-lthr',
  'percent-max-hr',
  'bpm',
  /** The 1-based number of a heart rate zone of the athlete profile. */
  'hr-zone',
  // cadence
  'rpm',
  // speed (FIT, TCX)
  'meters-per-second',
  'percent-threshold-speed',
  /** Perceived exertion, 1–10 (intervals.icu). */
  'rpe',
] as const;
export const workoutTargetUnitSchema = z.enum(WORKOUT_TARGET_UNITS);
export type WorkoutTargetUnit = z.infer<typeof workoutTargetUnitSchema>;

/** A range: "stay between". `low = high` is an exact value. */
export const workoutRangeSchema = z
  .object({ low: z.number().nonnegative(), high: z.number().nonnegative() })
  .strict();
export type WorkoutRange = z.infer<typeof workoutRangeSchema>;

/**
 * A target. A range is not a ramp: a steady target has `start` only; with `end` it is a ramp,
 * linear from `start` at the start of the step to `end` at its end.
 */
export const workoutTargetSchema = z
  .object({
    unit: workoutTargetUnitSchema,
    start: workoutRangeSchema,
    end: workoutRangeSchema.optional(),
    /** FIT `power_3s`, `_10s`, `_30s`, `_lap`: over what the target is meant. */
    averaging: z.enum(['3s', '10s', '30s', 'lap']).optional(),
  })
  .strict();
export type WorkoutTarget = z.infer<typeof workoutTargetSchema>;

export const workoutEffortSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('target'),
      primary: workoutTargetSchema,
      /** Further targets at the same time, e.g. cadence beside power. */
      secondary: z.array(workoutTargetSchema).optional(),
    })
    .strict(),
  z
    .object({
      /** No target the trainer holds (ZWO `FreeRide`). */
      kind: z.literal('free'),
      /** ZWO `FlatRoad`. */
      flatRoad: z.boolean().optional(),
      secondary: z.array(workoutTargetSchema).optional(),
    })
    .strict(),
  /** All out (ZWO `MaxEffort`). */
  z.object({ kind: z.literal('max-effort') }).strict(),
]);
export type WorkoutEffort = z.infer<typeof workoutEffortSchema>;

const comparisonSchema = z.enum(['above', 'below']);

export const workoutDurationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('time'), seconds: z.number().nonnegative() }).strict(),
  z.object({ kind: z.literal('distance'), meters: z.number().nonnegative() }).strict(),
  /** FIT calories. */
  z.object({ kind: z.literal('energy'), kilocalories: z.number().nonnegative() }).strict(),
  /** Until the lap button. */
  z.object({ kind: z.literal('open') }).strict(),
  /** Until a value is above or below a bound, e.g. FIT `hr_less_than`. */
  z
    .object({
      kind: z.literal('until'),
      unit: workoutTargetUnitSchema,
      comparison: comparisonSchema,
      value: z.number(),
    })
    .strict(),
]);
export type WorkoutDuration = z.infer<typeof workoutDurationSchema>;

/** The FIT intensity enum. */
export const WORKOUT_INTENSITIES = [
  'warm-up',
  'active',
  'interval',
  'rest',
  'recovery',
  'cool-down',
  'other',
] as const;
export const workoutIntensitySchema = z.enum(WORKOUT_INTENSITIES);
export type WorkoutIntensity = z.infer<typeof workoutIntensitySchema>;

/** A text shown during a step (ZWO `textevent`, MRC `[COURSE TEXT]`), from its start. */
export const workoutCueSchema = z
  .object({
    offsetSeconds: z.number().nonnegative(),
    durationSeconds: z.number().nonnegative().optional(),
    text: z.string(),
  })
  .strict();
export type WorkoutCue = z.infer<typeof workoutCueSchema>;

/** How a repeat ends: after a count, or like a FIT `repeat_until_*` step. */
export const workoutRepeatUntilSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('count'), reps: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('time'), seconds: z.number().nonnegative() }).strict(),
  z.object({ kind: z.literal('distance'), meters: z.number().nonnegative() }).strict(),
  z.object({ kind: z.literal('energy'), kilocalories: z.number().nonnegative() }).strict(),
  z
    .object({
      kind: z.literal('condition'),
      unit: workoutTargetUnitSchema,
      comparison: comparisonSchema,
      value: z.number(),
    })
    .strict(),
]);
export type WorkoutRepeatUntil = z.infer<typeof workoutRepeatUntilSchema>;

export interface WorkoutInterval {
  readonly kind: 'interval';
  /** Stable within the workout: the editor, the player and the sync refer to steps by it. */
  readonly id: string;
  /** FIT `wkt_step_name`, an intervals.icu section or step text. */
  readonly name?: string;
  /** FIT `notes`, TCX `Notes`. */
  readonly notes?: string;
  readonly intensity?: WorkoutIntensity;
  readonly duration: WorkoutDuration;
  readonly effort: WorkoutEffort;
  readonly cues?: readonly WorkoutCue[];
  readonly extensions?: WorkoutExtensions;
}

export interface WorkoutRepeat {
  readonly kind: 'repeat';
  readonly id: string;
  readonly until: WorkoutRepeatUntil;
  readonly steps: readonly WorkoutStep[];
  readonly extensions?: WorkoutExtensions;
}

export type WorkoutStep = WorkoutInterval | WorkoutRepeat;

export const workoutIntervalSchema = z
  .object({
    kind: z.literal('interval'),
    id: z.string().min(1),
    name: z.string().optional(),
    notes: z.string().optional(),
    intensity: workoutIntensitySchema.optional(),
    duration: workoutDurationSchema,
    effort: workoutEffortSchema,
    cues: z.array(workoutCueSchema).optional(),
    extensions: workoutExtensionsSchema.optional(),
  })
  .strict();

export const workoutStepSchema: z.ZodType<WorkoutStep> = z.lazy(() =>
  z.union([workoutIntervalSchema, workoutRepeatSchema]),
);

export const workoutRepeatSchema: z.ZodType<WorkoutRepeat> = z.lazy(() =>
  z
    .object({
      kind: z.literal('repeat'),
      id: z.string().min(1),
      until: workoutRepeatUntilSchema,
      steps: z.array(workoutStepSchema),
      extensions: workoutExtensionsSchema.optional(),
    })
    .strict(),
);

export const WORKOUT_FOCUSES = [
  'recovery',
  'endurance',
  'tempo',
  'sweet-spot',
  'threshold',
  'vo2max',
  'anaerobic',
  'sprint',
  'test',
] as const;

export const WORKOUT_SOURCE_KINDS = ['builtin', 'user', 'imported', 'provider'] as const;

/** Where a workout came from. */
export const workoutSourceSchema = z
  .object({
    kind: z.enum(WORKOUT_SOURCE_KINDS),
    format: workoutSourceFormatSchema.optional(),
    fileName: z.string().optional(),
    /** The hash of the original file's bytes, kept as an app file (provenance). */
    originalHash: z.string().optional(),
    /** ISO 8601. */
    importedAt: z.string().optional(),
  })
  .strict();
export type WorkoutSource = z.infer<typeof workoutSourceSchema>;

export const WORKOUT_FORMAT = 'ridrs-workout';
export const WORKOUT_FORMAT_VERSION = 1;

/** A cycling workout in the canonical format: a file of its own, or part of a library. */
export const workoutSchema = z
  .object({
    format: z.literal(WORKOUT_FORMAT),
    version: z.literal(WORKOUT_FORMAT_VERSION),
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    /** Cycling only: an import refuses other sports. */
    sport: z.enum(['ride', 'virtual-ride']),
    /** FIT `sub_sport`, e.g. `indoor_cycling`. */
    subSport: z.string().optional(),
    /** Required for built-in workouts, with `license`. */
    author: z.string().optional(),
    /** An SPDX identifier. */
    license: z.string().optional(),
    /** ZWO category, an intervals.icu folder. */
    category: z.string().optional(),
    subcategory: z.string().optional(),
    tags: z.array(z.string()).optional(),
    focus: z.enum(WORKOUT_FOCUSES).optional(),
    /** W, the `FTP=` of an ERG or MRC header: information only, nothing is converted with it. */
    referenceFtp: z.number().positive().optional(),
    /** What the source states about itself; ridrs derives its own values. */
    declared: z
      .object({
        durationSeconds: z.number().nonnegative().optional(),
        trainingLoad: z.number().nonnegative().optional(),
        intensityFactor: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    source: workoutSourceSchema,
    steps: z.array(workoutStepSchema),
    extensions: workoutExtensionsSchema.optional(),
  })
  .strict();
export type Workout = z.infer<typeof workoutSchema>;

/** How much the chart shows (ADR 0083, structured-workouts.md section 5.1). */
export const WORKOUT_CHART_VARIANTS = ['micro', 'mini', 'full', 'edit', 'hud'] as const;

/**
 * Draws a workout: `ui.workout-chart`, provided by `ui-workout-chart`. The athlete only colours
 * and labels (zones, watts beside %); nothing is converted. In the HUD, `progressSeconds` is read
 * from the bus by the consumer and only passed on.
 */
export const workoutChartCapability = defineUiCapability('ui.workout-chart', {
  input: z
    .object({
      workout: workoutSchema,
      athlete: athleteProfileSchema
        .pick({ ftp: true, lthr: true, maxHeartRate: true, powerZones: true, heartRateZones: true })
        .partial()
        .optional(),
      variant: z.enum(WORKOUT_CHART_VARIANTS),
      progressSeconds: z.number().nonnegative().optional(),
      /** The id of the step shown as selected. */
      selectedStep: z.string().optional(),
    })
    .strict(),
  output: {
    /** A step got the focus (`full`) or was selected (`edit`). */
    'step-focused': z.object({ stepId: z.string() }).strict(),
  },
});
