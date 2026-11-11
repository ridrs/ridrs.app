// SPDX-License-Identifier: AGPL-3.0-or-later

// ridrs' own FIT decoder (ADR 0084), written from the public FIT protocol documentation: the file
// header, definition and data messages, normal and compressed timestamp headers, developer data
// fields, both byte orders and the invalid value of every base type. No SDK code is copied; the
// official SDK only cross-checks it in tests.
import { fitCrc } from './crc.ts';
import { type FieldDefinition, MESSAGES, type MessageDefinition } from './profile.ts';

/** The FIT base types by their number (the low five bits of a field definition's type byte). */
export type FitBaseTypeName =
  | 'enum'
  | 'sint8'
  | 'uint8'
  | 'sint16'
  | 'uint16'
  | 'sint32'
  | 'uint32'
  | 'string'
  | 'float32'
  | 'float64'
  | 'uint8z'
  | 'uint16z'
  | 'uint32z'
  | 'byte'
  | 'sint64'
  | 'uint64'
  | 'uint64z';

interface BaseTypeInfo {
  readonly name: FitBaseTypeName;
  readonly size: number;
}

const BASE_TYPE_BY_NUMBER: Readonly<Record<number, BaseTypeInfo>> = {
  0: { name: 'enum', size: 1 },
  1: { name: 'sint8', size: 1 },
  2: { name: 'uint8', size: 1 },
  3: { name: 'sint16', size: 2 },
  4: { name: 'uint16', size: 2 },
  5: { name: 'sint32', size: 4 },
  6: { name: 'uint32', size: 4 },
  7: { name: 'string', size: 1 },
  8: { name: 'float32', size: 4 },
  9: { name: 'float64', size: 8 },
  10: { name: 'uint8z', size: 1 },
  11: { name: 'uint16z', size: 2 },
  12: { name: 'uint32z', size: 4 },
  13: { name: 'byte', size: 1 },
  14: { name: 'sint64', size: 8 },
  15: { name: 'uint64', size: 8 },
  16: { name: 'uint64z', size: 8 },
};

const BYTE: BaseTypeInfo = { name: 'byte', size: 1 };

/** One value: 64-bit integers are bigints, strings are text, the rest numbers. */
export type FitScalar = number | bigint | string;
/** An array keeps its invalid elements as `null`, so that positions stay. */
export type FitValue = FitScalar | readonly (number | bigint | null)[];

export interface DecodedFitField {
  readonly num: number;
  /** The profile's name, where `@ridrs/fit` knows the field. */
  readonly name?: string;
  readonly baseType: FitBaseTypeName;
  /** As stored in the file, in the file's byte order already read. */
  readonly value: FitValue;
  /** `value / scale - offset`, where the profile gives the field a scale or an offset. */
  readonly scaled?: number;
}

/** Developer data is kept opaque: its bytes, and whose field it is. */
export interface DecodedFitDeveloperField {
  readonly developerDataIndex: number;
  readonly num: number;
  readonly bytes: Uint8Array;
}

export interface DecodedFitMessage {
  /** The global message number. */
  readonly num: number;
  /** The profile's name, where `@ridrs/fit` knows the message. */
  readonly name?: string;
  readonly localType: number;
  /** Valid fields by number; a field holding its base type's invalid value is absent. */
  readonly fields: Readonly<Record<number, DecodedFitField>>;
  readonly developerFields: readonly DecodedFitDeveloperField[];
  /** True when the timestamp (field 253) came from a compressed timestamp header. */
  readonly compressedTimestamp?: boolean;
}

export interface FitHeader {
  readonly headerSize: 12 | 14;
  readonly protocolVersion: number;
  /** `major · 1000 + minor`, e.g. 21218. */
  readonly profileVersion: number;
  readonly dataSize: number;
}

export interface FitDiagnostic {
  readonly severity: 'error' | 'warning';
  /** `not-fit`, `bad-header-crc`, `bad-crc`, `truncated`, `undefined-local-type`, `trailing-data`. */
  readonly code: string;
  readonly message: string;
  /** The byte offset in the file. */
  readonly offset?: number;
}

