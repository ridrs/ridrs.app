// SPDX-License-Identifier: AGPL-3.0-or-later
// Small web versions of a ride's big picture (the overlay picture, 2752×1536 and up to 8 MB): one JPEG per width of
// PICTURE_WIDTHS, written as picture-<width>.jpg. The dialog loads these (srcset); the original is for the app only. Jimp, pure JS
// (ADR 0104). A cache folder by key (the source's sha256) spares later builds the resize.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Jimp } from 'jimp';
import { PICTURE_WIDTHS, pictureName } from '../../src/rides.js';

const QUALITY = 80;

/** Writes picture-<w>.jpg for every width into `outDir`; never enlarges. Returns [{width, cached}]. */
export async function makeThumbnails(src, outDir, { cache = null, key = null } = {}) {
  mkdirSync(outDir, { recursive: true });
  const cacheDir = cache && key ? join(cache, key) : null;
  if (cacheDir && PICTURE_WIDTHS.every((w) => existsSync(join(cacheDir, pictureName(w))))) {
    for (const w of PICTURE_WIDTHS) cpSync(join(cacheDir, pictureName(w)), join(outDir, pictureName(w)));
    return PICTURE_WIDTHS.map((width) => ({ width, cached: true }));
  }
  const original = await Jimp.read(src);
  for (const w of [...PICTURE_WIDTHS].sort((a, b) => b - a)) {
    const img = original.clone();
    if (img.width > w) img.resize({ w });
    await img.write(join(outDir, pictureName(w)), { quality: QUALITY });
  }
  if (cacheDir) {
    mkdirSync(cacheDir, { recursive: true });
    for (const w of PICTURE_WIDTHS) cpSync(join(outDir, pictureName(w)), join(cacheDir, pictureName(w)));
  }
  return PICTURE_WIDTHS.map((width) => ({ width, cached: false }));
}
