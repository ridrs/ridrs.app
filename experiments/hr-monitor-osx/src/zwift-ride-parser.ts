// SPDX-License-Identifier: AGPL-3.0-or-later

export const ZWIFT_RIDE_SERVICE_UUID_16 = 0xfc82;
export const ZWIFT_RIDE_SERVICE_UUID_128 = '00000001-19ca-4651-86e5-fa29dcdd09d1';
export const ZWIFT_RIDE_MEASUREMENT_CHAR_UUID = '00000002-19ca-4651-86e5-fa29dcdd09d1';
export const ZWIFT_RIDE_CONTROL_POINT_CHAR_UUID = '00000003-19ca-4651-86e5-fa29dcdd09d1';
export const ZWIFT_RIDE_RESPONSE_CHAR_UUID = '00000004-19ca-4651-86e5-fa29dcdd09d1';

/** ASCII "RideOn" handshake payload required to start Zwift Ride / Play notification stream */
export const RIDE_ON_HANDSHAKE = new Uint8Array([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e]);

export type ZwiftControllerSide = 'left' | 'right';

export interface ZwiftRideButtonDefinition {
  id: string;
  label: string;
  side: ZwiftControllerSide;
  /**
   * Bitmask in the varint-decoded 16-bit ButtonMap (bits 0..15).
   * Note: On the wire, Protobuf base-128 varint encoding inserts continuation bits at
   * wire bit 7 (0x80) and wire bit 15 (0x8000). Once varint-decoded, the 16 buttons
   * occupy 4 contiguous 4-bit nibbles (0x0001 through 0x8000):
   * - Nibble 0 (0x0001..0x0008): Left D-Pad (LEFT, UP, RIGHT, DOWN)
   * - Nibble 1 (0x0010..0x0080): Right Actions (A, B, Y, Z)
   * - Nibble 2 (0x0100..0x0800): Left Hood/Shifters (SHIFT_UP_L, SHIFT_DOWN_L, POWERUP_L, ON_OFF_L)
   * - Nibble 3 (0x1000..0x8000): Right Hood/Shifters (SHIFT_UP_R, SHIFT_DOWN_R, POWERUP_R, ON_OFF_R)
   */
  mask: number;
}

/**
 * Zwift Ride / Play ButtonMap definitions (field 1 in 0x23 RideKeyPadStatus protobuf).
 * Hardware uses inverse logic (bit = 0 means PRESSED, bit = 1 means RELEASED).
 */
export const ZWIFT_RIDE_BUTTONS: readonly ZwiftRideButtonDefinition[] = [
  // Nibble 0 (bits 0..3): Left D-Pad
  { id: 'LEFT', label: 'D-Pad Left', side: 'left', mask: 0x0001 },
  { id: 'UP', label: 'D-Pad Up', side: 'left', mask: 0x0002 },
  { id: 'RIGHT', label: 'D-Pad Right', side: 'left', mask: 0x0004 },
  { id: 'DOWN', label: 'D-Pad Down', side: 'left', mask: 0x0008 },

  // Nibble 1 (bits 4..7): Right Action Diamond
  { id: 'A', label: 'Button A', side: 'right', mask: 0x0010 },
  { id: 'B', label: 'Button B', side: 'right', mask: 0x0020 },
  { id: 'Y', label: 'Button Y', side: 'right', mask: 0x0040 },
  { id: 'Z', label: 'Button Z', side: 'right', mask: 0x0080 },

  // Nibble 2 (bits 8..11): Left Shifters / PowerUp / Z-Button
  { id: 'SHIFT_UP_L', label: 'Shift Up (L)', side: 'left', mask: 0x0100 },
  { id: 'SHIFT_DOWN_L', label: 'Shift Down (L)', side: 'left', mask: 0x0200 },
  { id: 'POWERUP_L', label: 'PowerUp (L)', side: 'left', mask: 0x0400 },
  { id: 'ON_OFF_L', label: 'Z-Button (L)', side: 'left', mask: 0x0800 },

  // Nibble 3 (bits 12..15): Right Shifters / PowerUp / Z-Button
  { id: 'SHIFT_UP_R', label: 'Shift Up (R)', side: 'right', mask: 0x1000 },
  { id: 'SHIFT_DOWN_R', label: 'Shift Down (R)', side: 'right', mask: 0x2000 },
  { id: 'POWERUP_R', label: 'PowerUp (R)', side: 'right', mask: 0x4000 },
  { id: 'ON_OFF_R', label: 'Z-Button (R)', side: 'right', mask: 0x8000 },
] as const;

