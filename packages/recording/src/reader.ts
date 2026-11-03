// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type EventDefinition,
  RECORDING_FORMAT,
  RECORDING_FORMAT_VERSION,
  type RecordingDiagnostic,
  type RecordingEvent,
  type RecordingFooter,
  type RecordingHeader,
  type RecordingRecord,
  type RecordingSnapshot,
  RidrsError,
  recordingDiagnosticSchema,
  recordingEventSchema,
  recordingFooterSchema,
  recordingHeaderSchema,
  recordingSnapshotSchema,
} from '@ridrs/contracts';
import { gunzip, isGzip } from './compression.ts';

/** A parsed recording. Unknown record kinds are counted, not kept. */
export interface Recording {
  readonly header: RecordingHeader;
  readonly snapshot: RecordingSnapshot;
  /** In recording order. */
  readonly events: readonly RecordingEvent[];
  readonly diagnostics: readonly RecordingDiagnostic[];
  /** Absent only when read with `requireFooter: false` (an open `.ridrs.jsonl`). */
  readonly footer?: RecordingFooter;
  /** Every record of a known kind, in recording order. */
  readonly records: readonly RecordingRecord[];
  /** Records of kinds this reader does not know, by kind. */
  readonly ignoredKinds: Readonly<Record<string, number>>;
  /** Number of lines, the torn one excluded. */
  readonly lines: number;
  /** The valid lines verbatim (each without its newline), the torn one excluded. */
  readonly rawLines: readonly string[];
  readonly tornLastLine: boolean;
}

export interface ReadRecordingOptions {
  /** Event types this reader knows: their payloads are validated against the schema. */
  readonly events?: Iterable<EventDefinition>;
  /** An unparseable last line is dropped instead of failing (recovery of an open file). */
  readonly allowTornLastLine?: boolean;
  /** Default true: a recording without footer is invalid. */
  readonly requireFooter?: boolean;
}

const SCHEMAS = {
  snapshot: recordingSnapshotSchema,
  event: recordingEventSchema,
  diagnostic: recordingDiagnosticSchema,
  footer: recordingFooterSchema,
} as const;

function invalid(message: string): RidrsError {
  return new RidrsError('invalid-recording', message);
}

/** Reads a `.ridrs` (gzip) or `.ridrs.jsonl` (plain) recording. */
export async function readRecording(
  bytes: Uint8Array,
  options: ReadRecordingOptions = {},
): Promise<Recording> {
  const text = new TextDecoder().decode(isGzip(bytes) ? await gunzip(bytes) : bytes);
  return parseRecording(text, options);
}

export function parseRecording(text: string, options: ReadRecordingOptions = {}): Recording {
  const definitions = new Map([...(options.events ?? [])].map((d) => [d.id, d] as const));
  const lines = text.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }

  const parsed: Array<{ raw: string; value: unknown }> = [];
  let tornLastLine = false;
  for (const [index, raw] of lines.entries()) {
    try {
      parsed.push({ raw, value: JSON.parse(raw) });
    } catch {
      if (options.allowTornLastLine && index === lines.length - 1) {
        tornLastLine = true;
        break;
      }
      throw invalid(`Line ${index + 1} is not JSON`);
    }
  }

  const first = parsed[0]?.value as { kind?: unknown; format?: unknown; formatVersion?: unknown };
  if (first?.kind !== 'header' || first.format !== RECORDING_FORMAT) {
    throw invalid('The first line is not a ridrs recording header');
  }
  if (typeof first.formatVersion === 'number' && first.formatVersion > RECORDING_FORMAT_VERSION) {
    throw new RidrsError(
      'recording-unsupported-version',
      `Recording format version ${first.formatVersion} is newer than ${RECORDING_FORMAT_VERSION}`,
    );
  }
  const header = parseWith(recordingHeaderSchema, first, 1);

  const records: RecordingRecord[] = [header];
  const events: RecordingEvent[] = [];
  const diagnostics: RecordingDiagnostic[] = [];
  const ignoredKinds: Record<string, number> = {};
  let snapshot: RecordingSnapshot | undefined;
  let footer: RecordingFooter | undefined;

  for (const [index, { value }] of parsed.entries()) {
    if (index === 0) {
      continue;
    }
    const lineNumber = index + 1;
    if (footer) {
      throw invalid(`Line ${lineNumber} follows the footer`);
    }
    const kind = (value as { kind?: unknown })?.kind;
    if (typeof kind !== 'string' || !(kind in SCHEMAS) || kind === 'header') {
      const key = typeof kind === 'string' ? kind : '(none)';
      ignoredKinds[key] = (ignoredKinds[key] ?? 0) + 1;
      continue;
    }
    if (kind === 'snapshot') {
      if (index !== 1) {
        throw invalid(`The snapshot must be line 2, found it on line ${lineNumber}`);
      }
      snapshot = parseWith(recordingSnapshotSchema, value, lineNumber);
      records.push(snapshot);
    } else if (kind === 'event') {
      const event = parseWith(recordingEventSchema, value, lineNumber);
      const definition = definitions.get(event.envelope.type);
      if (definition && !definition.schema.safeParse(event.envelope.payload).success) {
        throw invalid(`Line ${lineNumber}: invalid "${event.envelope.type}" payload`);
      }
      events.push(event);
      records.push(event);
    } else if (kind === 'diagnostic') {
      const diagnostic = parseWith(recordingDiagnosticSchema, value, lineNumber);
      diagnostics.push(diagnostic);
      records.push(diagnostic);
    } else {
      footer = parseWith(recordingFooterSchema, value, lineNumber);
      records.push(footer);
    }
  }

  if (!snapshot) {
    throw invalid('The recording has no snapshot');
  }
  if (!footer && options.requireFooter !== false) {
    throw invalid('The recording has no footer');
  }
  return {
    header,
    snapshot,
    events,
    diagnostics,
    footer,
    records,
    ignoredKinds,
    lines: parsed.length,
    rawLines: parsed.map((line) => line.raw),
    tornLastLine,
  };
}

function parseWith<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  lineNumber: number,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw invalid(`Line ${lineNumber} is not a valid ${(value as { kind?: string }).kind} record`);
  }
  return result.data;
}

/** The time of the last record: an event's timestamp, a diagnostic's time, else the start. */
export function lastRecordTime(recording: Pick<Recording, 'header' | 'records'>): number {
  for (const record of [...recording.records].reverse()) {
    if (record.kind === 'event') {
      return record.envelope.timestamp;
    }
    if (record.kind === 'diagnostic') {
      return record.at;
    }
    if (record.kind === 'footer') {
      return record.endedAt;
    }
  }
  return recording.header.startedAt;
}
