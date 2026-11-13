// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DataPicture } from '@ridrs/contracts';

/**
 * What the simulated `data.picture` makes of a picture: not a picture, but bytes that name what it
 * was made from, so that a scenario can tell the small picture of a route from any other.
 */
export function smallPicture(bytes: Uint8Array, width: number): Uint8Array {
  let sum = 0;
  for (const byte of bytes) sum = (sum * 31 + byte) >>> 0;
  return new TextEncoder().encode(`small picture, ${width} px, of ${bytes.length} bytes, ${sum}`);
}

/** `data.picture` for the scenarios: a host without a WebView draws no pictures. */
export const simulatedPicture: DataPicture = {
  shrink: async (bytes, width) => smallPicture(bytes, width),
};
