// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineState } from './app-state.ts';
import { defineDataType, providerIdSchema } from './data-sources.ts';
import { defineService } from './services.ts';
import { workoutSchema, workoutStepSchema } from './workout.ts';

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
  /** The service answered 429 (too many requests): nothing is sent until its `Retry-After` has passed. */
  'rate-limited',
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
    /** The structure in the canonical model (ADR 0081); empty when the source has none. */
    steps: z.array(workoutStepSchema),
    /**
     * The library workout the entry was planned from (structured-workouts.md, section 10): its
     * future, unridden entries follow when that workout changes. Absent for an entry made or
     * changed in the calendar's own service, which ridrs never silently overwrites.
     */
    library: z
      .object({ from: providerIdSchema, workoutId: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
export type PlannedWorkout = z.infer<typeof plannedWorkoutSchema>;

/**
 * A workout of a library (ADR 0075): what a planned workout has, without a date. `workout` is the
 * whole canonical workout (ADR 0081) where the provider has it (the ridrs library, imported
 * workouts): its metadata, extensions and source, for the details and every export. Then `steps`
 * are its steps.
 */
export const libraryWorkoutSchema = plannedWorkoutSchema
  .omit({ date: true, library: true })
  .extend({ folder: z.string().optional(), workout: workoutSchema.optional() })
  .strict();
export type LibraryWorkout = z.infer<typeof libraryWorkoutSchema>;

/** The workouts of a provider's library, read only; ridrs on this device has none. */
export const trainingLibraryType = defineDataType(
  'training.library',
  z.object({ workouts: z.array(libraryWorkoutSchema) }).strict(),
  {},
);

/** Topic `training.library`, keyed by provider. */
export const trainingLibraryState = trainingLibraryType.topic;

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

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The calendar as a data type: one chosen source, written by `training.calendar.plan` (a library
 * workout of the provider `from`, with its steps, on a day), `.move` and `.remove`. The key of a
 * call is the provider of the calendar.
 */
export const trainingCalendarType = defineDataType('training.calendar', trainingCalendarSchema, {
  plan: z
    .object({ date: localDateSchema, workoutId: z.string().min(1), from: providerIdSchema })
    .strict(),
  move: z.object({ id: z.string().min(1), date: localDateSchema }).strict(),
  remove: z.object({ id: z.string().min(1) }).strict(),
});

/** Topic `training.calendar`, keyed by provider. */
export const trainingCalendarState = trainingCalendarType.topic;

export const trainingCalendarPlanService = trainingCalendarType.writes.plan;
export const trainingCalendarMoveService = trainingCalendarType.writes.move;
export const trainingCalendarRemoveService = trainingCalendarType.writes.remove;

/**
 * Hands the calendar of ridrs on this device to its owner: the Training area keeps its entries in
 * its client module, and the owner of the key `ridrs` of `training.calendar` (its host side)
 * publishes them. `workouts` are the entries of kind workout on their dates (ADR 0075).
 */
export const trainingCalendarHandOverService = defineService('training.calendar.hand-over', {
  request: z.object({ workouts: z.array(plannedWorkoutSchema) }).strict(),
  response: z.object({}).strict(),
});

/**
 * A ride that was done (ADR 0076): what the Training area shows in a day's "Done" column. The
 * same ride can be known by several providers (a ride of ridrs that was uploaded to intervals.icu),
 * so a reader merges them by `externalId` and by the start time.
 */
export const completedWorkoutSchema = z
  .object({
    id: z.string().min(1),
    /** The rider's local date, `YYYY-MM-DD`. */
    date: localDateSchema,
    /** When the ride started, epoch ms; the merge of providers matches rides by it. */
    startedAt: z.number().optional(),
    name: z.string(),
    sport: z.enum(['ride', 'virtual-ride']),
    durationSeconds: z.number().nonnegative().optional(),
    trainingLoad: z.number().nonnegative().optional(),
    /** The id of the ridrs session the ride was recorded in, when the provider knows it. */
    externalId: z.string().min(1).optional(),
  })
  .strict();
export type CompletedWorkout = z.infer<typeof completedWorkoutSchema>;

/**
 * The rides a provider has done, newest last: the data type `training.history`. Unlike the
 * calendar it is not one chosen source: every provider that offers it adds to what the area
 * shows (ADR 0076).
 */
export const trainingHistoryType = defineDataType(
  'training.history',
  z.object({ workouts: z.array(completedWorkoutSchema) }).strict(),
  {},
);

/** Topic `training.history`, keyed by provider. */
export const trainingHistoryState = trainingHistoryType.topic;

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
 * Loads the library of the service when it is not there or older than a day (ADR 0078, with the
 * drafts): the library is read only while it is shown, not at start. Answers once the work
 * started; a fresh library costs no request.
 */
export const trainingLibraryLoadService = defineService('training.library.load', {
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
