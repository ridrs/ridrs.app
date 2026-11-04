// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeHeartRateZone,
  encodeHeartRateMeasurement,
  parseBodySensorLocation,
  parseHeartRateMeasurement,
} from './hr-parser';
import {
  encodeFtmsIndoorBikeData,
  encodeFtmsSetTargetPower,
  parseCyclingPowerMeasurement,
  parseFtmsIndoorBikeData,
} from './power-trainer-parser';
import {
  RIDE_ON_HANDSHAKE,
  ZWIFT_RIDE_BUTTONS,
  computeSteeringAndBraking,
  decodeZigZag32,
  encodeZigZag32,
  encodeZwiftRideKeyPadPacket,
  mergeControllerAnalogStates,
  parseZwiftRidePacket,
} from './zwift-ride-parser';

describe('BLE Heart Rate Measurement Parser (0x2A37)', () => {
  it('parses an 8-bit BPM packet with sensor contact detected and RR intervals', () => {
    const bytes = new Uint8Array([0x16, 142, 0xd0, 0x02]);
    const result = parseHeartRateMeasurement(new DataView(bytes.buffer));

    assert.equal(result.bpm, 142);
    assert.equal(result.contactStatus, 'detected');
    assert.equal(result.energyExpendedKj, undefined);
    assert.deepEqual(result.rrIntervalsMs, [703]);
  });

  it('parses a 16-bit BPM packet with energy expended', () => {
    const buffer = new ArrayBuffer(5);
    const view = new DataView(buffer);
    view.setUint8(0, 0x0d);
    view.setUint16(1, 260, true);
    view.setUint16(3, 450, true);

    const result = parseHeartRateMeasurement(view);
    assert.equal(result.bpm, 260);
    assert.equal(result.contactStatus, 'not-detected');
    assert.equal(result.energyExpendedKj, 450);
    assert.deepEqual(result.rrIntervalsMs, []);
  });

  it('round-trips encoded heart rate packets accurately', () => {
    const view = encodeHeartRateMeasurement(165, [364], true);
    const parsed = parseHeartRateMeasurement(view);

    assert.equal(parsed.bpm, 165);
    assert.equal(parsed.contactStatus, 'detected');
    assert.equal(parsed.rrIntervalsMs.length, 1);
    assert.ok(Math.abs(parsed.rrIntervalsMs[0] - 364) <= 1);
  });

  it('parses body sensor location codes (0x2A38)', () => {
    assert.equal(parseBodySensorLocation(new DataView(new Uint8Array([1]).buffer)), 'Chest');
    assert.equal(parseBodySensorLocation(new DataView(new Uint8Array([2]).buffer)), 'Wrist');
  });

  it('computes 5-zone cycling heart rate zones', () => {
    assert.equal(computeHeartRateZone(100, 190).zone, 1);
    assert.equal(computeHeartRateZone(125, 190).zone, 2);
    assert.equal(computeHeartRateZone(145, 190).zone, 3);
    assert.equal(computeHeartRateZone(165, 190).zone, 4);
    assert.equal(computeHeartRateZone(180, 190).zone, 5);
  });
});

