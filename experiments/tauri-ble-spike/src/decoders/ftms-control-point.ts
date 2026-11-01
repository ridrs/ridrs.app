// SPDX-License-Identifier: AGPL-3.0-or-later

/** Fitness Machine Control Point (0x2AD9): write with response, responses arrive as indications. */
export const FTMS_CONTROL_POINT_UUID = '2ad9';

const OP_REQUEST_CONTROL = 0x00;
const OP_SET_TARGET_POWER = 0x05;
const OP_RESPONSE_CODE = 0x80;

const RESULT_NAMES: Record<number, string> = {
  0x01: 'success',
  0x02: 'op code not supported',
  0x03: 'invalid parameter',
  0x04: 'operation failed',
  0x05: 'control not permitted',
};

export interface ControlPointResponse {
  readonly requestOpCode: number;
  readonly resultCode: number;
  readonly result: string;
}

export function encodeRequestControl(): Uint8Array {
  return new Uint8Array([OP_REQUEST_CONTROL]);
}

/** Target power is a SINT16 in watts, little-endian. */
export function encodeSetTargetPower(watts: number): Uint8Array {
  const packet = new Uint8Array(3);
  const view = new DataView(packet.buffer);
  view.setUint8(0, OP_SET_TARGET_POWER);
  view.setInt16(1, watts, true);
  return packet;
}

export function decodeControlPointResponse(packet: Uint8Array): ControlPointResponse | undefined {
  if (packet.byteLength < 3 || packet[0] !== OP_RESPONSE_CODE) {
    return undefined;
  }
  const requestOpCode = packet[1] ?? 0;
  const resultCode = packet[2] ?? 0;
  return { requestOpCode, resultCode, result: RESULT_NAMES[resultCode] ?? `unknown (0x${resultCode.toString(16)})` };
}
