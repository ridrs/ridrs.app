// SPDX-License-Identifier: Apache-2.0

// Binary data in event payloads is lowercase hex (`device.raw-notification`). The Web platform's
// `Uint8Array.prototype.toHex` / `Uint8Array.fromHex` are used where the runtime has them.

interface HexCapableUint8Array {
  toHex?: () => string;
}

interface HexCapableUint8ArrayConstructor {
  fromHex?: (hex: string) => Uint8Array;
}

/** `Uint8Array.of(0x44, 0x0a)` -> `"440a"`. */
export function bytesToHex(bytes: Uint8Array): string {
  const native = (bytes as HexCapableUint8Array).toHex;
  if (typeof native === 'function') {
    return native.call(bytes);
  }
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** `"440a"` (any case, even length) -> its bytes; anything else throws. */
export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
    throw new Error(`Invalid hex string "${hex}"`);
  }
  const native = (Uint8Array as HexCapableUint8ArrayConstructor).fromHex;
  if (typeof native === 'function') {
    return native(hex);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return bytes;
}
