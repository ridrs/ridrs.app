// SPDX-License-Identifier: AGPL-3.0-or-later

/** Standard BLE Cycling Power Service (0x1818) & Characteristic (0x2A63) */
export const CYCLING_POWER_SERVICE_UUID = 0x1818;
export const CYCLING_POWER_MEASUREMENT_CHAR_UUID = 0x2a63;

/** Standard BLE Fitness Machine Service (FTMS 0x1826), Indoor Bike Data (0x2AD2), Control Point (0x2AD9) */
export const FTMS_SERVICE_UUID = 0x1826;
export const FTMS_INDOOR_BIKE_DATA_CHAR_UUID = 0x2ad2;
export const FTMS_CONTROL_POINT_CHAR_UUID = 0x2ad9;

export interface PowerTrainerTelemetry {
  source: 'cps-0x2a63' | 'ftms-0x2ad2';
  powerWatts: number;
  cadenceRpm?: number;
  speedKph?: number;
  pedalBalancePct?: number;
  accumulatedEnergyKj?: number;
  crankRevolutions?: number;
  lastCrankEventTime1024?: number;
}

export interface CrankSampleState {
  revs: number;
  time1024: number;
}

/**
 * Parses a standard BLE Cycling Power Measurement (0x2A63) packet.
 *
 * Flags (uint16 LE at offset 0):
 * - Bit 0 (0x0001): Pedal Power Balance Present (uint8, 0.5% resolution)
 * - Bit 2 (0x0004): Accumulated Torque Present (uint16 LE, 1/32 Nm)
 * - Bit 4 (0x0010): Wheel Revolution Data Present (uint32 revs + uint16 time 1/2048s = 6 bytes)
 * - Bit 5 (0x0020): Crank Revolution Data Present (uint16 revs + uint16 time 1/1024s = 4 bytes)
 */
export function parseCyclingPowerMeasurement(
  data: DataView,
  prevCrank?: CrankSampleState | null,
): { telemetry: PowerTrainerTelemetry; nextCrank: CrankSampleState | null } {
  if (data.byteLength < 4) {
    throw new RangeError(
      `Invalid Cycling Power Measurement (0x2A63): expected >= 4 bytes, got ${data.byteLength}`,
    );
  }

  const flags = data.getUint16(0, true);
  const powerWatts = Math.max(0, data.getInt16(2, true));
  let offset = 4;

  let pedalBalancePct: number | undefined;
  if ((flags & 0x0001) !== 0 && offset + 1 <= data.byteLength) {
    pedalBalancePct = data.getUint8(offset) / 2;
    offset += 1;
  }

  // Accumulated Torque (2 bytes)
  if ((flags & 0x0004) !== 0) {
    offset += 2;
  }

  // Wheel Revolution Data (6 bytes: uint32 wheel revs + uint16 wheel event time)
  if ((flags & 0x0010) !== 0) {
    offset += 6;
  }

  let crankRevolutions: number | undefined;
  let lastCrankEventTime1024: number | undefined;
  let cadenceRpm: number | undefined;
  let nextCrank: CrankSampleState | null = prevCrank ?? null;

  // Crank Revolution Data (4 bytes: uint16 crank revs + uint16 last crank event time in 1/1024s)
  if ((flags & 0x0020) !== 0 && offset + 4 <= data.byteLength) {
    crankRevolutions = data.getUint16(offset, true);
    lastCrankEventTime1024 = data.getUint16(offset + 2, true);
    offset += 4;

    if (prevCrank) {
      const deltaRevs = (crankRevolutions - prevCrank.revs) & 0xffff;
      const deltaTime1024 = (lastCrankEventTime1024 - prevCrank.time1024) & 0xffff;
      if (deltaRevs > 0 && deltaTime1024 > 0) {
        const rpm = Math.round((deltaRevs * 1024 * 60) / deltaTime1024);
        if (rpm >= 0 && rpm <= 240) {
          cadenceRpm = rpm;
        }
      } else if (deltaRevs === 0 && deltaTime1024 === 0) {
        cadenceRpm = 0;
      }
    }

    nextCrank = {
      revs: crankRevolutions,
      time1024: lastCrankEventTime1024,
    };
  }

  return {
    telemetry: {
      source: 'cps-0x2a63',
      powerWatts,
      cadenceRpm,
      pedalBalancePct,
      crankRevolutions,
      lastCrankEventTime1024,
    },
    nextCrank,
  };
}

