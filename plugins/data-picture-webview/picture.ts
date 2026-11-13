// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DataPicture } from '@ridrs/contracts';

/** A JPEG's quality for a card's picture: small, without visible blocks at its size. */
const QUALITY = 0.82;

/** The size of a picture `width` × `height` at most `limit` px wide, its proportions kept. */
export function fitted(width: number, height: number, limit: number): { width: number; height: number } {
  const scale = Math.min(1, limit / width);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * `data.picture` on the WebView's canvas (ADR 0094): the picture decoded, drawn smaller with high
 * quality smoothing and encoded as a JPEG. No library: the WebView decodes and encodes JPEG and PNG.
 */
export function createCanvasPicture(): DataPicture {
  return {
    async shrink(bytes, width) {
      const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]));
      try {
        const size = fitted(bitmap.width, bitmap.height, width);
        const canvas = new OffscreenCanvas(size.width, size.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('This WebView draws no pictures');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, size.width, size.height);
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });
        return new Uint8Array(await blob.arrayBuffer());
      } finally {
        bitmap.close();
      }
    },
  };
}
