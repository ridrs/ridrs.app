// SPDX-License-Identifier: AGPL-3.0-or-later

import { bytesToHex, hexToBytes } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import {
  encodeCommand,
  parseFeatures,
  parsePowerRange,
  parseResponse,
  quantized,
} from './control-point.ts';

const hex = (bytes: Uint8Array) => bytesToHex(bytes);

describe('control point commands (FTMS 1.0, 4.16.2)', () => {
  it('Request Control and Start or Resume are their op codes alone', () => {
    expect(hex(encodeCommand({ kind: 'request-control' }))).toBe('00');
    expect(hex(encodeCommand({ kind: 'start' }))).toBe('07');
  });

  it('Set Target Power is op code 05 and a little-endian sint16 in W', () => {
    expect(hex(encodeCommand({ kind: 'target-power', watts: 180 }))).toBe('05b400');
    expect(hex(encodeCommand({ kind: 'target-power', watts: 1000 }))).toBe('05e803');
  });

  it('Set Indoor Bike Simulation Parameters: wind 0.001 m/s, grade 0.01 %, Crr 0.0001, Cw 0.01 kg/m', () => {
    const bytes = encodeCommand({
      kind: 'simulation',
      windSpeed: 0,
      gradient: 0.05,
      crr: 0.004,
      cw: 0.392,
    });
    // 5 % = 500 = 0x01f4; Crr 40 = 0x28; Cw 39 = 0x27.
    expect(hex(bytes)).toBe('110000f4012827');
  });

  it('encodes a downhill grade as a signed value', () => {
    const bytes = encodeCommand({ kind: 'simulation', windSpeed: -1.5, gradient: -0.1, crr: 0, cw: 0 });
    // −1500 = 0xfa24, −1000 = 0xfc18.
    expect(hex(bytes)).toBe('1124fa18fc0000');
  });

  it('rounds to the resolution and clamps to the field ranges', () => {
    expect(quantized({ kind: 'simulation', windSpeed: 0, gradient: 0.012345, crr: 0.00444, cw: 3.7 }))
      .toEqual({ kind: 'simulation', windSpeed: 0, gradient: 0.0123, crr: 0.0044, cw: 2.55 });
    expect(hex(encodeCommand({ kind: 'simulation', windSpeed: 0, gradient: 9, crr: 1, cw: -1 }))).toBe(
      '110000ff7fff00',
    );
  });
});

describe('what the trainer says', () => {
  it('reads the power target (bit 3) and simulation (bit 13) target setting features', () => {
    expect(parseFeatures(hexToBytes('0240000008200000'))).toEqual({
      simulation: true,
      targetPower: true,
    });
    expect(parseFeatures(hexToBytes('0240000000200000'))).toEqual({
      simulation: true,
      targetPower: false,
    });
    expect(parseFeatures(hexToBytes('02400000'))).toEqual({
      simulation: false,
      targetPower: false,
    });
  });

  it('reads the supported power range', () => {
    expect(parsePowerRange(hexToBytes('3200e8030100'))).toEqual({ min: 50, max: 1000 });
    expect(parsePowerRange(hexToBytes('32'))).toBeUndefined();
  });

  it('reads a response indication', () => {
    expect(parseResponse(hexToBytes('800001'))).toEqual({
      opCode: 0,
      result: 1,
      resultName: 'Success',
    });
    expect(parseResponse(hexToBytes('801104'))?.resultName).toBe('Operation Failed');
    expect(parseResponse(hexToBytes('0001'))).toBeUndefined();
  });
});