describe('Zwift Ride & Play Controller Protocol Parser (0xFC82 / 0x23 & 0x07 Protobuf)', () => {
  it('recognizes the RideOn ASCII handshake packet', () => {
    const view = new DataView(RIDE_ON_HANDSHAKE.buffer);
    const parsed = parseZwiftRidePacket(view);
    assert.equal(parsed.type, 'handshake');
  });

  it('round-trips ZigZag sint32 encoding for analog steering/braking paddles', () => {
    for (const sample of [-100, -45, -1, 0, 1, 62, 100]) {
      assert.equal(decodeZigZag32(encodeZigZag32(sample)), sample);
    }
  });

  it('accurately round-trips every single button across all 4 nibbles (bits 0..15) in 0x23 packets', () => {
    for (const btn of ZWIFT_RIDE_BUTTONS) {
      const packet = encodeZwiftRideKeyPadPacket([btn.id], 0, 0);
      const parsed = parseZwiftRidePacket(packet);
      assert.equal(parsed.type, 'keypad');
      if (parsed.type === 'keypad') {
        assert.deepEqual(
          parsed.pressedButtons.map((b) => b.id),
          [btn.id],
          `Expected button ${btn.id} (mask 0x${btn.mask.toString(16)}) to round-trip cleanly`,
        );
      }
    }
  });

  it('decodes raw wire varint bytes without continuation-bit shift errors (Z, Shift, PowerUp, On/Off)', () => {
    // On the wire, `23 08 ff fe ff ff 0f` has bit 0 of varint byte 1 cleared -> decoded bit 7 (0x0080) = Z
    const zWireBytes = new Uint8Array([0x23, 0x08, 0xff, 0xfe, 0xff, 0xff, 0x0f]);
    const parsedZ = parseZwiftRidePacket(new DataView(zWireBytes.buffer));
    assert.equal(parsedZ.type, 'keypad');
    if (parsedZ.type === 'keypad') {
      assert.deepEqual(
        parsedZ.pressedButtons.map((b) => b.id),
        ['Z'],
      );
    }

    // On the wire, `23 08 ff fd ff ff 0f` has bit 1 of varint byte 1 cleared -> decoded bit 8 (0x0100) = SHIFT_UP_L
    const shiftUpLWireBytes = new Uint8Array([0x23, 0x08, 0xff, 0xfd, 0xff, 0xff, 0x0f]);
    const parsedShiftUpL = parseZwiftRidePacket(new DataView(shiftUpLWireBytes.buffer));
    assert.equal(parsedShiftUpL.type, 'keypad');
    if (parsedShiftUpL.type === 'keypad') {
      assert.deepEqual(
        parsedShiftUpL.pressedButtons.map((b) => b.id),
        ['SHIFT_UP_L'],
      );
    }

    // On the wire, `23 08 ff ff fd ff 0f` has bit 1 of varint byte 2 cleared -> decoded bit 15 (0x8000) = ON_OFF_R
    const onOffRWireBytes = new Uint8Array([0x23, 0x08, 0xff, 0xff, 0xfd, 0xff, 0x0f]);
    const parsedOnOffR = parseZwiftRidePacket(new DataView(onOffRWireBytes.buffer));
    assert.equal(parsedOnOffR.type, 'keypad');
    if (parsedOnOffR.type === 'keypad') {
      assert.deepEqual(
        parsedOnOffR.pressedButtons.map((b) => b.id),
        ['ON_OFF_R'],
      );
    }
  });

  it('decodes 0x07 Zwift Play packets for both Left and Right standalone controllers', () => {
    // Example from Makinolo's Zwift Play spec:
    // 07 (opcode) | 08 00 (Right pad) | 10 01 | 18 01 | 20 00 (Button A pressed) | 28 01 | 30 01 | 38 00 (Right Shifter pressed) | 40 64 (Steer +50 ZigZag=100=0x64) | 48 00
    const rightPlayBytes = new Uint8Array([
      0x07, 0x08, 0x00, 0x10, 0x01, 0x18, 0x01, 0x20, 0x00, 0x28, 0x01, 0x30, 0x01, 0x38, 0x00,
      0x40, 0x64, 0x48, 0x00,
    ]);
    const parsedRight = parseZwiftRidePacket(new DataView(rightPlayBytes.buffer), 'right');
    assert.equal(parsedRight.type, 'keypad');
    if (parsedRight.type === 'keypad') {
      assert.equal(parsedRight.controllerSide, 'right');
      assert.deepEqual(
        parsedRight.pressedButtons.map((b) => b.id),
        ['A', 'SHIFT_UP_R'],
      );
      assert.equal(parsedRight.analog.rightPaddle, -50);
    }
  });

  it('decodes captured physical Zwift Ride 0x23 Field 3 (0x1a) left and right paddle packets', () => {
    // 1. Left Paddle full right/inward (+100, captured line 451):
    // 23 08 ff ff ff ff 0f 1a 05 08 00 10 c8 01 1a 04 08 01 10 00 1a 04 08 02 10 00 1a 04 08 03 10 00
    const leftRightBytes = new Uint8Array([
      0x23, 0x08, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x1a, 0x05, 0x08, 0x00, 0x10, 0xc8, 0x01, 0x1a,
      0x04, 0x08, 0x01, 0x10, 0x00, 0x1a, 0x04, 0x08, 0x02, 0x10, 0x00, 0x1a, 0x04, 0x08, 0x03,
      0x10, 0x00,
    ]);
    const parsedLeftRight = parseZwiftRidePacket(new DataView(leftRightBytes.buffer), 'left');
    assert.equal(parsedLeftRight.type, 'keypad');
    if (parsedLeftRight.type === 'keypad') {
      assert.equal(parsedLeftRight.analog.leftPaddle, 100);
      assert.equal(parsedLeftRight.analog.rightPaddle, 0);
    }

    // 2. Left Paddle full left/outward (-100, captured line 460):
    // 23 08 ff ff ff ff 0f 1a 05 08 00 10 c7 01 1a 04 08 01 10 00 1a 04 08 02 10 00 1a 04 08 03 10 00
    const leftLeftBytes = new Uint8Array([
      0x23, 0x08, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x1a, 0x05, 0x08, 0x00, 0x10, 0xc7, 0x01, 0x1a,
      0x04, 0x08, 0x01, 0x10, 0x00, 0x1a, 0x04, 0x08, 0x02, 0x10, 0x00, 0x1a, 0x04, 0x08, 0x03,
      0x10, 0x00,
    ]);
    const parsedLeftLeft = parseZwiftRidePacket(new DataView(leftLeftBytes.buffer), 'left');
    assert.equal(parsedLeftLeft.type, 'keypad');
    if (parsedLeftLeft.type === 'keypad') {
      assert.equal(parsedLeftLeft.analog.leftPaddle, -100);
      assert.equal(parsedLeftLeft.analog.rightPaddle, 0);
    }

    // 3. Right Paddle full left/inward (-100, captured line 476):
    // 23 08 ff ff ff ff 0f 1a 04 08 00 10 00 1a 05 08 01 10 c7 01
    const rightLeftBytes = new Uint8Array([
      0x23, 0x08, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x1a, 0x04, 0x08, 0x00, 0x10, 0x00, 0x1a, 0x05,
      0x08, 0x01, 0x10, 0xc7, 0x01,
    ]);
    const parsedRightLeft = parseZwiftRidePacket(new DataView(rightLeftBytes.buffer), 'right');
    assert.equal(parsedRightLeft.type, 'keypad');
    if (parsedRightLeft.type === 'keypad') {
      assert.equal(parsedRightLeft.analog.rightPaddle, -100);
      assert.equal(parsedRightLeft.analog.leftPaddle, 0);
    }

    // 4. Right Paddle full right/outward (+100, captured line 491):
    // 23 08 ff ff ff ff 0f 1a 04 08 00 10 00 1a 05 08 01 10 c8 01
    const rightRightBytes = new Uint8Array([
      0x23, 0x08, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x1a, 0x04, 0x08, 0x00, 0x10, 0x00, 0x1a, 0x05,
      0x08, 0x01, 0x10, 0xc8, 0x01,
    ]);
    const parsedRightRight = parseZwiftRidePacket(new DataView(rightRightBytes.buffer), 'right');
    assert.equal(parsedRightRight.type, 'keypad');
    if (parsedRightRight.type === 'keypad') {
      assert.equal(parsedRightRight.analog.rightPaddle, 100);
      assert.equal(parsedRightRight.analog.leftPaddle, 0);
    }
  });

  it('decodes opcode 0x19 periodic battery notifications (e.g. 19 10 50 -> 80%)', () => {
    const batBytes = new Uint8Array([0x19, 0x10, 0x50]);
    const parsedBat = parseZwiftRidePacket(new DataView(batBytes.buffer), 'left');
    assert.equal(parsedBat.type, 'battery');
    if (parsedBat.type === 'battery') {
      assert.equal(parsedBat.batteryPercent, 80);
    }
  });

  it('merges analog paddle states from simultaneous Left (4-axis) and Right (2-axis) controllers', () => {
    const leftState = computeSteeringAndBraking(-75, 0, { 2: 0, 3: 0 });
    const rightState = computeSteeringAndBraking(0, -60, {});
    const merged = mergeControllerAnalogStates(leftState, rightState);

    assert.equal(merged.leftPaddle, -75);
    assert.equal(merged.rightPaddle, -60);
  });

  it('preserves bridged rightPaddle (+100/-100) from a 4-axis controller even when the other slot reports 0', () => {
    // Real captured packet from Zwift Ride when Right Paddle is moved right (+100):
    // 23 08 ff ff ff ff 0f 12 19 0a 04 08 00 10 00 0a 05 08 01 10 c8 01 0a 04 08 02 10 00 0a 04 08 03 10 00
    const rightMovedBytes = new Uint8Array([
      0x23, 0x08, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x12, 0x19, 0x0a, 0x04, 0x08, 0x00, 0x10, 0x00,
      0x0a, 0x05, 0x08, 0x01, 0x10, 0xc8, 0x01, 0x0a, 0x04, 0x08, 0x02, 0x10, 0x00, 0x0a, 0x04,
      0x08, 0x03, 0x10, 0x00,
    ]);
    const parsedLeftSlot = parseZwiftRidePacket(new DataView(rightMovedBytes.buffer));
    assert.equal(parsedLeftSlot.type, 'keypad');
    if (parsedLeftSlot.type !== 'keypad') return;
    assert.equal(parsedLeftSlot.analog.rightPaddle, 100);

    const idleRightSlot = {
      leftPaddle: 0,
      rightPaddle: 0,
      extraAxes: {},
      steeringPct: 0,
      leftBrakingPct: 0,
      rightBrakingPct: 0,
      brakingPct: 0,
    };

    const merged = mergeControllerAnalogStates(parsedLeftSlot.analog, idleRightSlot);
    assert.equal(merged.rightPaddle, 100);
    assert.equal(merged.leftPaddle, 0);
  });
});

