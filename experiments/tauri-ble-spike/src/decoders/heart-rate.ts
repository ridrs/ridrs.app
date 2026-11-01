// SPDX-License-Identifier: AGPL-3.0-or-later

/** Heart Rate Service (0x180D) / Heart Rate Measurement (0x2A37). */
export const HEART_RATE_SERVICE_UUID = '180d';
export const HEART_RATE_MEASUREMENT_UUID = '2a37';

export interface HeartRateMeasurement {
  readonly bpm: number;
  /** `undefined` when the sensor does not support contact detection. */
  readonly contactDetected: boolean | undefined;
  readonly rrIntervalsMs: readonly number[];
}

/**
 * Parses a Heart Rate Measurement notification (Bluetooth SIG GATT Specification Supplement).
 * Ported from `experiments/hr-monitor-osx/src/hr-parser.ts`, trimmed to what the spike shows.
 * Flags: bit 0 = UINT16 value, bits 1-2 = contact status, bit 3 = energy expended, bit 4 = RR intervals.
 */
export function parseHeartRateMeasurement(packet: Uint8Array): HeartRateMeasurement {
  if (packet.byteLength < 2) {
    throw new RangeError(`Heart Rate Measurement too short: ${packet.byteLength} bytes`);
  }
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const flags = view.getUint8(0);
  let offset = 1;

  let bpm: number;
  if (flags & 0x01) {
    if (packet.byteLength < 3) {
      throw new RangeError('Heart Rate Measurement truncated at UINT16 value');
    }
    bpm = view.getUint16(offset, true);
    offset += 2;
  } else {
    bpm = view.getUint8(offset);
    offset += 1;
  }

  const contactBits = (flags >> 1) & 0x03;
  const contactDetected = contactBits === 3 ? true : contactBits === 2 ? false : undefined;

  if (flags & 0x08) {
    offset += 2;
  }

  const rrIntervalsMs: number[] = [];
  if (flags & 0x10) {
    while (offset + 2 <= packet.byteLength) {
      rrIntervalsMs.push(Math.round((view.getUint16(offset, true) / 1024) * 1000));
      offset += 2;
    }
  }

  return { bpm, contactDetected, rrIntervalsMs };
}
