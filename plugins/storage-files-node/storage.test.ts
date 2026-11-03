// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeAppFiles } from './index.ts';

describe('storage-files-node', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function files() {
    const root = await mkdtemp(join(tmpdir(), 'ridrs-files-'));
    roots.push(root);
    return createNodeAppFiles(root);
  }

  it('appends, writes, lists, reads and removes below the root', async () => {
    const appFiles = await files();
    expect(await appFiles.list('recordings')).toEqual([]);
    await appFiles.append('recordings/a.ridrs.jsonl', 'one\n');
    await appFiles.append('recordings/a.ridrs.jsonl', 'two\n');
    await appFiles.write('recordings/a.ridrs', Uint8Array.of(1, 2, 3));
    expect(await appFiles.list('recordings')).toEqual([
      { path: 'recordings/a.ridrs', bytes: 3 },
      { path: 'recordings/a.ridrs.jsonl', bytes: 8 },
    ]);
    expect(new TextDecoder().decode(await appFiles.read('recordings/a.ridrs.jsonl'))).toBe('one\ntwo\n');
    await appFiles.remove('recordings/a.ridrs.jsonl');
    expect((await appFiles.list('recordings')).map((e) => e.path)).toEqual(['recordings/a.ridrs']);
  });

  it.each(['../escape', '/etc/passwd', 'recordings//a', 'recordings/./a', 'C:/x', 'a\\b', ''])(
    'rejects the path "%s"',
    async (path) => {
      await expect((await files()).write(path, Uint8Array.of(1))).rejects.toMatchObject({
        code: 'invalid-path',
      });
    },
  );
});
