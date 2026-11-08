// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineState } from './app-state.ts';
import { defineDataType, providerIdSchema } from './data-sources.ts';
import { defineService } from './services.ts';

/**
 * The rider's planning services (ADR 0048): their account, their uploads and the planned workouts
 * of the calendar. Named after the domain, not the service: `service` says where the data came
 * from. No payload ever carries a token.
 */

/** A planning service is a provider (ADR 0075): its id is a provider id. */
export const trainingServiceSchema = providerIdSchema;
export type TrainingService = z.infer<typeof trainingServiceSchema>;

export const TRAINING_UPLOAD_STATES = ['uploading', 'uploaded', 'failed'] as const;

export const TRAINING_UPLOAD_REASONS = [
  /** No account is connected. */
  'not-connected',
  /** The token was rejected (401 or 403); the account asks to connect again. */
  'token-rejected',
  'unreachable',
  /** The service answered with an error; the file stays on this device. */
  'rejected',
] as const;

export const trainingUploadSchema = z
  .object({
    service: trainingServiceSchema,
    sessionId: z.string().min(1),
    state: z.enum(TRAINING_UPLOAD_STATES),
    reason: z.enum(TRAINING_UPLOAD_REASONS).optional(),
  })
  .strict();
export type TrainingUpload = z.infer<typeof trainingUploadSchema>;

/** How the upload of a ride goes, by its session id (ADR 0068). */
export const trainingUploadState = defineState('training.upload', trainingUploadSchema);

export const TRAINING_ACCOUNT_STATES = [
  'disconnected',
  'connecting',
  'connected',
  'failed',
] as const;

export const TRAINING_ACCOUNT_REASONS = [
  'sign-in-cancelled',
  'sign-in-rejected',
  'token-rejected',
  'unreachable',
] as const;

export const trainingAccountSchema = z
  .object({
    service: trainingServiceSchema,
    state: z.enum(TRAINING_ACCOUNT_STATES),
    athleteName: z.string().optional(),
    reason: z.enum(TRAINING_ACCOUNT_REASONS).optional(),
  })
  .strict();
export type TrainingAccount = z.infer<typeof trainingAccountSchema>;

/** The rider's account of each planning service, by the service (`intervals.icu`; ADR 0068). */
export const trainingAccountState = defineState('training.account', trainingAccountSchema);

/** A power target in % FTP; a fixed target has `low = high`, a ramp goes from `low` to `high`. */
export const workoutPowerSchema = z
  .object({
    low: z.number().nonnegative(),
    high: z.number().nonnegative(),
    /** Only when the athlete has an FTP. */
    lowWatts: z.number().int().nonnegative().optional(),
    highWatts: z.number().int().nonnegative().optional(),
  })
  .strict();
export type WorkoutPower = z.infer<typeof workoutPowerSchema>;

export interface WorkoutInterval {
  readonly kind: 'interval';
  readonly durationSeconds: number;
  readonly phase?: 'warm-up' | 'cool-down';
  readonly text?: string;
  readonly power?: WorkoutPower;
  /** rpm, a range when `low ≠ high`. */
  readonly cadence?: { readonly low: number; readonly high: number };
}

export interface WorkoutRepeat {
  readonly kind: 'repeat';
  readonly reps: number;
  readonly steps: readonly WorkoutStep[];
}

export type WorkoutStep = WorkoutInterval | WorkoutRepeat;

const workoutIntervalSchema = z
  .object({
    kind: z.literal('interval'),
    durationSeconds: z.number().nonnegative(),
    phase: z.enum(['warm-up', 'cool-down']).optional(),
    text: z.string().optional(),
    power: workoutPowerSchema.optional(),
    cadence: z.object({ low: z.number(), high: z.number() }).strict().optional(),
  })
  .strict();

export const workoutStepSchema: z.ZodType<WorkoutStep> = z.lazy(() =>
  z.union([
    workoutIntervalSchema,
    z
      .object({
        kind: z.literal('repeat'),
        reps: z.number().int().positive(),
        steps: z.array(workoutStepSchema),
      })
      .strict(),
  ]),
);

export const plannedWorkoutSchema = z
  .object({
    id: z.string().min(1),
    /** The rider's local date, `YYYY-MM-DD`. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    name: z.string(),
    sport: z.enum(['ride', 'virtual-ride']),
    description: z.string().optional(),
    durationSeconds: z.number().nonnegative().optional(),
    trainingLoad: z.number().nonnegative().optional(),
    /** Empty when the service has no structure for the workout. */
    steps: z.array(workoutStepSchema),
  })
  .strict();
export type PlannedWorkout = z.infer<typeof plannedWorkoutSchema>;

/**
 * The planned workouts of a provider (ADR 0075): the data type `training.calendar`, keyed by the
 * provider. The athlete of a service is its `athlete.profile`, not part of the calendar.
 */
export const trainingCalendarSchema = z
  .object({
    /** Planned cycling workouts in date order. */
    workouts: z.array(plannedWorkoutSchema),
  })
  .strict();
export type TrainingCalendar = z.infer<typeof trainingCalendarSchema>;

export const trainingCalendarType = defineDataType('training.calendar', trainingCalendarSchema, {});

/** Topic `training.calendar`, keyed by provider. */
export const trainingCalendarState = trainingCalendarType.topic;

/** Calls for an account: `key` is the service, routed to the plugin that owns its account. */
const accountRequest = z.object({ key: z.string().min(1) }).strict();
const done = z.object({}).strict();

/**
 * Connects the account: the service's sign-in opens in the system browser. Answers once the
 * sign-in started; how it goes is the account's state.
 */
export const trainingConnectService = defineService('training.connect', {
  request: accountRequest,
  response: done,
  keyedBy: trainingAccountState,
});

/** Disconnects: the token is revoked and forgotten, the plan cleared. */
export const trainingDisconnectService = defineService('training.disconnect', {
  request: accountRequest,
  response: done,
  keyedBy: trainingAccountState,
});

/** Loads the plan again. */
export const trainingRefreshService = defineService('training.refresh', {
  request: accountRequest,
  response: done,
  keyedBy: trainingAccountState,
});

/**
 * Uploads a ride's FIT file (`file`) to the service as a done activity. Answers once the upload
 * started; how it goes is the key `sessionId` of `training.upload`.
 */
export const trainingUploadService = defineService('training.upload', {
  request: accountRequest
    .extend({ sessionId: z.string().min(1), file: z.string().min(1) })
    .strict(),
  response: done,
  keyedBy: trainingAccountState,
});
