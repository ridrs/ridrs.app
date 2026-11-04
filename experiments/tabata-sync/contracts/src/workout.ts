// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from 'zod';

const unit = z.number().min(0).max(1);

export const SpeechSegmentSchema = z.object({
  text: z.string(),
  startSec: z.number(),
  endSec: z.number(),
  confidence: unit,
  words: z
    .array(z.object({ text: z.string(), startSec: z.number(), endSec: z.number(), confidence: unit }))
    .optional(),
  classification: z.string().optional(),
});
export type SpeechSegment = z.infer<typeof SpeechSegmentSchema>;

export const CandidateEventTypeSchema = z.enum([
  'WorkoutStart',
  'WarmupStart',
  'WorkStart',
  'RecoveryStart',
  'CountdownStart',
  'IntervalEnd',
  'FinalIntervalStart',
  'WorkoutEnd',
  'CooldownStart',
]);
export type CandidateEventType = z.infer<typeof CandidateEventTypeSchema>;

/**
 * A boundary hypothesis from one detection source; the workout modeler makes the final decision.
 * `IntervalEnd` is a boundary whose direction (into work or into recovery) the source cannot tell.
 */
export const CandidateEventSchema = z.object({
  timeSec: z.number(),
  type: CandidateEventTypeSchema,
  source: z.string(),
  confidence: unit,
  /** One standard deviation of the source's timing error. */
  uncertaintySec: z.number().positive(),
  evidence: z.record(z.string(), z.unknown()),
  durationSec: z.number().nonnegative().optional(),
});
export type CandidateEvent = z.infer<typeof CandidateEventSchema>;

export const IntervalTypeSchema = z.enum(['warmup', 'work', 'recovery', 'cooldown', 'other']);
export type IntervalType = z.infer<typeof IntervalTypeSchema>;

export const DeviationSchema = z.object({
  /** Boundary time the global pattern predicts. */
  expectedSec: z.number(),
  actualSec: z.number(),
  reason: z.string(),
});
export type Deviation = z.infer<typeof DeviationSchema>;

export const WorkoutIntervalSchema = z.object({
  index: z.number().int().nonnegative(),
  type: IntervalTypeSchema,
  startSec: z.number(),
  endSec: z.number(),
  /** 1-based round number for work and recovery intervals. */
  round: z.number().int().positive().optional(),
  confidence: unit,
  startConfidence: unit,
  endConfidence: unit,
  /** Sources supporting the start boundary, e.g. `speech:go`, `library-cue`, `acoustic:volume_increase`. */
  evidence: z.array(z.string()),
  source: z.enum(['automatic', 'manual']),
  deviation: DeviationSchema.optional(),
});
export type WorkoutInterval = z.infer<typeof WorkoutIntervalSchema>;

/** Times are on the reference variant's timeline. */
export const WorkoutStructureSchema = z.object({
  pattern: z.object({
    cycleSec: z.number().positive().optional(),
    workSec: z.number().positive().optional(),
    recoverySec: z.number().positive().optional(),
    rounds: z.number().int().nonnegative(),
    /** True when the intervals follow one repeating work/recovery pattern. */
    regular: z.boolean(),
    /** Share of pattern boundaries backed by direct evidence. */
    support: unit,
  }),
  workoutStartSec: z.number().optional(),
  workoutEndSec: z.number().optional(),
  intervals: z.array(WorkoutIntervalSchema),
  confidence: unit,
});
export type WorkoutStructure = z.infer<typeof WorkoutStructureSchema>;

/**
 * A user correction, kept apart from automatic results. Times are reference-time seconds and
 * address boundaries by position (nearest within a tolerance), so they survive re-analysis.
 */
export const CorrectionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('move_boundary'), fromSec: z.number(), toSec: z.number() }),
  z.object({ action: z.literal('add_boundary'), atSec: z.number(), type: IntervalTypeSchema }),
  z.object({ action: z.literal('remove_boundary'), atSec: z.number() }),
  z.object({ action: z.literal('set_type'), atSec: z.number(), type: IntervalTypeSchema }),
  z.object({ action: z.literal('set_workout_range'), startSec: z.number(), endSec: z.number() }),
  z.object({ action: z.literal('mark_countdown'), atSec: z.number(), durationSec: z.number().positive() }),
  /** A complete labeling: replaces every boundary before it, automatic or manual. */
  z.object({
    action: z.literal('set_boundaries'),
    boundaries: z.array(z.object({ atSec: z.number().nonnegative(), type: IntervalTypeSchema })).min(1),
  }),
]);
export type Correction = z.infer<typeof CorrectionSchema>;

/** Piecewise-linear map from a variant's timeline to its reference variant's timeline. */
export const TimelineSegmentSchema = z.object({
  variantStartSec: z.number(),
  variantEndSec: z.number(),
  referenceStartSec: z.number(),
  speedRatio: z.number().positive(),
  confidence: unit,
});
export type TimelineSegment = z.infer<typeof TimelineSegmentSchema>;

export const TimelineMapSchema = z.object({ segments: z.array(TimelineSegmentSchema) });
export type TimelineMap = z.infer<typeof TimelineMapSchema>;
