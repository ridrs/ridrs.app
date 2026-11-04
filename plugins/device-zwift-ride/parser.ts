// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ControllerButton } from '@ridrs/contracts';
import { BinaryReader, WireType } from '@bufbuild/protobuf/wire';

/** ASCII "RideOn": written to the control point, it makes the controller send its buttons. */
export const RIDE_ON = new Uint8Array([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e]);

/** Opcode of the keypad status; the protobuf message follows the opcode byte. */
const KEYPAD_STATUS = 0x23;

/** Field 1 of the keypad status: one bit per button, a cleared bit means held down. */
const BUTTON_MAP_FIELD = 1;

/** Bits of the button map, as captured from a Zwift Ride (experiments/hr-monitor-osx). */
const BUTTONS: readonly (readonly [ControllerButton, number])[] = [
  ['left', 0x0001],
  ['up', 0x0002],
  ['right', 0x0004],
  ['down', 0x0008],
  ['a', 0x0010],
  ['b', 0x0020],
  ['y', 0x0040],
  ['z', 0x0080],
  ['shift-up-left', 0x0100],
  ['shift-down-left', 0x0200],
  ['power-up-left', 0x0400],
  ['on-off-left', 0x0800],
  ['shift-up-right', 0x1000],
  ['shift-down-right', 0x2000],
  ['power-up-right', 0x4000],
  ['on-off-right', 0x8000],
];

export type ZwiftRideParseResult =
  | { readonly ok: true; readonly buttons?: readonly ControllerButton[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Buttons held down from one notification. Packets other than the keypad status (battery,
 * heartbeat, the "RideOn" reply, ...) and keypad packets without a button map carry no buttons.
 * The analog paddles (other fields) are skipped.
 */
export function parseZwiftRidePacket(packet: Uint8Array): ZwiftRideParseResult {
  if (packet[0] !== KEYPAD_STATUS) {
    return { ok: true };
  }
  let buttonMap: number | undefined;
  try {
    const reader = new BinaryReader(packet.subarray(1));
    while (reader.pos < reader.len) {
      const [field, wireType] = reader.tag();
      if (field === BUTTON_MAP_FIELD && wireType === WireType.Varint) {
        buttonMap = reader.uint32();
      } else {
        reader.skip(wireType, field);
      }
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (buttonMap === undefined) {
    return { ok: true };
  }
  const map = buttonMap;
  return { ok: true, buttons: BUTTONS.filter(([, bit]) => (map & bit) === 0).map(([b]) => b) };
}
