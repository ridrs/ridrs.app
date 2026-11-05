// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TrainerCommand } from '@ridrs/contracts';

/*
 * The FTMS Fitness Machine Control Point and the characteristics around it, as in the Fitness
 * Machine Service specification 1.0 (Bluetooth SIG, 2017): little-endian fields, op codes of
 * table 4.15, result codes of table 4.24, target setting bits of table 4.4 (ADR 0056).
 */

export const OP_CODES = Object.freeze({
  requestControl: 0x00,
  setTargetPower: 0x05,
  startOrResume: 0x07,
  setIndoorBikeSimulation: 0x11,
  responseCode: 0x80,
});

export const RESULT_SUCCESS = 0x01;

const RESULT_NAMES: Readonly<Record<number, string>> = {
  0x01: 'Success',
  0x02: 'Op Code not supported',
  0x03: 'Invalid Parameter',
  0x04: 'Operation Failed',
  0x05: 'Control Not Permitted',
};

/** FTMS 1.0, 4.3.1.2: Target Setting Features. */
const POWER_TARGET_BIT = 3;
const INDOOR_BIKE_SIMULATION_BIT = 13;

/** What a trainer can be told, from its Fitness Machine Feature characteristic. */
export interface TrainerFeatures {
  readonly simulation: boolean;
  readonly targetPower: boolean;
}

export const NO_FEATURES: TrainerFeatures = Object.freeze({ simulation: false, targetPower: false });

/** Fitness Machine Feature (0x2ACC): uint32 machine features, uint32 target setting features. */
export function parseFeatures(bytes: Uint8Array): TrainerFeatures {
  if (bytes.byteLength < 8) {
    return NO_FEATURES;
  }
  const targets = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  return {
    targetPower: (targets & (1 << POWER_TARGET_BIT)) !== 0,
    simulation: (targets & (1 << INDOOR_BIKE_SIMULATION_BIT)) !== 0,
  };
}

export interface PowerRange {
  readonly min: number;
  readonly max: number;
}

/** Supported Power Range (0x2AD8): sint16 minimum W, sint16 maximum W, uint16 increment W. */
export function parsePowerRange(bytes: Uint8Array): PowerRange | undefined {
  if (bytes.byteLength < 4) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = view.getInt16(0, true);
  const max = view.getInt16(2, true);
  return min <= max ? { min, max } : undefined;
}

/** A control point response indication: `80 <request op code> <result code>`. */
export interface ControlPointResponse {
  readonly opCode: number;
  readonly result: number;
  readonly resultName: string;
}

export function parseResponse(bytes: Uint8Array): ControlPointResponse | undefined {
  if (bytes.byteLength < 3 || bytes[0] !== OP_CODES.responseCode) {
    return undefined;
  }
  const opCode = bytes[1] ?? 0;
  const result = bytes[2] ?? 0;
  return { opCode, result, resultName: RESULT_NAMES[result] ?? `result 0x${result.toString(16)}` };
}

const SINT16 = { min: -32768, max: 32767 } as const;
const UINT8 = { min: 0, max: 255 } as const;

function clampInt(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/**
 * A command as the trainer will apply it: every value at the resolution FTMS carries, so the
 * command published is exactly what the bytes say.
 */
export function quantized(command: TrainerCommand): TrainerCommand {
  if (command.kind === 'target-power') {
    return { kind: 'target-power', watts: clampInt(command.watts, SINT16) };
  }
  if (command.kind !== 'simulation') {
    return command;
  }
  return {
    kind: 'simulation',
    windSpeed: clampInt(command.windSpeed * 1000, SINT16) / 1000,
    gradient: clampInt(command.gradient * 10_000, SINT16) / 10_000,
    crr: clampInt(command.crr * 10_000, UINT8) / 10_000,
    cw: clampInt(command.cw * 100, UINT8) / 100,
  };
}

/** The control point bytes of a command (FTMS 1.0, 4.16.2). */
export function encodeCommand(command: TrainerCommand): Uint8Array {
  switch (command.kind) {
    case 'request-control':
      return new Uint8Array([OP_CODES.requestControl]);
    case 'start':
      return new Uint8Array([OP_CODES.startOrResume]);
    case 'target-power': {
      const bytes = new Uint8Array(3);
      const view = new DataView(bytes.buffer);
      bytes[0] = OP_CODES.setTargetPower;
      // sint16, 1 W.
      view.setInt16(1, clampInt(command.watts, SINT16), true);
      return bytes;
    }
    case 'simulation': {
      const bytes = new Uint8Array(7);
      const view = new DataView(bytes.buffer);
      bytes[0] = OP_CODES.setIndoorBikeSimulation;
      // Wind speed sint16 0.001 m/s, grade sint16 0.01 %, Crr uint8 0.0001, Cw uint8 0.01 kg/m.
      view.setInt16(1, clampInt(command.windSpeed * 1000, SINT16), true);
      view.setInt16(3, clampInt(command.gradient * 10_000, SINT16), true);
      view.setUint8(5, clampInt(command.crr * 10_000, UINT8));
      view.setUint8(6, clampInt(command.cw * 100, UINT8));
      return bytes;
    }
  }
}