/**
 * Parses a standard BLE FTMS Indoor Bike Data (0x2AD2) packet.
 *
 * Flags (uint16 LE at offset 0):
 * - Bit 0 (0x0001): More Data (0 = Instantaneous Speed present at uint16 LE, 0.01 km/h)
 * - Bit 1 (0x0002): Average Speed present (uint16 LE)
 * - Bit 2 (0x0004): Instantaneous Cadence present (uint16 LE, 0.5 rpm)
 * - Bit 3 (0x0008): Average Cadence present (uint16 LE)
 * - Bit 4 (0x0010): Total Distance present (uint24 LE = 3 bytes)
 * - Bit 5 (0x0020): Resistance Level present (int16 LE)
 * - Bit 6 (0x0040): Instantaneous Power present (int16 LE, Watts)
 * - Bit 7 (0x0080): Average Power present (int16 LE)
 * - Bit 8 (0x0100): Expended Energy present (uint16 total + uint16/hr + uint8/min = 5 bytes)
 */
export function parseFtmsIndoorBikeData(data: DataView): PowerTrainerTelemetry {
  if (data.byteLength < 2) {
    throw new RangeError(
      `Invalid FTMS Indoor Bike Data (0x2AD2): expected >= 2 bytes, got ${data.byteLength}`,
    );
  }

  const flags = data.getUint16(0, true);
  let offset = 2;

  let speedKph: number | undefined;
  let cadenceRpm: number | undefined;
  let powerWatts = 0;
  let accumulatedEnergyKj: number | undefined;

  // Bit 0 == 0 means Instantaneous Speed is present (uint16 LE, 0.01 km/h)
  if ((flags & 0x0001) === 0 && offset + 2 <= data.byteLength) {
    speedKph = Math.round(data.getUint16(offset, true)) / 100;
    offset += 2;
  }

  // Bit 1: Average Speed (2 bytes)
  if ((flags & 0x0002) !== 0) {
    offset += 2;
  }

  // Bit 2: Instantaneous Cadence (uint16 LE, 0.5 RPM)
  if ((flags & 0x0004) !== 0 && offset + 2 <= data.byteLength) {
    cadenceRpm = Math.round(data.getUint16(offset, true) / 2);
    offset += 2;
  }

  // Bit 3: Average Cadence (2 bytes)
  if ((flags & 0x0008) !== 0) {
    offset += 2;
  }

  // Bit 4: Total Distance (uint24 = 3 bytes)
  if ((flags & 0x0010) !== 0) {
    offset += 3;
  }

  // Bit 5: Resistance Level (int16 = 2 bytes)
  if ((flags & 0x0020) !== 0) {
    offset += 2;
  }

  // Bit 6: Instantaneous Power (int16 LE, Watts)
  if ((flags & 0x0040) !== 0 && offset + 2 <= data.byteLength) {
    powerWatts = Math.max(0, data.getInt16(offset, true));
    offset += 2;
  }

  // Bit 7: Average Power (2 bytes)
  if ((flags & 0x0080) !== 0) {
    offset += 2;
  }

  // Bit 8: Expended Energy (5 bytes: uint16 total kJ, uint16 kJ/hr, uint8 kJ/min)
  if ((flags & 0x0100) !== 0 && offset + 2 <= data.byteLength) {
    accumulatedEnergyKj = data.getUint16(offset, true);
  }

  return {
    source: 'ftms-0x2ad2',
    powerWatts,
    cadenceRpm,
    speedKph,
    accumulatedEnergyKj,
  };
}

/**
 * Encodes a synthetic FTMS Indoor Bike Data (0x2AD2) packet with Speed, Cadence, and Power.
 */
export function encodeFtmsIndoorBikeData(
  powerWatts: number,
  cadenceRpm: number,
  speedKph: number,
): DataView {
  // Flags: Bit 0 = 0 (Speed present), Bit 2 = 1 (0x0004 Cadence present), Bit 6 = 1 (0x0040 Power present)
  const flags = 0x0004 | 0x0040;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint16(0, flags, true);
  view.setUint16(2, Math.max(0, Math.round(speedKph * 100)), true);
  view.setUint16(4, Math.max(0, Math.round(cadenceRpm * 2)), true);
  view.setInt16(6, Math.max(0, Math.round(powerWatts)), true);
  return view;
}

/**
 * Encodes FTMS Control Point (0x2AD9) Request Control command (`0x00`).
 */
export function encodeFtmsRequestControl(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0x00]);
}

/**
 * Encodes FTMS Control Point (0x2AD9) Set Target Power (`0x05`) command in Watts (sint16 LE).
 */
export function encodeFtmsSetTargetPower(targetWatts: number): Uint8Array<ArrayBuffer> {
  const clamped = Math.max(0, Math.min(2000, Math.round(targetWatts)));
  const buf = new ArrayBuffer(3);
  const view = new DataView(buf);
  view.setUint8(0, 0x05);
  view.setInt16(1, clamped, true);
  return new Uint8Array(buf);
}
