// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineState } from './app-state.ts';
import { jsonValueSchema } from './config.ts';
import { defineService } from './services.ts';

// ridrs recording v1: JSON Lines, one record per line (docs/formats/ridrs-recording-v1.md).
// Readers ignore unknown record kinds and unknown fields, so records are loose objects.

export const RECORDING_FORMAT = 'ridrs.recording';
export const RECORDING_FORMAT_VERSION = 1;
export const RECORDING_MEDIA_TYPE = 'application/vnd.ridrs.recording+json-seq; compression=gzip';

export const recordingHeaderSchema = z.looseObject({
  kind: z.literal('header'),
  format: z.literal(RECORDING_FORMAT),
  formatVersion: z.number().int().positive(),
  ridrsVersion: z.string(),
  sessionId: z.string().min(1),
  /** The host run; a replay reuses it, so derived ids reproduce. Absent in early recordings. */
  runId: z.string().min(1).optional(),
  startedAt: z.number(),
  /** Of the host at start, east of UTC positive (UTC+1 -> 60). */
  timeZoneOffsetMinutes: z.number().int(),
  platform: z.looseObject({
    runtime: z.enum(['node', 'tauri']),
    os: z.string(),
    appVersion: z.string(),
  }),
  prerollMs: z.number().nonnegative(),
});

export const recordingSnapshotSchema = z.looseObject({
  kind: z.literal('snapshot'),
  /** `ctx.host.describe()` at ride start. */
  host: jsonValueSchema,
  /** Every `config.snapshot` section, keyed by section, sorted. */
  sections: z.record(z.string(), jsonValueSchema),
});

export const recordedEnvelopeSchema = z.looseObject({
  id: z.string(),
  type: z.string().min(1),
  source: z.string(),
  timestamp: z.number(),
  /** Verbatim as published; validated by readers that know the event type. */
  payload: z.unknown(),
  seq: z.number().int().positive().optional(),
  input: z.literal(true).optional(),
  receivedAt: z.number().optional(),
});

export const recordingEventSchema = z.looseObject({
  kind: z.literal('event'),
  seq: z.number().int().positive(),
  preroll: z.boolean(),
  envelope: recordedEnvelopeSchema,
});

export const recordingDiagnosticSchema = z.looseObject({
  kind: z.literal('diagnostic'),
  seq: z.number().int().positive(),
  at: z.number(),
  code: z.string().min(1),
  pluginId: z.string().optional(),
  message: z.string(),
  details: z.record(z.string(), jsonValueSchema).optional(),
});

export const recordingFooterSchema = z.looseObject({
  kind: z.literal('footer'),
  status: z.enum(['complete', 'recovered']),
  endedAt: z.number(),
  lastSeq: z.number().int().nonnegative(),
  counts: z.looseObject({
    events: z.number().int().nonnegative(),
    diagnostics: z.number().int().nonnegative(),
    byType: z.record(z.string(), z.number().int().nonnegative()),
  }),
});

export const recordingRecordSchema = z.discriminatedUnion('kind', [
  recordingHeaderSchema,
  recordingSnapshotSchema,
  recordingEventSchema,
  recordingDiagnosticSchema,
  recordingFooterSchema,
]);

export type RecordingHeader = z.infer<typeof recordingHeaderSchema>;
export type RecordingSnapshot = z.infer<typeof recordingSnapshotSchema>;
export type RecordedEnvelope = z.infer<typeof recordedEnvelopeSchema>;
export type RecordingEvent = z.infer<typeof recordingEventSchema>;
export type RecordingDiagnostic = z.infer<typeof recordingDiagnosticSchema>;
export type RecordingFooter = z.infer<typeof recordingFooterSchema>;
export type RecordingRecord = z.infer<typeof recordingRecordSchema>;

/**
 * A ride's recording as the app shows it (ADR 0069), by its session: `saved` once written and
 * verified (`file` is the compressed `.ridrs`; also a ride recovered at start), `failed` when it
 * could not be written (the ride itself went on), `deleted` once the rider deleted it.
 */
export const recordingRideSchema = z
  .object({
    sessionId: z.string().min(1),
    state: z.enum(['saved', 'failed', 'deleted']),
    file: z.string().min(1).optional(),
    bytes: z.number().int().nonnegative().optional(),
    events: z.number().int().nonnegative().optional(),
    /** m, from the last `physics.state`; absent without physics. */
    distance: z.number().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    /** Why it failed. */
    reason: z.string().optional(),
  })
  .strict();

export type RecordingRide = z.infer<typeof recordingRideSchema>;

/** Every ride of this run, by session; owner `recording-session`. */
export const recordingRideState = defineState('recording.ride', recordingRideSchema);

/**
 * An interrupted ride found at start that can go on with the plugins as they are (ADR 0057): the
 * rider continues it or finishes it.
 */
export const recoverableRideSchema = z
  .object({
    sessionId: z.string().min(1),
    /** The open recording (`.ridrs.jsonl`). */
    file: z.string().min(1),
    startedAt: z.number(),
    /** Logical ms of the last committed event: where the ride was interrupted. */
    lastRecordAt: z.number(),
    /** m, from the last committed `physics.state`. */
    distance: z.number().nonnegative().optional(),
  })
  .strict();

export type RecoverableRide = z.infer<typeof recoverableRideSchema>;

/** The interrupted ride on offer, by its session; removed once it was continued or finished. */
export const recordingRecoverableState = defineState(
  'recording.recoverable',
  recoverableRideSchema,
);

/** The FIT export of a ride's recording, by its session; owner `export-fit`. */
export const exportFitSchema = z
  .object({
    sessionId: z.string().min(1),
    file: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    /** Absent for a file that was already there (a restarted `export-fit` writes none again). */
    records: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ExportFit = z.infer<typeof exportFitSchema>;

export const exportFitState = defineState('export.fit', exportFitSchema);

const rideRequest = z.object({ key: z.string().min(1) }).strict();
const done = z.object({}).strict();

/**
 * The rider continues the interrupted ride on offer. Only the composition root can do it: it
 * composes a continuing host (ADR 0057), so it provides the service itself (ADR 0069).
 */
export const recordingContinueService = defineService('recording.continue', {
  request: z.object({ sessionId: z.string().min(1) }).strict(),
  response: done,
});

/** The rider finishes the interrupted ride on offer: it is sealed as `recovered`. */
export const recordingFinishService = defineService('recording.finish', {
  request: rideRequest,
  response: done,
  keyedBy: recordingRecoverableState,
});

/**
 * The rider deletes a saved ride: its recording and every export of it are removed from the app
 * files. Answers once the recording is gone; the ride's state becomes `deleted`.
 */
export const recordingDeleteService = defineService('recording.delete', {
  request: rideRequest,
  response: done,
  keyedBy: recordingRideState,
});