export const ALL_BUTTONS_RELEASED_MASK = 0xffffffff;

export interface ZwiftAnalogPaddleState {
  /** Left orange lever raw signed value (-100 to +100) */
  leftPaddle: number;
  /** Right orange lever raw signed value (-100 to +100) */
  rightPaddle: number;
  /** Extra axes if present */
  extraAxes: Record<number, number>;
  /** Combined steering percentage (-100 = full left, 0 = center, +100 = full right) */
  steeringPct: number;
  /** Left controller braking percentage (0 = no brake, 100 = full left brake) */
  leftBrakingPct: number;
  /** Right controller braking percentage (0 = no brake, 100 = full right brake) */
  rightBrakingPct: number;
  /** Combined maximum braking percentage (0 = no brake, 100 = full brake) */
  brakingPct: number;
}

export type ZwiftRideDecodedPacket =
  | {
      type: 'handshake';
      text: string;
    }
  | {
      type: 'keypad';
      opcode: number;
      controllerSide?: ZwiftControllerSide;
      buttonMap: number;
      pressedButtons: ZwiftRideButtonDefinition[];
      analog: ZwiftAnalogPaddleState;
    }
  | {
      type: 'battery';
      batteryPercent: number;
    }
  | {
      type: 'idle';
      opcode: number;
    };

/**
 * Decodes a Protobuf base-128 varint at `offset`.
 * Uses BigInt bitwise arithmetic so 32-bit/64-bit unsigned varints never overflow JS signed 32-bit ints.
 */
function readVarint(bytes: Uint8Array, startOffset: number): { value: number; nextOffset: number } {
  let result = 0n;
  let shift = 0n;
  let offset = startOffset;

  while (offset < bytes.length) {
    const byte = bytes[offset];
    offset += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: Number(result & 0xffffffffn), nextOffset: offset };
    }
    shift += 7n;
    if (shift > 63n) {
      break;
    }
  }
  return { value: Number(result & 0xffffffffn), nextOffset: offset };
}

/**
 * ZigZag decodes an unsigned 32-bit varint into a signed `sint32` value.
 */
export function decodeZigZag32(n: number): number {
  return (n >>> 1) ^ -(n & 1);
}

/**
 * ZigZag encodes a signed `sint32` value into an unsigned 32-bit integer.
 */
export function encodeZigZag32(n: number): number {
  return ((n << 1) ^ (n >> 31)) >>> 0;
}

