// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  decodeControlPointResponse,
  encodeRequestControl,
  encodeSetTargetPower,
} from '../src/decoders/ftms-control-point.ts';
import { parseHeartRateMeasurement } from '../src/decoders/heart-rate.ts';
import { decodeZwiftRidePacket } from '../src/decoders/zwift-ride.ts';

describe('heart rate (0x2A37)', () => {
  it('reads UINT8 and UINT16 heart rate values and RR intervals', () => {
    expect(parseHeartRateMeasurement(new Uint8Array([0x06, 0x48]))).toMatchObject({
      bpm: 72,
      contactDetected: true,
    });
    expect(parseHeartRateMeasurement(new Uint8Array([0x01, 0x2c, 0x01])).bpm).toBe(300);
    expect(parseHeartRateMeasurement(new Uint8Array([0x10, 0x50, 0x00, 0x04])).rrIntervalsMs).toEqual([1000]);
  });

  it('rejects packets too short to hold a value', () => {
    expect(() => parseHeartRateMeasurement(new Uint8Array([0x00]))).toThrow(RangeError);
  });
});

describe('FTMS control point (0x2AD9)', () => {
  it('encodes request control and set target power', () => {
    expect([...encodeRequestControl()]).toEqual([0x00]);
    expect([...encodeSetTargetPower(150)]).toEqual([0x05, 0x96, 0x00]);
  });

  it('decodes response indications', () => {
    expect(decodeControlPointResponse(new Uint8Array([0x80, 0x05, 0x01]))).toEqual({
      requestOpCode: 0x05,
      resultCode: 0x01,
      result: 'success',
    });
    expect(decodeControlPointResponse(new Uint8Array([0x80, 0x00, 0x05]))?.result).toBe('control not permitted');
    expect(decodeControlPointResponse(new Uint8Array([0x05]))).toBeUndefined();
  });
});

describe('Zwift Ride', () => {
  it('decodes pressed buttons from a 0x23 keypad packet (inverse logic)', () => {
    // field 1 varint = 0xfffe: every bit set except D-Pad Left -> D-Pad Left pressed.
    const packet = new Uint8Array([0x23, 0x08, 0xfe, 0xff, 0x03]);
    expect(decodeZwiftRidePacket(packet)).toEqual({ type: 'keypad', pressed: ['LEFT'] });
  });

  it('treats an all-released keypad packet as no buttons pressed', () => {
    const packet = new Uint8Array([0x23, 0x08, 0xff, 0xff, 0xff, 0xff, 0x0f]);
    expect(decodeZwiftRidePacket(packet)).toEqual({ type: 'keypad', pressed: [] });
  });

  it('recognizes handshake echo, heartbeat and battery packets', () => {
    expect(decodeZwiftRidePacket(new Uint8Array([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e]))).toEqual({
      type: 'handshake',
    });
    expect(decodeZwiftRidePacket(new Uint8Array([0x15]))).toEqual({ type: 'heartbeat' });
    expect(decodeZwiftRidePacket(new Uint8Array([0x19, 0x08, 0x5a]))).toEqual({
      type: 'battery',
      percent: 90,
    });
    expect(decodeZwiftRidePacket(new Uint8Array([0x2a, 0x08]))).toEqual({ type: 'other', opcode: 0x2a });
  });
});
