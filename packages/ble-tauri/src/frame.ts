// SPDX-License-Identifier: AGPL-3.0-or-later

/** Must match `FRAME_HEADER_BYTES` in `src-tauri/src/ble.rs`. */
export const FRAME_HEADER_BYTES = 16;

export interface NotificationFrame {
  /** Rust monotonic receive time in µs since process start (diagnostics only, never device time). */
  readonly rustMonotonicUs: number;
  /** Rust wall-clock receive time in ms since epoch (diagnostics only). */
  readonly rustWallMs: number;
  readonly data: Uint8Array;
}

/**
 * Decodes a notification frame: u64 LE monotonic µs, f64 LE wall-clock ms, payload.
 * Raw channel bodies arrive as ArrayBuffer; a JSON number array is accepted as a fallback.
 */
export function decodeNotificationFrame(
  message: ArrayBuffer | ArrayLike<number>,
): NotificationFrame {
  const bytes =
    message instanceof ArrayBuffer
      ? new Uint8Array(message)
      : Uint8Array.from(message as ArrayLike<number>);
  if (bytes.byteLength < FRAME_HEADER_BYTES) {
    throw new RangeError(`Notification frame too short: ${bytes.byteLength} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    rustMonotonicUs: Number(view.getBigUint64(0, true)),
    rustWallMs: view.getFloat64(8, true),
    data: bytes.subarray(FRAME_HEADER_BYTES),
  };
}

/** Test helper mirroring `encode_frame` in Rust. */
export function encodeNotificationFrame(
  rustMonotonicUs: number,
  rustWallMs: number,
  data: Uint8Array,
): ArrayBuffer {
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + data.byteLength);
  const view = new DataView(buffer);
  view.setBigUint64(0, BigInt(rustMonotonicUs), true);
  view.setFloat64(8, rustWallMs, true);
  new Uint8Array(buffer, FRAME_HEADER_BYTES).set(data);
  return buffer;
}