export type FitDecodeResult =
  | {
      readonly ok: true;
      readonly header: FitHeader;
      readonly messages: readonly DecodedFitMessage[];
      readonly diagnostics: readonly FitDiagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly FitDiagnostic[] };

interface FieldLayout {
  readonly num: number;
  readonly size: number;
  readonly type: BaseTypeInfo;
}

interface DeveloperFieldLayout {
  readonly num: number;
  readonly size: number;
  readonly developerDataIndex: number;
}

interface Definition {
  readonly num: number;
  readonly littleEndian: boolean;
  readonly fields: readonly FieldLayout[];
  readonly developerFields: readonly DeveloperFieldLayout[];
  readonly profile?: MessageDefinition;
}

const PROFILE_BY_NUMBER = new Map<number, MessageDefinition>(
  Object.values(MESSAGES).map((message) => [message.num, message]),
);

const TIMESTAMP_FIELD = 253;
const COMPRESSED_HEADER = 0x80;
const DEFINITION_HEADER = 0x40;
const DEVELOPER_DATA_FLAG = 0x20;

class Truncated extends Error {}

const utf8 = new TextDecoder('utf-8', { fatal: false });

function isInvalid(type: FitBaseTypeName, view: DataView, at: number, little: boolean): boolean {
  switch (type) {
    case 'enum':
    case 'uint8':
    case 'byte':
      return view.getUint8(at) === 0xff;
    case 'sint8':
      return view.getUint8(at) === 0x7f;
    case 'uint8z':
      return view.getUint8(at) === 0;
    case 'sint16':
      return view.getUint16(at, little) === 0x7fff;
    case 'uint16':
      return view.getUint16(at, little) === 0xffff;
    case 'uint16z':
      return view.getUint16(at, little) === 0;
    case 'sint32':
      return view.getUint32(at, little) === 0x7fff_ffff;
    case 'uint32':
    case 'float32':
      return view.getUint32(at, little) === 0xffff_ffff;
    case 'uint32z':
      return view.getUint32(at, little) === 0;
    case 'sint64':
      return view.getBigUint64(at, little) === 0x7fff_ffff_ffff_ffffn;
    case 'uint64':
    case 'float64':
      return view.getBigUint64(at, little) === 0xffff_ffff_ffff_ffffn;
    case 'uint64z':
      return view.getBigUint64(at, little) === 0n;
    case 'string':
      return view.getUint8(at) === 0;
  }
}

function read(type: FitBaseTypeName, view: DataView, at: number, little: boolean): number | bigint {
  switch (type) {
    case 'sint8':
      return view.getInt8(at);
    case 'sint16':
      return view.getInt16(at, little);
    case 'uint16':
    case 'uint16z':
      return view.getUint16(at, little);
    case 'sint32':
      return view.getInt32(at, little);
    case 'uint32':
    case 'uint32z':
      return view.getUint32(at, little);
    case 'float32':
      return view.getFloat32(at, little);
    case 'float64':
      return view.getFloat64(at, little);
    case 'sint64':
      return view.getBigInt64(at, little);
    case 'uint64':
    case 'uint64z':
      return view.getBigUint64(at, little);
    default:
      return view.getUint8(at);
  }
}

/** A string ends at its first NUL; an empty string is invalid. */
function readString(bytes: Uint8Array, start: number, size: number): string | undefined {
  let end = start;
  while (end < start + size && bytes[end] !== 0) {
    end += 1;
  }
  return end === start ? undefined : utf8.decode(bytes.subarray(start, end));
}

function readField(
  bytes: Uint8Array,
  view: DataView,
  at: number,
  layout: FieldLayout,
  little: boolean,
): FitValue | undefined {
  const { type, size } = layout;
  if (type.name === 'string') {
    return readString(bytes, at, size);
  }
  const count = size / type.size;
  if (count === 1 && type.name !== 'byte') {
    return isInvalid(type.name, view, at, little) ? undefined : read(type.name, view, at, little);
  }
  // A byte field is invalid only when all its bytes are; other arrays element by element.
  if (type.name === 'byte') {
    const values = [...bytes.subarray(at, at + size)];
    return values.every((value) => value === 0xff) ? undefined : values;
  }
  const values: (number | bigint | null)[] = [];
  for (let i = 0; i < count; i += 1) {
    const offset = at + i * type.size;
    values.push(
      isInvalid(type.name, view, offset, little) ? null : read(type.name, view, offset, little),
    );
  }
  return values.every((value) => value === null) ? undefined : values;
}

