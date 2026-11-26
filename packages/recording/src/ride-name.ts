// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  activityStateSchema,
  type RideWorkout,
  recordingFooterSchema,
  recordingHeaderSchema,
} from '@ridrs/contracts';
import { fileNameOf, RECORDING_EXTENSION, RECORDINGS_DIRECTORY } from './files.ts';

/**
 * What the rides saved on a device show of a ride, fixed once it is sealed (ADR 0111). A sealed
 * recording's file name holds it, so the folder listing is the index.
 */
export interface RideSummary {
  readonly sessionId: string;
  readonly startedAt: number;
  /** Of the host at start, east of UTC positive, as in the header. */
  readonly timeZoneOffsetMinutes: number;
  /** Whole seconds from the start to the footer's end; absent without a footer. */
  readonly durationSeconds?: number;
  /** The planned entry the ride's workout came from. */
  readonly planned?: { readonly provider: string; readonly id: string };
  /** The workout's name, else "Ride"; cut to {@link NAME_BYTES}. */
  readonly name: string;
}

const PREFIX = 'ride-';
const SEPARATOR = '~';
/** The name's most bytes once encoded; with the other fields the file name stays far below 255. */
const NAME_BYTES = 100;
const ELLIPSIS = '…';
const NO_VALUE = '-';
const DEFAULT_NAME = 'Ride';

/** What macOS, Android, iOS or Windows forbid or treat specially, the escape and the separator. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it encodes.
const RESERVED = /[%/\\:*?"<>|~\u0000-\u001f\u007f]/g;
const ESCAPED = /%([0-9A-F]{2})/g;
const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})([+-])(\d{2})(\d{2})$/;

const percentOf = (char: string): string =>
  `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

const encodeField = (text: string): string => text.replace(RESERVED, percentOf);

/** Undefined for a `%` that is not one of the escapes `encodeField` writes. */
function decodeField(text: string, underscore?: string): string | undefined {
  if (text.replace(ESCAPED, '').includes('%')) {
    return undefined;
  }
  return text.replace(/%([0-9A-F]{2})|_/g, (match, hex: string | undefined) =>
    hex ? String.fromCharCode(Number.parseInt(hex, 16)) : (underscore ?? match),
  );
}

/** The session with `:` as `_` (its `linkIdOf`), and a `_` of its own escaped, so it comes back exactly. */
const encodeSession = (sessionId: string): string =>
  sessionId
    .split(':')
    .map((part) => encodeField(part).replaceAll('_', '%5F'))
    .join('_');

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

