// SPDX-License-Identifier: AGPL-3.0-or-later

// FIT workout files with ridrs' own encoder (ADR 0084), written from the public FIT protocol
// documentation: `workout` (26) and `workout_step` (27) with every field of the profile the
// importer reads, strings and `uint32z` included, and any further message the caller carries over
// (the file id, the creator, developer data). Values are the raw ones a file stores; scales and
// offsets are the caller's, as the importer reads them.
import { DEFINITION_FLAG, HEADER_SIZE, Output, sealFile } from './encoder.ts';
import {
  BASE_TYPES,
  type BaseType,
  FIT_PROTOCOL_VERSION,
  type FieldDefinition,
  MESSAGES,
} from './profile.ts';

/** A field's raw value: a number, the text of a string field, or the bytes of an array. */
export type FitWriteValue = number | string | readonly number[] | undefined;

/** Developer data written as it was read: opaque bytes and whose field they are. */
export interface FitWriteDeveloperField {
  readonly developerDataIndex: number;
  readonly num: number;
  readonly bytes: Uint8Array;
}

export interface FitWriteMessage {
  /** A message of the profile by name, or any global message number. */
  readonly message: keyof typeof MESSAGES | number;
  /**
   * Fields by the profile's name or by number (as a string key, for fields the profile lacks:
   * a string is written as a string field, a whole number as `uint32`, a negative one as
   * `sint32`, an array of numbers as `byte`s). Undefined values are not written.
   */
  readonly values: Readonly<Record<string, FitWriteValue>>;
  readonly developerFields?: readonly FitWriteDeveloperField[];
}

/** Protocol 2.0 is the one with developer data. */
const PROTOCOL_WITH_DEVELOPER_DATA = 0x20;
const DEVELOPER_FLAG = 0x20;
/** A field's size is one byte of the definition. */
const MAX_FIELD_SIZE = 255;

/** The `byte` base type: arrays of the profile's unknown fields are kept as bytes. */
const BYTE: BaseType = { name: 'enum', id: 0x0d, size: 1, invalid: 0xff };

interface Placed {
  readonly field: { readonly num: number; readonly type: BaseType };
  readonly bytes: Uint8Array;
}

const PROFILE_BY_NUM = new Map<number, (typeof MESSAGES)[keyof typeof MESSAGES]>(
  Object.values(MESSAGES).map((definition) => [definition.num, definition]),
);

/** The UTF-8 bytes of a string field, with its NUL, cut at a character if too long. */
function stringBytes(text: string): Uint8Array {
  const encoder = new TextEncoder();
  let bytes = encoder.encode(text.replaceAll('\0', ''));
  if (bytes.length > MAX_FIELD_SIZE - 1) {
    let cut = text.replaceAll('\0', '');
    while (encoder.encode(cut).length > MAX_FIELD_SIZE - 1) {
      cut = cut.slice(0, -1);
    }
    bytes = encoder.encode(cut);
  }
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}

function numberBytes(type: BaseType, value: number): Uint8Array | undefined {
  const signed = type.name === 'sint32';
  const raw = Math.round(value);
  const lowest = signed ? -type.invalid : type.name === 'uint32z' ? 1 : 0;
  // For the `z` types, 0 is the invalid value and every other value is valid.
  const highest = type.name === 'uint32z' ? 0xffff_ffff : type.invalid - 1;
  // Out of range is not representable: left out, never wrapped or clamped into a wrong value.
  if (!Number.isFinite(raw) || raw < lowest || raw > highest) {
    return undefined;
  }
  const bytes = new Uint8Array(type.size);
  const view = new DataView(bytes.buffer);
  if (type.size === 1) view.setUint8(0, raw);
  else if (type.size === 2) view.setUint16(0, raw, true);
  else if (signed) view.setInt32(0, raw, true);
  else view.setUint32(0, raw, true);
  return bytes;
}

