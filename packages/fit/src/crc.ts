// SPDX-License-Identifier: AGPL-3.0-or-later

// The FIT CRC-16 as the FIT protocol documentation defines it: polynomial 0xA001 (CRC-16/ARC),
// processed a nibble at a time.
const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401,
  0x5000, 0x9c01, 0x8801, 0x4400,
] as const;

function step(crc: number, nibble: number): number {
  const tmp = CRC_TABLE[crc & 0xf] ?? 0;
  const shifted = (crc >> 4) & 0x0fff;
  return shifted ^ tmp ^ (CRC_TABLE[nibble & 0xf] ?? 0);
}

/** CRC-16 of `bytes[start, end)`, continuing from `crc`. */
export function fitCrc(bytes: Uint8Array, start = 0, end = bytes.length, crc = 0): number {
  let value = crc;
  for (let i = start; i < end; i += 1) {
    const byte = bytes[i] ?? 0;
    value = step(step(value, byte), byte >> 4);
  }
  return value;
}