function writeVarint(value: number, out: number[]): void {
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

function parseAnalogKeyPress(subBytes: Uint8Array): { location: number; value: number } {
  let offset = 0;
  let location = 0;
  let value = 0;

  while (offset < subBytes.length) {
    const tagVar = readVarint(subBytes, offset);
    offset = tagVar.nextOffset;
    const fieldNumber = tagVar.value >>> 3;
    const wireType = tagVar.value & 0x07;

    if (wireType === 0) {
      const valVar = readVarint(subBytes, offset);
      offset = valVar.nextOffset;
      if (fieldNumber === 1) {
        location = valVar.value;
      } else if (fieldNumber === 2) {
        value = decodeZigZag32(valVar.value);
      }
    } else if (wireType === 2) {
      const lenVar = readVarint(subBytes, offset);
      offset = lenVar.nextOffset + lenVar.value;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    } else {
      break;
    }
  }

  return { location, value: Math.max(-100, Math.min(100, value)) };
}

function parseAnalogKeyGroup(groupBytes: Uint8Array): ZwiftAnalogPaddleState {
  let offset = 0;
  let leftPaddle = 0;
  let rightPaddle = 0;
  const extraAxes: Record<number, number> = {};

  while (offset < groupBytes.length) {
    const tagVar = readVarint(groupBytes, offset);
    offset = tagVar.nextOffset;
    const fieldNumber = tagVar.value >>> 3;
    const wireType = tagVar.value & 0x07;

    if (fieldNumber === 1 && wireType === 2) {
      const lenVar = readVarint(groupBytes, offset);
      const start = lenVar.nextOffset;
      const end = Math.min(groupBytes.length, start + lenVar.value);
      const press = parseAnalogKeyPress(groupBytes.subarray(start, end));
      if (press.location === 0) {
        leftPaddle = press.value;
      } else if (press.location === 1) {
        rightPaddle = press.value;
      } else {
        extraAxes[press.location] = press.value;
      }
      offset = end;
    } else if (wireType === 0) {
      offset = readVarint(groupBytes, offset).nextOffset;
    } else if (wireType === 2) {
      const lenVar = readVarint(groupBytes, offset);
      offset = lenVar.nextOffset + lenVar.value;
    } else {
      break;
    }
  }

  return computeSteeringAndBraking(leftPaddle, rightPaddle, extraAxes);
}

/**
 * Maps raw left/right orange paddle deflections (-100..+100) into steering and braking percentages.
 *
 * Physical Zwift Ride Hall-effect sensor polarity (verified from hardware packet capture):
 * - Right controller (`location = 1`):
 *   - Push inward (towards left): `rightPaddle < 0` (`-1..-100`) -> Steer Left (`-1%..-100%`)
 *   - Pull outward (brake right): `rightPaddle > 0` (`+1..+100`) -> Right Brake (`1%..100%`)
 * - Left controller (`location = 0`):
 *   - Push inward (towards right): `leftPaddle > 0` (`+1..+100`) -> Steer Right (`+1%..+100%`)
 *   - Pull outward (brake left):   `leftPaddle < 0` (`-1..-100`) -> Left Brake (`1%..100%`)
 */
export function computeSteeringAndBraking(
  leftPaddle: number,
  rightPaddle: number,
  extraAxes: Record<number, number> = {},
): ZwiftAnalogPaddleState {
  // Right inward (rightPaddle < 0) steers LEFT (-); Left inward (leftPaddle > 0) steers RIGHT (+)
  const steerLeftFromRightInward = rightPaddle < 0 ? Math.abs(rightPaddle) : 0;
  const steerRightFromLeftInward = leftPaddle > 0 ? leftPaddle : 0;
  const steeringPct = Math.max(
    -100,
    Math.min(100, steerRightFromLeftInward - steerLeftFromRightInward),
  );

  // Separate Left and Right braking percentages:
  // Left brake: leftPaddle < 0 (`location = 0`); Right brake: rightPaddle > 0 (`location = 1`)
  const leftBrakingPct = Math.min(100, leftPaddle < 0 ? Math.abs(leftPaddle) : 0);
  const rightBrakingPct = Math.min(100, rightPaddle > 0 ? rightPaddle : 0);
  const extraBrake = Math.max(
    Math.abs(extraAxes[2] ?? 0),
    Math.abs(extraAxes[3] ?? 0),
  );
  const brakingPct = Math.min(100, Math.max(leftBrakingPct, rightBrakingPct, extraBrake));

  return {
    leftPaddle,
    rightPaddle,
    extraAxes,
    steeringPct,
    leftBrakingPct,
    rightBrakingPct,
    brakingPct,
  };
}

/**
 * Merges the analog paddle states from two simultaneously connected controllers (Left + Right).
 *
 * From hardware capture:
 * - Physical Left Zwift Ride controller sends 4 analog locations (`0, 1, 2, 3`, so `2 in extraAxes`),
 *   where `location = 0` is its physical Left paddle and `location = 1` is bridged from Right.
 * - Physical Right Zwift Ride controller sends 2 analog locations (`0, 1`, so `!(2 in extraAxes)`),
 *   where `location = 0` is always dummy `0` and `location = 1` is its physical Right paddle.
 */
export function mergeControllerAnalogStates(
  leftState: ZwiftAnalogPaddleState | null,
  rightState: ZwiftAnalogPaddleState | null,
): ZwiftAnalogPaddleState {
  const states = [leftState, rightState].filter(
    (s): s is ZwiftAnalogPaddleState => s !== null,
  );
  if (states.length === 0) {
    return computeSteeringAndBraking(0, 0);
  }
  if (states.length === 1) {
    return computeSteeringAndBraking(
      states[0].leftPaddle,
      states[0].rightPaddle,
      states[0].extraAxes,
    );
  }

  // Always take the active non-zero paddle value from whichever slot reports it.
  // This supports both:
  // 1) A single bridged "Zwift Ride" connection reporting both Location 0 (Left) and Location 1 (Right), and
  // 2) Dual BLE connections where Left reports Location 0 and Right reports Location 1.
  const leftPaddle =
    leftState && leftState.leftPaddle !== 0
      ? leftState.leftPaddle
      : (rightState?.leftPaddle ?? 0);
  const rightPaddle =
    rightState && rightState.rightPaddle !== 0
      ? rightState.rightPaddle
      : (leftState?.rightPaddle ?? 0);

  const mergedExtraAxes: Record<number, number> = {
    ...(leftState?.extraAxes ?? {}),
    ...(rightState?.extraAxes ?? {}),
  };

  return computeSteeringAndBraking(leftPaddle, rightPaddle, mergedExtraAxes);
}

/**
 * Parses opcode `0x07` (Zwift Play KeyPadStatus format).
 * Field 1 (0x08): 0 = Right controller, 1 = Left controller
 * Field 2 (0x10): 0 = pressed -> UP (Left) / Y (Right)
 * Field 3 (0x18): 0 = pressed -> LEFT (Left) / Z (Right)
 * Field 4 (0x20): 0 = pressed -> RIGHT (Left) / A (Right)
 * Field 5 (0x28): 0 = pressed -> DOWN (Left) / B (Right)
 * Field 6 (0x30): 0 = pressed -> ON_OFF_L (Left) / ON_OFF_R (Right)
 * Field 7 (0x38): 0 = pressed -> SHIFT_UP_L (Left) / SHIFT_UP_R (Right)
 * Field 8 (0x40): sint32 ZigZag -> Orange Paddle Steer (-100..100)
 * Field 9 (0x48): sint32 ZigZag -> Orange Paddle Brake (-100..100)
 */
function parseZwiftPlay0x07Packet(
  bytes: Uint8Array,
  sideHint?: ZwiftControllerSide,
): ZwiftRideDecodedPacket {
  let offset = 1;
  let controllerSide: ZwiftControllerSide = sideHint ?? 'left';
  const fieldStates = new Map<number, number>();
  let rawSteer = 0;
  let rawBrake = 0;

  while (offset < bytes.length) {
    const tagVar = readVarint(bytes, offset);
    offset = tagVar.nextOffset;
    const fieldNumber = tagVar.value >>> 3;
    const wireType = tagVar.value & 0x07;

    if (wireType === 0) {
      const valVar = readVarint(bytes, offset);
      offset = valVar.nextOffset;
      if (fieldNumber === 1) {
        controllerSide = valVar.value === 0 ? 'right' : 'left';
      } else if (fieldNumber >= 2 && fieldNumber <= 7) {
        fieldStates.set(fieldNumber, valVar.value);
      } else if (fieldNumber === 8) {
        rawSteer = Math.max(-100, Math.min(100, decodeZigZag32(valVar.value)));
      } else if (fieldNumber === 9) {
        rawBrake = Math.max(-100, Math.min(100, decodeZigZag32(valVar.value)));
      }
    } else if (wireType === 2) {
      const lenVar = readVarint(bytes, offset);
      offset = lenVar.nextOffset + lenVar.value;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    } else {
      break;
    }
  }

  const fieldToButtonId: Record<number, string> =
    controllerSide === 'left'
      ? {
          2: 'UP',
          3: 'LEFT',
          4: 'RIGHT',
          5: 'DOWN',
          6: 'ON_OFF_L',
          7: 'SHIFT_UP_L',
        }
      : {
          2: 'Y',
          3: 'Z',
          4: 'A',
          5: 'B',
          6: 'ON_OFF_R',
          7: 'SHIFT_UP_R',
        };

  let buttonMap = ALL_BUTTONS_RELEASED_MASK;
  const pressedButtons: ZwiftRideButtonDefinition[] = [];

  for (const [fieldNum, btnId] of Object.entries(fieldToButtonId)) {
    const val = fieldStates.get(Number(fieldNum));
    if (val === 0) {
      const def = ZWIFT_RIDE_BUTTONS.find((b) => b.id === btnId);
      if (def) {
        pressedButtons.push(def);
        buttonMap = (buttonMap & ~def.mask) >>> 0;
      }
    }
  }

  const brakeMag = Math.abs(rawBrake);
  const steerMag = Math.abs(rawSteer);
  let leftPaddle = 0;
  let rightPaddle = 0;

  if (controllerSide === 'left') {
    // Left: positive = steer left, negative = brake
    leftPaddle = brakeMag > 0 ? -brakeMag : steerMag;
  } else {
    // Right: negative = steer right, positive = brake
    rightPaddle = brakeMag > 0 ? brakeMag : -steerMag;
  }

  return {
    type: 'keypad',
    opcode: 0x07,
    controllerSide,
    buttonMap,
    pressedButtons,
    analog: computeSteeringAndBraking(leftPaddle, rightPaddle),
  };
}

/**
 * Parses a raw BLE notification packet from a Zwift Ride / Play controller (`00000002-19ca-...`).
 */
export function parseZwiftRidePacket(
  data: DataView,
  sideHint?: ZwiftControllerSide,
): ZwiftRideDecodedPacket {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length === 0) {
    return { type: 'idle', opcode: 0 };
  }

  // Check for "RideOn" ASCII handshake response (0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e)
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x69 &&
    bytes[2] === 0x64 &&
    bytes[3] === 0x65 &&
    bytes[4] === 0x4f &&
    bytes[5] === 0x6e
  ) {
    return { type: 'handshake', text: 'RideOn' };
  }

  const opcode = bytes[0];

  // Opcode 0x19: Zwift Controller periodic battery status notification (e.g. `19 10 50` -> field 2 = 80%)
  if (opcode === 0x19) {
    let offset = 1;
    while (offset < bytes.length) {
      const tagVar = readVarint(bytes, offset);
      offset = tagVar.nextOffset;
      const fieldNumber = tagVar.value >>> 3;
      const wireType = tagVar.value & 0x07;
      if (wireType === 0) {
        const valVar = readVarint(bytes, offset);
        offset = valVar.nextOffset;
        if (fieldNumber === 2 && valVar.value >= 0 && valVar.value <= 100) {
          return { type: 'battery', batteryPercent: valVar.value };
        }
      } else if (wireType === 2) {
        const lenVar = readVarint(bytes, offset);
        offset = lenVar.nextOffset + lenVar.value;
      } else {
        break;
      }
    }
    return { type: 'idle', opcode };
  }

  // Opcode 0x07: Zwift Play KeyPadStatus Protobuf payload
  if (opcode === 0x07) {
    return parseZwiftPlay0x07Packet(bytes, sideHint);
  }

  // Opcode 0x23: Zwift Ride / Updated Play KeyPadStatus Protobuf payload
  if (opcode === 0x23) {
    let offset = 1;
    let buttonMap = ALL_BUTTONS_RELEASED_MASK;
    let leftPaddle = 0;
    let rightPaddle = 0;
    const extraAxes: Record<number, number> = {};
    let hasNestedGroup = false;
    let nestedGroupAnalog: ZwiftAnalogPaddleState | null = null;

    while (offset < bytes.length) {
      const tagVar = readVarint(bytes, offset);
      offset = tagVar.nextOffset;
      const fieldNumber = tagVar.value >>> 3;
      const wireType = tagVar.value & 0x07;

      if (fieldNumber === 1 && wireType === 0) {
        const valVar = readVarint(bytes, offset);
        buttonMap = valVar.value >>> 0;
        offset = valVar.nextOffset;
      } else if (fieldNumber === 1 && wireType === 5 && offset + 4 <= bytes.length) {
        buttonMap = data.getUint32(offset, true);
        offset += 4;
      } else if (fieldNumber === 2 && wireType === 2) {
        // Nested RideAnalogKeyGroup wrapper (tag 0x12)
        const lenVar = readVarint(bytes, offset);
        const start = lenVar.nextOffset;
        const end = Math.min(bytes.length, start + lenVar.value);
        nestedGroupAnalog = parseAnalogKeyGroup(bytes.subarray(start, end));
        hasNestedGroup = true;
        offset = end;
      } else if (fieldNumber === 3 && wireType === 2) {
        // Direct repeated RideAnalogKeyPress submessages (tag 0x1a: `1a <len> 08 <location> 10 <zigzag>`)
        const lenVar = readVarint(bytes, offset);
        const start = lenVar.nextOffset;
        const end = Math.min(bytes.length, start + lenVar.value);
        const press = parseAnalogKeyPress(bytes.subarray(start, end));
        if (press.location === 0) {
          leftPaddle = press.value;
        } else if (press.location === 1) {
          rightPaddle = press.value;
        } else {
          extraAxes[press.location] = press.value;
        }
        offset = end;
      } else if (wireType === 0) {
        offset = readVarint(bytes, offset).nextOffset;
      } else if (wireType === 2) {
        const lenVar = readVarint(bytes, offset);
        offset = lenVar.nextOffset + lenVar.value;
      } else if (wireType === 5) {
        offset += 4;
      } else if (wireType === 1) {
        offset += 8;
      } else {
        break;
      }
    }

    const analog = hasNestedGroup && nestedGroupAnalog
      ? nestedGroupAnalog
      : computeSteeringAndBraking(leftPaddle, rightPaddle, extraAxes);

    // Inverse logic: bit 0 = pressed, bit 1 = released across the 16-bit varint-decoded ButtonMap
    const pressedButtons = ZWIFT_RIDE_BUTTONS.filter(
      (btn) => (buttonMap & btn.mask) === 0,
    );

    return {
      type: 'keypad',
      opcode: 0x23,
      controllerSide: sideHint,
      buttonMap,
      pressedButtons,
      analog,
    };
  }

  return { type: 'idle', opcode };
}

