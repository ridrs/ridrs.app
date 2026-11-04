// SPDX-License-Identifier: AGPL-3.0-or-later

export type SensorContactStatus = 'not-supported' | 'not-detected' | 'detected';

export interface HeartRateMeasurement {
  /** Heart rate in beats per minute (BPM). */
  bpm: number;
  /** Whether the sensor reports skin contact. */
  contactStatus: SensorContactStatus;
  /** Cumulative energy expended in kilojoules (kJ), if reported by the sensor. */
  energyExpendedKj?: number;
  /** Beat-to-beat RR intervals in milliseconds, converted from 1/1024s BLE units. */
  rrIntervalsMs: number[];
}

export interface HeartRateZone {
  zone: 1 | 2 | 3 | 4 | 5;
  name: string;
  color: string;
  percentageOfMax: number;
}

/**
 * Parses a standard BLE Heart Rate Measurement characteristic (UUID 0x2A37) payload.
 *
 * Layout per Bluetooth SIG GATT Specification Supplement:
 * - Byte 0: Flags
 *   - Bit 0: Heart Rate Value Format (0 = UINT8, 1 = UINT16 LE)
 *   - Bits 1..2: Sensor Contact Status (0/1 = not supported, 2 = no contact, 3 = contact)
 *   - Bit 3: Energy Expended field present (UINT16 LE, kJ)
 *   - Bit 4: One or more RR-Interval values present (UINT16 LE, 1/1024 s resolution)
 */
export function parseHeartRateMeasurement(data: DataView): HeartRateMeasurement {
  if (data.byteLength < 2) {
    throw new RangeError(
      `Invalid Heart Rate Measurement packet: expected at least 2 bytes, got ${data.byteLength}`,
    );
  }

  const flags = data.getUint8(0);
  const is16BitHr = (flags & 0x01) !== 0;
  const contactBits = (flags >> 1) & 0x03;
  const hasEnergyExpended = (flags & 0x08) !== 0;
  const hasRrIntervals = (flags & 0x10) !== 0;

  let offset = 1;
  let bpm: number;

  if (is16BitHr) {
    if (data.byteLength < offset + 2) {
      throw new RangeError('Invalid 16-bit Heart Rate Measurement packet length');
    }
    bpm = data.getUint16(offset, true);
    offset += 2;
  } else {
    bpm = data.getUint8(offset);
    offset += 1;
  }

  let contactStatus: SensorContactStatus = 'not-supported';
  if (contactBits === 2) {
    contactStatus = 'not-detected';
  } else if (contactBits === 3) {
    contactStatus = 'detected';
  }

  let energyExpendedKj: number | undefined;
  if (hasEnergyExpended) {
    if (data.byteLength < offset + 2) {
      throw new RangeError('Invalid Energy Expended field in Heart Rate packet');
    }
    energyExpendedKj = data.getUint16(offset, true);
    offset += 2;
  }

  const rrIntervalsMs: number[] = [];
  if (hasRrIntervals) {
    while (offset + 2 <= data.byteLength) {
      const rawRr = data.getUint16(offset, true);
      rrIntervalsMs.push(Math.round((rawRr / 1024) * 1000));
      offset += 2;
    }
  }

  return {
    bpm,
    contactStatus,
    ...(energyExpendedKj !== undefined ? { energyExpendedKj } : {}),
    rrIntervalsMs,
  };
}

/**
 * Encodes a synthetic BLE 0x2A37 packet so simulated sensor readings pass through
 * the exact same binary parser as real BLE hardware notifications.
 */
export function encodeHeartRateMeasurement(
  bpm: number,
  rrIntervalsMs: number[] = [],
  contactDetected = true,
): DataView {
  const is16Bit = bpm > 255;
  let flags = 0;
  if (is16Bit) flags |= 0x01;
  flags |= (contactDetected ? 0x03 : 0x02) << 1;
  if (rrIntervalsMs.length > 0) flags |= 0x10;

  const byteLength = 1 + (is16Bit ? 2 : 1) + rrIntervalsMs.length * 2;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);

  view.setUint8(0, flags);
  let offset = 1;
  if (is16Bit) {
    view.setUint16(offset, bpm, true);
    offset += 2;
  } else {
    view.setUint8(offset, bpm);
    offset += 1;
  }

  for (const rrMs of rrIntervalsMs) {
    const raw1024 = Math.round((rrMs / 1000) * 1024);
    view.setUint16(offset, raw1024, true);
    offset += 2;
  }

  return view;
}

/**
 * Parses BLE Body Sensor Location characteristic (UUID 0x2A38).
 */
export function parseBodySensorLocation(data: DataView): string {
  if (data.byteLength < 1) return 'Unknown';
  const code = data.getUint8(0);
  switch (code) {
    case 0:
      return 'Other';
    case 1:
      return 'Chest';
    case 2:
      return 'Wrist';
    case 3:
      return 'Finger';
    case 4:
      return 'Hand';
    case 5:
      return 'Ear Lobe';
    case 6:
      return 'Foot';
    default:
      return 'Unknown';
  }
}

/**
 * Computes classic 5-zone cycling heart rate zone given current BPM and max HR.
 */
export function computeHeartRateZone(bpm: number, maxHr = 190): HeartRateZone {
  const pct = Math.min(100, Math.max(0, Math.round((bpm / maxHr) * 100)));

  if (pct < 60) {
    return { zone: 1, name: 'Z1 Recovery', color: '#00b4d8', percentageOfMax: pct };
  }
  if (pct < 70) {
    return { zone: 2, name: 'Z2 Endurance', color: '#22c55e', percentageOfMax: pct };
  }
  if (pct < 80) {
    return { zone: 3, name: 'Z3 Tempo', color: '#eab308', percentageOfMax: pct };
  }
  if (pct < 90) {
    return { zone: 4, name: 'Z4 Threshold', color: '#f97316', percentageOfMax: pct };
  }
  return { zone: 5, name: 'Z5 VO2 Max', color: '#ff0055', percentageOfMax: pct };
}
