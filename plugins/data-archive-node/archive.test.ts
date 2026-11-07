// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaFiles } from '@ridrs/contracts';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';
import { createNodeArchive } from './archive.ts';

const root = mkdtempSync(join(tmpdir(), 'ridrs-archive-test-'));
const media = { location: (path: string) => join(root, ...path.split('/')) } as MediaFiles;

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, text] of Object.entries(files)) {
    await zip.add(name, new Uint8ArrayReader(new TextEncoder().encode(text)));
  }
  return zip.close();
}

describe('createNodeArchive', () => {
  it('unpacks every file into the folder and names them', async () => {
    writeFileSync(join(root, 'a.zip'), await zipOf({ 'x.txt': 'one', 'sub/y.txt': 'two' }));
    const files = await createNodeArchive(media).extract('a.zip', 'out');
    expect(files).toEqual(['out/x.txt', 'out/sub/y.txt']);
    expect(readFileSync(join(root, 'out', 'sub', 'y.txt'), 'utf8')).toBe('two');
  });

  // zip.js refuses such a name itself; the path check stays for any other reader.
  it('refuses a name that would leave the folder', async () => {
    // zip.js will not write such a name, so the name is changed in the bytes, in both headers.
    const bytes = await zipOf({ 'zz/escape.txt': 'no' });
    const evil = Buffer.from(bytes).toString('latin1').replaceAll('zz/escape', '../escape');
    writeFileSync(join(root, 'evil.zip'), Buffer.from(evil, 'latin1'));
    await expect(createNodeArchive(media).extract('evil.zip', 'out')).rejects.toThrow(/Unsafe filename|Invalid app file path/);
  });
});