/**
 * Encodes a synthetic `0x23` `RideKeyPadStatus` Protobuf packet matching physical Zwift Ride
 * hardware wire format (`23 08 <ButtonMap> 1a <len> <RideAnalogKeyPress> ...`).
 */
export function encodeZwiftRideKeyPadPacket(
  pressedButtonIds: string[],
  leftPaddle: number,
  rightPaddle: number,
): DataView {
  let buttonMap = ALL_BUTTONS_RELEASED_MASK;
  for (const id of pressedButtonIds) {
    const def = ZWIFT_RIDE_BUTTONS.find((b) => b.id === id);
    if (def) {
      buttonMap = (buttonMap & ~def.mask) >>> 0;
    }
  }

  const out: number[] = [0x23];

  // Field 1 (tag 0x08): ButtonMap varint
  out.push(0x08);
  writeVarint(buttonMap, out);

  // Field 3 (tag 0x1a): Repeated RideAnalogKeyPress submessages (matches physical Zwift Ride firmware)
  for (const [location, val] of [
    [0, leftPaddle],
    [1, rightPaddle],
  ] as const) {
    const pressBytes: number[] = [];
    // Field 1 (Location): tag 0x08
    pressBytes.push(0x08);
    writeVarint(location, pressBytes);
    // Field 2 (AnalogValue sint32): tag 0x10
    pressBytes.push(0x10);
    writeVarint(encodeZigZag32(val), pressBytes);

    // Submessage tag 0x1a (fieldNumber = 3, wireType = 2) + length
    out.push(0x1a);
    writeVarint(pressBytes.length, out);
    out.push(...pressBytes);
  }

  const uint8 = new Uint8Array(out);
  return new DataView(uint8.buffer);
}

