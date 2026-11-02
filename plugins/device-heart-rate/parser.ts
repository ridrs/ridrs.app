// SPDX-License-Identifier: AGPL-3.0-or-later

export type HeartRateParseResult =
  | { readonly ok: true; readonly heartRateBpm?: number }
  | { readonly ok: false; readonly reason: string };

const FLAG_UINT16_VALUE = 0x01;
const FLAG_CONTACT_DETECTED = 0x02;
const FLAG_CONTACT_SUPPORTED = 0x04;
const FLAG_ENERGY_EXPENDED = 0x08;
const FLAG_RR_INTERVALS = 0x10;

/**
 * Parses a Bluetooth SIG Heart Rate Measurement notification (0x2A37), little-endian, fields in
 * flag order: value (uint8 or uint16), Energy Expended (uint16), RR-intervals (uint16 each, until
 * the end). Energy and RR-intervals are only checked for their length. A sensor that supports
 * contact detection but reports no contact, or a value of 0, gives no reading.
 */
export function parseHeartRateMeasurement(packet: Uint8Array): HeartRateParseResult {
  if (packet.byteLength < 1) {
    return { ok: false, reason: 'Empty packet: no flags' };
  }
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const flags = view.getUint8(0);
  let offset = 1;

  const valueSize = flags & FLAG_UINT16_VALUE ? 2 : 1;
  if (offset + valueSize > packet.byteLength) {
    return { ok: false, reason: `Truncated at the ${valueSize * 8}-bit heart rate value` };
  }
  const value = valueSize === 2 ? view.getUint16(offset, true) : view.getUint8(offset);
  offset += valueSize;

  if (flags & FLAG_ENERGY_EXPENDED) {
    if (offset + 2 > packet.byteLength) {
      return { ok: false, reason: 'Truncated at the Energy Expended field' };
    }
    offset += 2;
  }

  if (flags & FLAG_RR_INTERVALS && (packet.byteLength - offset) % 2 !== 0) {
    return { ok: false, reason: 'RR-interval field with an odd number of bytes' };
  }

  const contactLost = (flags & FLAG_CONTACT_SUPPORTED) !== 0 && (flags & FLAG_CONTACT_DETECTED) === 0;
  if (contactLost || value === 0) {
    return { ok: true };
  }
  return { ok: true, heartRateBpm: value };
}
