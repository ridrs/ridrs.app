// SPDX-License-Identifier: AGPL-3.0-or-later

export interface FtmsIndoorBikeDataSample {
  readonly powerWatts?: number;
  readonly cadenceRpm?: number;
}

export type FtmsParseResult =
  | { readonly ok: true; readonly data: FtmsIndoorBikeDataSample }
  | { readonly ok: false; readonly reason: string };

interface FieldLayout {
  readonly bit: number;
  readonly name: string;
  readonly size: number;
  /** FTMS "More Data" (bit 0) is inverted: the speed field is present when the bit is 0. */
  readonly presentWhen: 0 | 1;
}

/** Bluetooth SIG FTMS Indoor Bike Data (0x2AD2) fields in flag-bit order, little-endian. */
const FIELDS: readonly FieldLayout[] = [
  { bit: 0, name: 'Instantaneous Speed', size: 2, presentWhen: 0 },
  { bit: 1, name: 'Average Speed', size: 2, presentWhen: 1 },
  { bit: 2, name: 'Instantaneous Cadence', size: 2, presentWhen: 1 },
  { bit: 3, name: 'Average Cadence', size: 2, presentWhen: 1 },
  { bit: 4, name: 'Total Distance', size: 3, presentWhen: 1 },
  { bit: 5, name: 'Resistance Level', size: 2, presentWhen: 1 },
  { bit: 6, name: 'Instantaneous Power', size: 2, presentWhen: 1 },
  { bit: 7, name: 'Average Power', size: 2, presentWhen: 1 },
  { bit: 8, name: 'Expended Energy', size: 5, presentWhen: 1 },
  { bit: 9, name: 'Heart Rate', size: 1, presentWhen: 1 },
  { bit: 10, name: 'Metabolic Equivalent', size: 1, presentWhen: 1 },
  { bit: 11, name: 'Elapsed Time', size: 2, presentWhen: 1 },
  { bit: 12, name: 'Remaining Time', size: 2, presentWhen: 1 },
];

const FLAGS_SIZE = 2;

/**
 * Parses an FTMS Indoor Bike Data notification. Only power and cadence are extracted;
 * all other present fields are skipped by size so the following fields stay aligned.
 * Cadence has a resolution of 0.5 rpm, power is a signed 16-bit value in watts.
 */
export function parseFtmsIndoorBikeData(packet: Uint8Array): FtmsParseResult {
  if (packet.byteLength < FLAGS_SIZE) {
    return {
      ok: false,
      reason: `Packet too short for FTMS flags: expected at least ${FLAGS_SIZE} bytes, got ${packet.byteLength}`,
    };
  }

  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const flags = view.getUint16(0, true);
  let offset = FLAGS_SIZE;
  let powerWatts: number | undefined;
  let cadenceRpm: number | undefined;

  for (const field of FIELDS) {
    if (((flags >> field.bit) & 1) !== field.presentWhen) {
      continue;
    }
    if (offset + field.size > packet.byteLength) {
      return { ok: false, reason: `Truncated at ${field.name} field` };
    }
    if (field.bit === 2) {
      cadenceRpm = view.getUint16(offset, true) * 0.5;
    } else if (field.bit === 6) {
      powerWatts = view.getInt16(offset, true);
    }
    offset += field.size;
  }

  return { ok: true, data: { powerWatts, cadenceRpm } };
}