/**
 * Formats a DataView as a space-separated hex string (e.g. `23 08 ff ff 03 12 ...`).
 */
export function formatPacketHex(data: DataView): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function dumpProtobufFields(bytes: Uint8Array, depth = 0): string {
  let offset = 0;
  const parts: string[] = [];

  while (offset < bytes.length) {
    const tagVar = readVarint(bytes, offset);
    if (tagVar.nextOffset <= offset) break;
    offset = tagVar.nextOffset;
    const fieldNumber = tagVar.value >>> 3;
    const wireType = tagVar.value & 0x07;
    if (fieldNumber === 0) break;

    if (wireType === 0) {
      const valVar = readVarint(bytes, offset);
      offset = valVar.nextOffset;
      const unsignedVal = valVar.value >>> 0;
      const zigzagVal = decodeZigZag32(unsignedVal);
      parts.push(
        `f${fieldNumber}(varint)=${unsignedVal}[hex:0x${unsignedVal.toString(16)},zz:${zigzagVal}]`,
      );
    } else if (wireType === 2) {
      const lenVar = readVarint(bytes, offset);
      const start = lenVar.nextOffset;
      const end = Math.min(bytes.length, start + lenVar.value);
      const sub = bytes.subarray(start, end);
      offset = end;
      if (depth < 2 && sub.length > 0) {
        const nested = dumpProtobufFields(sub, depth + 1);
        parts.push(`f${fieldNumber}(len=${sub.length}){${nested}}`);
      } else {
        const subHex = Array.from(sub, (b) => b.toString(16).padStart(2, '0')).join('');
        parts.push(`f${fieldNumber}(bytes=${subHex})`);
      }
    } else if (wireType === 5 && offset + 4 <= bytes.length) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
      const u32 = dv.getUint32(0, true);
      const i32 = dv.getInt32(0, true);
      offset += 4;
      parts.push(`f${fieldNumber}(fixed32)=0x${u32.toString(16)}[i32:${i32}]`);
    } else if (wireType === 1 && offset + 8 <= bytes.length) {
      offset += 8;
      parts.push(`f${fieldNumber}(fixed64)`);
    } else {
      parts.push(`f${fieldNumber}(wt=${wireType}?)`);
      break;
    }
  }

  return parts.join(', ');
}

