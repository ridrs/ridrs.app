// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { jsonValueSchema } from './config.ts';
import { defineEvent } from './events.ts';

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

/** A ride's recording was written and verified (`file` is the compressed `.ridrs`). */
export const recordingCompletedEvent = defineEvent(
  'recording.completed',
  z.object({
    sessionId: z.string().min(1),
    file: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    /** m, from the last `physics.state`; absent without physics. */
    distance: z.number().nonnegative().optional(),
    durationMs: z.number().nonnegative(),
  }),
);

/** A ride's recording could not be written; the ride itself went on. */
export const recordingFailedEvent = defineEvent(
  'recording.failed',
  z.object({ sessionId: z.string().min(1), reason: z.string() }),
);

/** The FIT export of a recording was written. */
export const exportFitWrittenEvent = defineEvent(
  'export.fit-written',
  z.object({
    sessionId: z.string().min(1),
    file: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    records: z.number().int().nonnegative(),
  }),
);