/** The local start, ISO 8601 basic with milliseconds and the offset: `20261124T112908.647+0100`. */
function localStamp(startedAt: number, offsetMinutes: number): string {
  const d = new Date(startedAt + offsetMinutes * 60_000);
  const offset = Math.abs(offsetMinutes);
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}` +
    `${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(offset / 60))}${pad(offset % 60)}`
  );
}

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/** The encoded name, cut at a grapheme boundary and ended with `…` when it is longer than allowed. */
function encodeName(name: string): string {
  const encoded = encodeField(name);
  if (bytesOf(encoded) <= NAME_BYTES) {
    return encoded;
  }
  const room = NAME_BYTES - bytesOf(ELLIPSIS);
  let cut = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
    name,
  )) {
    const next = cut + encodeField(segment);
    if (bytesOf(next) > room) {
      break;
    }
    cut = next;
  }
  return `${cut}${ELLIPSIS}`;
}

/** `ride-<local start>~<session>~<duration>s~<plan>~<name>`, without directory and extension. */
export function rideName(summary: RideSummary): string {
  const { sessionId, startedAt, timeZoneOffsetMinutes, durationSeconds, planned, name } = summary;
  return [
    `${PREFIX}${localStamp(startedAt, timeZoneOffsetMinutes)}`,
    encodeSession(sessionId),
    durationSeconds === undefined ? NO_VALUE : `${durationSeconds}s`,
    planned ? `${planned.provider}=${encodeField(planned.id)}` : NO_VALUE,
    encodeName(name),
  ].join(SEPARATOR);
}

/** `recordings/<ride name>.ridrs`: where a ride's sealed recording goes. */
export function ridePath(summary: RideSummary): string {
  return `${RECORDINGS_DIRECTORY}/${rideName(summary)}${RECORDING_EXTENSION}`;
}

function parseStamp(
  text: string,
): { startedAt: number; timeZoneOffsetMinutes: number } | undefined {
  const match = STAMP.exec(text);
  if (!match) {
    return undefined;
  }
  const [year = 0, month = 1, day, hours, minutes, seconds, millis] = match.slice(1, 8).map(Number);
  const offset = (match[8] === '-' ? -1 : 1) * (Number(match[9]) * 60 + Number(match[10]));
  const local = Date.UTC(year, month - 1, day, hours, minutes, seconds, millis);
  return { startedAt: local - offset * 60_000, timeZoneOffsetMinutes: offset };
}

/**
 * The summary in a sealed recording's file name, or undefined for any other file (an open
 * recording, a FIT file, a screenshot, a recording named before ADR 0111). Later fields may come
 * between the plan and the name, which is always last.
 */
export function parseRideName(path: string): RideSummary | undefined {
  const file = fileNameOf(path);
  if (!file.startsWith(PREFIX) || !file.endsWith(RECORDING_EXTENSION)) {
    return undefined;
  }
  const fields = file.slice(PREFIX.length, -RECORDING_EXTENSION.length).split(SEPARATOR);
  const [stampField, sessionField, durationField, planField] = fields;
  const nameField = fields.at(-1);
  if (
    fields.length < 5 ||
    !stampField ||
    !sessionField ||
    !durationField ||
    !planField ||
    nameField === undefined
  ) {
    return undefined;
  }
  const stamp = parseStamp(stampField);
  const sessionId = decodeField(sessionField, ':');
  const name = decodeField(nameField);
  if (!stamp || !sessionId || name === undefined) {
    return undefined;
  }
  let durationSeconds: number | undefined;
  if (durationField !== NO_VALUE) {
    const match = /^(\d+)s$/.exec(durationField);
    if (!match) {
      return undefined;
    }
    durationSeconds = Number(match[1]);
  }
  let planned: RideSummary['planned'];
  if (planField !== NO_VALUE) {
    const at = planField.indexOf('=');
    const id = at > 0 ? decodeField(planField.slice(at + 1)) : undefined;
    if (!id) {
      return undefined;
    }
    planned = { provider: planField.slice(0, at), id };
  }
  return {
    sessionId,
    ...stamp,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(planned ? { planned } : {}),
    name,
  };
}

/** The last workout of the ride's activity states (rule 13: the recording keeps it). */
function lastWorkout(text: string): RideWorkout | undefined {
  const needle = `"type":"${activityStateChangedEvent.id}"`;
  let latest: RideWorkout | undefined;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
    const start = text.lastIndexOf('\n', at) + 1;
    const end = text.indexOf('\n', at);
    let record: { kind?: unknown; envelope?: { type?: unknown; payload?: unknown } };
    try {
      record = JSON.parse(text.slice(start, end === -1 ? undefined : end));
    } catch {
      continue;
    }
    if (record.kind !== 'event' || record.envelope?.type !== activityStateChangedEvent.id) {
      continue;
    }
    const state = activityStateSchema.safeParse(record.envelope.payload);
    if (state.success && state.data.state !== 'idle' && state.data.workout) {
      latest = state.data.workout;
    }
  }
  return latest;
}

/**
 * The summary of a recording's text (`.ridrs.jsonl`, or a `.ridrs` gunzipped): its header, its
 * footer's end and its last workout. Only those lines are parsed, not the ride's events.
 */
export function summaryOfText(text: string): RideSummary {
  const firstEnd = text.indexOf('\n');
  const header = recordingHeaderSchema.parse(
    JSON.parse(text.slice(0, firstEnd === -1 ? undefined : firstEnd)),
  );
  const trimmed = text.trimEnd();
  const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
  let footer: { endedAt: number } | undefined;
  try {
    const parsed = recordingFooterSchema.safeParse(JSON.parse(lastLine));
    footer = parsed.success ? parsed.data : undefined;
  } catch {
    footer = undefined;
  }
  const workout = lastWorkout(text);
  return {
    sessionId: header.sessionId,
    startedAt: header.startedAt,
    timeZoneOffsetMinutes: header.timeZoneOffsetMinutes,
    ...(footer
      ? { durationSeconds: Math.max(0, Math.round((footer.endedAt - header.startedAt) / 1000)) }
      : {}),
    ...(workout?.planned ? { planned: workout.planned } : {}),
    name: workout?.workout.name ?? DEFAULT_NAME,
  };
}
