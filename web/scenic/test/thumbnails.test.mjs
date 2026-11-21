// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — small web versions of a ride's big picture (scripts/lib/thumbnails.mjs, built into vg/<slug>/web/),
// and the dialog's picture that uses them (ridePicture in src/rides.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Jimp } from 'jimp';
import { makeThumbnails } from '../scripts/lib/thumbnails.mjs';
import { PICTURE_WIDTHS, ridePicture } from '../src/rides.js';

const temp = () => mkdtempSync(join(tmpdir(), 'scenic-thumbs-'));
async function picture(dir, name, width, height, mime) {
  const file = join(dir, name);
  // Noise (a fixed pseudo-random sequence) like a photo: a flat colour would compress to almost nothing.
  const img = new Jimp({ width, height, color: 0x3388ccff });
  let s = 1;
  for (let i = 0; i < img.bitmap.data.length; i++) if (i % 4 !== 3) img.bitmap.data[i] = (s = (s * 1103515245 + 12345) & 0x7fffffff) >> 23;
  writeFileSync(file, await img.getBuffer(mime));
  return file;
}

test('a big picture gets a JPEG per width, same aspect ratio, much smaller than the original', async () => {
  const dir = temp();
  try {
    const src = await picture(dir, 'big.png', 2752, 1536, 'image/png');
    const out = join(dir, 'web');
    const made = await makeThumbnails(src, out, { cache: join(dir, 'cache'), key: 'abc' });
    assert.deepEqual(made.map((m) => m.width), PICTURE_WIDTHS);
    for (const w of PICTURE_WIDTHS) {
      const file = join(out, `picture-${w}.jpg`);
      const img = await Jimp.read(file);
      assert.equal(img.width, w);
      assert.equal(img.height, Math.round((1536 * w) / 2752));
      assert.equal(img.mime, 'image/jpeg');
      assert.ok(readFileSync(file).length < readFileSync(src).length);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a picture narrower than a width is never enlarged', async () => {
  const dir = temp();
  try {
    const src = await picture(dir, 'small.jpg', 800, 400, 'image/jpeg');
    await makeThumbnails(src, join(dir, 'web'));
    assert.equal((await Jimp.read(join(dir, 'web', 'picture-640.jpg'))).width, 640);
    assert.equal((await Jimp.read(join(dir, 'web', 'picture-1280.jpg'))).width, 800);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the cache by key spares the second build the resize', async () => {
  const dir = temp();
  try {
    const src = await picture(dir, 'big.jpg', 1600, 900, 'image/jpeg');
    const cache = join(dir, 'cache');
    await makeThumbnails(src, join(dir, 'a'), { cache, key: 'k1' });
    rmSync(src); // a cache hit never reads the source
    const made = await makeThumbnails(src, join(dir, 'b'), { cache, key: 'k1' });
    assert.ok(made.every((m) => m.cached));
    for (const w of PICTURE_WIDTHS) assert.ok(existsSync(join(dir, 'b', `picture-${w}.jpg`)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the dialog shows only the small web versions of the overlay picture, never the original', () => {
  const sha = 'a'.repeat(64);
  const p = { overlay: JSON.stringify([{ path: 'readme.txt', sha256: 'b'.repeat(64) }, { path: 'Big Picture.png', sha256: sha }]), thumbnail: null };
  assert.deepEqual(ridePicture('vg-test-climb', p), {
    url: 'vg/test-climb/web/picture-1280.jpg?h=aaaaaaaaaaaa',
    srcset: 'vg/test-climb/web/picture-640.jpg?h=aaaaaaaaaaaa 640w, vg/test-climb/web/picture-1280.jpg?h=aaaaaaaaaaaa 1280w',
  });
});

test('without an overlay picture the small thumbnail stands alone; without either there is none', () => {
  assert.deepEqual(ridePicture('vg-x', { overlay: '[]', thumbnail: JSON.stringify({ sha256: 'c'.repeat(64) }) }), { url: 'vg/x/thumbnail.jpg', srcset: null });
  assert.equal(ridePicture('vg-x', { overlay: '[]', thumbnail: null }), null);
});