function scaledValue(value: FitValue, profile: FieldDefinition | undefined): number | undefined {
  if (profile === undefined || typeof value !== 'number') {
    return undefined;
  }
  const scale = profile.scale ?? 1;
  const offset = profile.offset ?? 0;
  return scale === 1 && offset === 0 ? undefined : value / scale - offset;
}

function header(bytes: Uint8Array, diagnostics: FitDiagnostic[]): FitHeader | undefined {
  const size = bytes[0];
  const signature = String.fromCharCode(...bytes.subarray(8, 12));
  if (bytes.length < 12 || (size !== 12 && size !== 14) || signature !== '.FIT') {
    diagnostics.push({
      severity: 'error',
      code: 'not-fit',
      message: 'The file has no FIT header (a 12- or 14-byte header ending in ".FIT").',
      offset: 0,
    });
    return undefined;
  }
  if (bytes.length < size) {
    diagnostics.push({
      severity: 'error',
      code: 'truncated',
      message: `The file ends inside its ${size}-byte header.`,
      offset: bytes.length,
    });
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (size === 14) {
    // A header CRC of 0 means "not computed".
    const stored = view.getUint16(12, true);
    if (stored !== 0 && stored !== fitCrc(bytes, 0, 12)) {
      diagnostics.push({
        severity: 'error',
        code: 'bad-header-crc',
        message: `The header CRC is 0x${stored.toString(16)}, the header gives 0x${fitCrc(bytes, 0, 12).toString(16)}.`,
        offset: 12,
      });
      return undefined;
    }
  }
  return {
    headerSize: size,
    protocolVersion: view.getUint8(1),
    profileVersion: view.getUint16(2, true),
    dataSize: view.getUint32(4, true),
  };
}

/**
 * Decodes a FIT file. It refuses a file without a FIT header, with a broken header or file CRC,
 * one that ends early, and a data message without a definition, each with a diagnostic. Only the
 * first FIT file of a chained file is read; bytes after it give a warning.
 */
export function decodeFit(bytes: Uint8Array): FitDecodeResult {
  const diagnostics: FitDiagnostic[] = [];
  const head = header(bytes, diagnostics);
  if (head === undefined) {
    return { ok: false, diagnostics };
  }
  const end = head.headerSize + head.dataSize;
  if (bytes.length < end + 2) {
    diagnostics.push({
      severity: 'error',
      code: 'truncated',
      message: `The header announces ${head.dataSize} bytes of data and a CRC, the file ends after ${bytes.length - head.headerSize} bytes.`,
      offset: bytes.length,
    });
    return { ok: false, diagnostics };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const storedCrc = view.getUint16(end, true);
  const crc = fitCrc(bytes, 0, end);
  if (storedCrc !== crc) {
    diagnostics.push({
      severity: 'error',
      code: 'bad-crc',
      message: `The file CRC is 0x${storedCrc.toString(16)}, the content gives 0x${crc.toString(16)}.`,
      offset: end,
    });
    return { ok: false, diagnostics };
  }
  if (bytes.length > end + 2) {
    diagnostics.push({
      severity: 'warning',
      code: 'trailing-data',
      message: `${bytes.length - end - 2} bytes after the file CRC are not read.`,
      offset: end + 2,
    });
  }

  const definitions = new Map<number, Definition>();
  const messages: DecodedFitMessage[] = [];
  let lastTimestamp: number | undefined;
  let at = head.headerSize;
  const need = (size: number) => {
    if (at + size > end) {
      throw new Truncated();
    }
  };

  try {
    while (at < end) {
      const recordStart = at;
      const recordHeader = view.getUint8(at);
      at += 1;
      if ((recordHeader & COMPRESSED_HEADER) === 0 && (recordHeader & DEFINITION_HEADER) !== 0) {
        need(5);
        const littleEndian = view.getUint8(at + 1) === 0;
        const num = view.getUint16(at + 2, littleEndian);
        const fieldCount = view.getUint8(at + 4);
        at += 5;
        need(fieldCount * 3);
        const fields: FieldLayout[] = [];
        for (let i = 0; i < fieldCount; i += 1, at += 3) {
          const size = view.getUint8(at + 1);
          const known = BASE_TYPE_BY_NUMBER[view.getUint8(at + 2) & 0x1f];
          // A size that is not a whole number of elements is read as bytes, as the spec says.
          const type = known && size % known.size === 0 ? known : BYTE;
          fields.push({ num: view.getUint8(at), size, type });
        }
        const developerFields: DeveloperFieldLayout[] = [];
        if ((recordHeader & DEVELOPER_DATA_FLAG) !== 0) {
          need(1);
          const count = view.getUint8(at);
          at += 1;
          need(count * 3);
          for (let i = 0; i < count; i += 1, at += 3) {
            developerFields.push({
              num: view.getUint8(at),
              size: view.getUint8(at + 1),
              developerDataIndex: view.getUint8(at + 2),
            });
          }
        }
        definitions.set(recordHeader & 0x0f, {
          num,
          littleEndian,
          fields,
          developerFields,
          profile: PROFILE_BY_NUMBER.get(num),
        });
        continue;
      }

      const compressed = (recordHeader & COMPRESSED_HEADER) !== 0;
      const localType = compressed ? (recordHeader >> 5) & 0x03 : recordHeader & 0x0f;
      const definition = definitions.get(localType);
      if (definition === undefined) {
        diagnostics.push({
          severity: 'error',
          code: 'undefined-local-type',
          message: `A data message of local type ${localType} comes before any definition of it.`,
          offset: recordStart,
        });
        return { ok: false, diagnostics };
      }
      const fields: Record<number, DecodedFitField> = {};
      const profileFields = new Map(definition.profile?.fields.map((f) => [f.num, f]));
      for (const layout of definition.fields) {
        need(layout.size);
        const value = readField(bytes, view, at, layout, definition.littleEndian);
        at += layout.size;
        if (value === undefined) {
          continue;
        }
        const profile = profileFields.get(layout.num);
        const scaled = scaledValue(value, profile);
        fields[layout.num] = {
          num: layout.num,
          ...(profile ? { name: profile.name } : {}),
          baseType: layout.type.name,
          value,
          ...(scaled === undefined ? {} : { scaled }),
        };
        if (layout.num === TIMESTAMP_FIELD && typeof value === 'number') {
          lastTimestamp = value;
        }
      }
      const developerFields: DecodedFitDeveloperField[] = [];
      for (const layout of definition.developerFields) {
        need(layout.size);
        developerFields.push({
          developerDataIndex: layout.developerDataIndex,
          num: layout.num,
          bytes: bytes.slice(at, at + layout.size),
        });
        at += layout.size;
      }
      if (compressed) {
        // Five bits of seconds after the last full timestamp, rolling over every 32 s.
        const offset = recordHeader & 0x1f;
        const base = lastTimestamp ?? 0;
        let timestamp = (base & ~0x1f) + offset;
        if (offset < (base & 0x1f)) {
          timestamp += 0x20;
        }
        timestamp >>>= 0;
        lastTimestamp = timestamp;
        fields[TIMESTAMP_FIELD] = {
          num: TIMESTAMP_FIELD,
          name: 'timestamp',
          baseType: 'uint32',
          value: timestamp,
        };
      }
      messages.push({
        num: definition.num,
        ...(definition.profile ? { name: definition.profile.name } : {}),
        localType,
        fields,
        developerFields,
        ...(compressed ? { compressedTimestamp: true } : {}),
      });
    }
  } catch (error) {
    if (!(error instanceof Truncated)) {
      throw error;
    }
    diagnostics.push({
      severity: 'error',
      code: 'truncated',
      message: 'A message runs past the end of the data the header announces.',
      offset: at,
    });
    return { ok: false, diagnostics };
  }
  return { ok: true, header: head, messages, diagnostics };
}

/** The value of a message's field by number, or undefined when it is absent or invalid. */
export function fitField(message: DecodedFitMessage, num: number): FitValue | undefined {
  return message.fields[num]?.value;
}
