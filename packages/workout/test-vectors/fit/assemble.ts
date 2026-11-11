// SPDX-License-Identifier: AGPL-3.0-or-later

// Turns an annotated hex file (`*.fit.hex`) into the bytes of a FIT file, so that the test
// vectors are written by hand from the public FIT specification, readable and commented, and
// never made by ridrs' own encoder. The syntax, token by token (whitespace separates tokens):
//
//   # …               a comment, to the end of the line
//   4a                one byte, two hex digits
//   u8:N u16:N u32:N  an unsigned integer in the current byte order (also s8, s16, s32, u64, s64)
//   str12"Warm up"    a UTF-8 string, padded with NUL bytes to 12 bytes
//   !le  !be          the byte order of the integers that follow (little-endian at the start)
//   {size}            the header's data size: the bytes after the header but the last two (the CRC)
//   {hcrc}            the CRC-16 of the first 12 bytes (the header CRC)
//   {crc}             the CRC-16 of every byte before it (the file CRC)
//
// The header fields are always little-endian, as the FIT protocol says. The CRC is the one of
// `@ridrs/fit`, which its tests check against the official SDK.
import { fitCrc } from '@ridrs/fit';

type Piece =
  | { readonly kind: 'bytes'; readonly bytes: readonly number[] }
  | { readonly kind: 'size' | 'hcrc' | 'crc' };

const INTEGER = /^([us])(8|16|32|64):(-?\d+)$/;
const STRING = /^str(\d+)"([^"]*)"$/;

function integer(signed: boolean, bits: number, text: string, little: boolean): number[] {
  const size = bits / 8;
  const view = new DataView(new ArrayBuffer(size));
  if (bits === 64) {
    if (signed) view.setBigInt64(0, BigInt(text), little);
    else view.setBigUint64(0, BigInt(text), little);
  } else {
    const value = Number(text);
    const lowest = signed ? -(2 ** (bits - 1)) : 0;
    const highest = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
    if (!Number.isInteger(value) || value < lowest || value > highest) {
      throw new Error(`${text} does not fit in ${signed ? 's' : 'u'}${bits}`);
    }
    if (bits === 8) view.setUint8(0, value & 0xff);
    else if (bits === 16) view.setUint16(0, value & 0xffff, little);
    else view.setUint32(0, value >>> 0, little);
  }
  return [...new Uint8Array(view.buffer)];
}

export function assembleFitHex(source: string): Uint8Array {
  const pieces: Piece[] = [];
  let little = true;
  const text = source.replace(/#.*$/gm, '');
  for (const token of text.match(/str\d+"[^"]*"|\S+/g) ?? []) {
    const int = INTEGER.exec(token);
    const str = STRING.exec(token);
    if (/^[0-9a-fA-F]{2}$/.test(token)) {
      pieces.push({ kind: 'bytes', bytes: [Number.parseInt(token, 16)] });
    } else if (int) {
      const [, sign, bits, value] = int;
      pieces.push({
        kind: 'bytes',
        bytes: integer(sign === 's', Number(bits), value as string, little),
      });
    } else if (str) {
      const size = Number(str[1]);
      const encoded = [...new TextEncoder().encode(str[2])];
      if (encoded.length > size) {
        throw new Error(`"${str[2]}" is longer than ${size} bytes`);
      }
      pieces.push({
        kind: 'bytes',
        bytes: [...encoded, ...new Array(size - encoded.length).fill(0)],
      });
    } else if (token === '!le' || token === '!be') {
      little = token === '!le';
    } else if (token === '{size}' || token === '{hcrc}' || token === '{crc}') {
      pieces.push({ kind: token.slice(1, -1) as 'size' | 'hcrc' | 'crc' });
    } else {
      throw new Error(`Unknown token "${token}"`);
    }
  }
  const length = pieces.reduce(
    (sum, piece) =>
      sum + (piece.kind === 'bytes' ? piece.bytes.length : piece.kind === 'size' ? 4 : 2),
    0,
  );
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  const headerSize = pieces[0]?.kind === 'bytes' ? (pieces[0].bytes[0] ?? 0) : 0;
  // Placeholders are filled in order: a CRC covers the size and header CRC before it.
  let at = 0;
  for (const piece of pieces) {
    if (piece.kind === 'bytes') {
      bytes.set(piece.bytes, at);
      at += piece.bytes.length;
    } else if (piece.kind === 'size') {
      view.setUint32(at, length - headerSize - 2, true);
      at += 4;
    } else {
      view.setUint16(at, fitCrc(bytes, 0, piece.kind === 'hcrc' ? 12 : at), true);
      at += 2;
    }
  }
  return bytes;
}