function placeFields(message: FitWriteMessage): Placed[] {
  const profile =
    typeof message.message === 'number'
      ? PROFILE_BY_NUM.get(message.message)
      : MESSAGES[message.message];
  const byName = new Map<string, FieldDefinition>();
  const byNum = new Map<number, FieldDefinition>();
  for (const field of profile?.fields ?? []) {
    byName.set(field.name, field);
    byNum.set(field.num, field);
  }
  const placed = new Map<number, Placed>();
  for (const [key, value] of Object.entries(message.values)) {
    if (value === undefined) {
      continue;
    }
    const known = byName.get(key) ?? (/^\d+$/.test(key) ? byNum.get(Number(key)) : undefined);
    const num = known?.num ?? Number(key);
    if (!Number.isInteger(num)) {
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      const array = value.every((b) => Number.isInteger(b) && b >= 0 && b <= 0xff);
      if (array && value.length > 0 && !known) {
        placed.set(num, { field: { num, type: BYTE }, bytes: Uint8Array.from(value) });
      }
      continue;
    }
    const type: BaseType =
      known?.type ??
      (typeof value === 'string'
        ? BASE_TYPES.string
        : value < 0
          ? BASE_TYPES.sint32
          : BASE_TYPES.uint32);
    const bytes =
      type.name === 'string'
        ? typeof value === 'string'
          ? stringBytes(value)
          : undefined
        : typeof value === 'number'
          ? numberBytes(type, value)
          : undefined;
    if (bytes) {
      placed.set(num, { field: { num, type }, bytes });
    }
  }
  return [...placed.values()].sort((a, b) => {
    // The message index (254) and the timestamp (253) lead, as the profile lists them.
    const rank = (n: number) => (n >= 253 ? n - 1000 : n);
    return rank(a.field.num) - rank(b.field.num);
  });
}

/**
 * Encodes messages as a FIT file in the order given: a definition before a message whose fields
 * differ from its message type's last definition, then the data message. Only defined fields are
 * written. Pure: the same messages always give the same bytes.
 */
export function encodeFitMessages(messages: readonly FitWriteMessage[]): Uint8Array {
  const out = new Output();
  for (let i = 0; i < HEADER_SIZE; i += 1) {
    out.u8(0);
  }
  // One local message type per global message, redefined when its fields change.
  const locals = new Map<number, { local: number; signature: string | undefined }>();
  let developerData = false;
  for (const message of messages) {
    const num =
      typeof message.message === 'number' ? message.message : MESSAGES[message.message].num;
    const placed = placeFields(message);
    const developer = message.developerFields ?? [];
    developerData ||= developer.length > 0;
    const signature = [
      ...placed.map((p) => `${p.field.num}:${p.bytes.length}:${p.field.type.id}`),
      ...developer.map((d) => `d${d.developerDataIndex}:${d.num}:${d.bytes.length}`),
    ].join(',');
    let entry = locals.get(num);
    if (!entry) {
      if (locals.size >= 16) {
        throw new Error('A FIT file has at most 16 local message types.');
      }
      entry = { local: locals.size, signature: undefined };
      locals.set(num, entry);
    }
    if (entry.signature !== signature) {
      entry.signature = signature;
      out.u8(DEFINITION_FLAG | (developer.length > 0 ? DEVELOPER_FLAG : 0) | entry.local);
      out.u8(0); // reserved
      out.u8(0); // architecture: little-endian
      out.u16(num);
      out.u8(placed.length);
      for (const { field, bytes } of placed) {
        out.u8(field.num);
        out.u8(bytes.length);
        out.u8(field.type.id);
      }
      if (developer.length > 0) {
        out.u8(developer.length);
        for (const d of developer) {
          out.u8(d.num);
          out.u8(d.bytes.length);
          out.u8(d.developerDataIndex);
        }
      }
    }
    out.u8(entry.local);
    for (const { bytes } of placed) {
      out.append(bytes);
    }
    for (const d of developer) {
      out.append(d.bytes);
    }
  }
  return sealFile(out, developerData ? PROTOCOL_WITH_DEVELOPER_DATA : FIT_PROTOCOL_VERSION);
}