describe('BLE Power Meter (0x2A63) & FTMS Smart Trainer (0x2AD2 / 0x2AD9) Parser', () => {
  it('round-trips FTMS Indoor Bike Data (0x2AD2) with power, cadence, and speed', () => {
    const packet = encodeFtmsIndoorBikeData(245, 92, 34.6);
    const parsed = parseFtmsIndoorBikeData(packet);

    assert.equal(parsed.source, 'ftms-0x2ad2');
    assert.equal(parsed.powerWatts, 245);
    assert.equal(parsed.cadenceRpm, 92);
    assert.equal(parsed.speedKph, 34.6);
  });

  it('parses Cycling Power Measurement (0x2A63) with pedal balance and crank cadence', () => {
    // Flags: 0x0021 (Bit 0 = Pedal Balance, Bit 5 = Crank Revolution Data)
    const buf1 = new ArrayBuffer(9);
    const view1 = new DataView(buf1);
    view1.setUint16(0, 0x0021, true);
    view1.setInt16(2, 280, true); // 280W
    view1.setUint8(4, 102); // 51.0% balance
    view1.setUint16(5, 100, true); // 100 crank revs
    view1.setUint16(7, 1024, true); // 1.0s

    const sample1 = parseCyclingPowerMeasurement(view1, null);
    assert.equal(sample1.telemetry.powerWatts, 280);
    assert.equal(sample1.telemetry.pedalBalancePct, 51);

    // 2nd sample: +3 revs over +2048 ticks (2.0s) -> 90 RPM
    const buf2 = new ArrayBuffer(9);
    const view2 = new DataView(buf2);
    view2.setUint16(0, 0x0021, true);
    view2.setInt16(2, 295, true);
    view2.setUint8(4, 100); // 50.0%
    view2.setUint16(5, 103, true);
    view2.setUint16(7, 3072, true);

    const sample2 = parseCyclingPowerMeasurement(view2, sample1.nextCrank);
    assert.equal(sample2.telemetry.powerWatts, 295);
    assert.equal(sample2.telemetry.cadenceRpm, 90);
  });

  it('encodes FTMS Set Target Power (0x05) command in little-endian sint16', () => {
    const cmd = encodeFtmsSetTargetPower(250);
    assert.deepEqual(Array.from(cmd), [0x05, 0xfa, 0x00]);
  });
});