/**
 * Produces a human-readable diagnostic summary of any raw Zwift BLE notification packet,
 * including its opcode, raw hex bytes, and decoded Protobuf field tree.
 */
export function describeRawZwiftPacket(data: DataView): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length === 0) {
    return 'empty (0 bytes)';
  }
  const hex = formatPacketHex(data);
  const opcode = `0x${bytes[0].toString(16).padStart(2, '0')}`;
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x69 &&
    bytes[2] === 0x64 &&
    bytes[3] === 0x65 &&
    bytes[4] === 0x4f &&
    bytes[5] === 0x6e
  ) {
    return `opcode=${opcode} ("RideOn" ASCII) | hex=[${hex}]`;
  }
  const protoDump = bytes.length > 1 ? dumpProtobufFields(bytes.subarray(1)) : 'no-payload';
  return `opcode=${opcode} (${bytes.length}B) | hex=[${hex}] | proto=[${protoDump}]`;
}

/**
 * Encodes candidate Protobuf haptic vibration command payloads for the Zwift Control Point
 * (`00000003-19ca-4651-86e5-fa29dcdd09d1`).
 *
 * Includes both the `0x12`-prefixed opcode framing (`12 12 08 0a 06 08 02 10 00 18 <pattern>`)
 * and the direct field framing (`12 08 0a 06 08 02 10 00 18 <pattern>`).
 */
export function encodeZwiftVibrationPayloads(pattern = 0x20): Uint8Array<ArrayBuffer>[] {
  const p = Math.max(1, Math.min(127, pattern & 0x7f));
  return [
    new Uint8Array([0x12, 0x12, 0x08, 0x0a, 0x06, 0x08, 0x02, 0x10, 0x00, 0x18, p]),
    new Uint8Array([0x12, 0x08, 0x0a, 0x06, 0x08, 0x02, 0x10, 0x00, 0x18, p]),
  ];
}


