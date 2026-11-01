// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Zwift Ride / Play controllers, decoded only as far as "button pressed".
 * Protocol knowledge from `experiments/hr-monitor-osx/src/zwift-ride-parser.ts` and
 * `zwift-packet-capture.log`. Advertised as 0xFC82; the GATT service is the 128-bit UUID below.
 */
export const ZWIFT_RIDE_ADVERTISED_UUID = 'fc82';
export const ZWIFT_RIDE_SERVICE_UUID = '00000001-19ca-4651-86e5-fa29dcdd09d1';
export const ZWIFT_RIDE_MEASUREMENT_UUID = '00000002-19ca-4651-86e5-fa29dcdd09d1';
export const ZWIFT_RIDE_CONTROL_POINT_UUID = '00000003-19ca-4651-86e5-fa29dcdd09d1';
export const ZWIFT_RIDE_RESPONSE_UUID = '00000004-19ca-4651-86e5-fa29dcdd09d1';

/** ASCII "RideOn", written to the control point to start the notification stream. */
export const RIDE_ON_HANDSHAKE = new Uint8Array([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e]);

/** Bit order of the varint-decoded ButtonMap (field 1 of opcode 0x23); bit = 0 means pressed. */
const BUTTONS = [
  'LEFT', 'UP', 'RIGHT', 'DOWN',
  'A', 'B', 'Y', 'Z',
  'SHIFT_UP_L', 'SHIFT_DOWN_L', 'POWERUP_L', 'ON_OFF_L',
  'SHIFT_UP_R', 'SHIFT_DOWN_R', 'POWERUP_R', 'ON_OFF_R',
] as const;

export type ZwiftRidePacket =
  | { readonly type: 'keypad'; readonly pressed: readonly string[] }
  | { readonly type: 'battery'; readonly percent: number }
  | { readonly type: 'handshake' }
  | { readonly type: 'heartbeat' }
  | { readonly type: 'other'; readonly opcode: number };

function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < bytes.length && shift < 35) {
    const byte = bytes[offset] ?? 0;
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }
  return { value, next: offset };
}

/** Reads varint field 1 (tag 0x08) directly after the opcode, as the controllers send it. */
function readField1(packet: Uint8Array): number | undefined {
  if (packet[1] !== 0x08) {
    return undefined;
  }
  return readVarint(packet, 2).value;
}

export function decodeZwiftRidePacket(packet: Uint8Array): ZwiftRidePacket {
  const opcode = packet[0] ?? 0;
  if (opcode === 0x52 && packet.byteLength === RIDE_ON_HANDSHAKE.byteLength) {
    return { type: 'handshake' };
  }
  if (opcode === 0x15) {
    return { type: 'heartbeat' };
  }
  if (opcode === 0x19) {
    const percent = readField1(packet);
    if (percent !== undefined) {
      return { type: 'battery', percent };
    }
  }
  if (opcode === 0x23) {
    const buttonMap = readField1(packet);
    if (buttonMap !== undefined) {
      const pressed = BUTTONS.filter((_, bit) => (buttonMap & (1 << bit)) === 0);
      return { type: 'keypad', pressed };
    }
  }
  return { type: 'other', opcode };
}
