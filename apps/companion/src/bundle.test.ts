// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const outDirs: string[] = [];

/** Builds the companion web bundle in `mode` and returns all of its JavaScript. */
async function bundle(mode: string): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), `ridrs-companion-${mode}-`));
  outDirs.push(outDir);
  await build({ root, mode, logLevel: 'silent', build: { outDir, sourcemap: false } });
  const assets = join(outDir, 'assets');
  const files = (await readdir(assets)).filter((f) => f.endsWith('.js'));
  return (await Promise.all(files.map((f) => readFile(join(assets, f), 'utf8')))).join('\n');
}

afterAll(async () => {
  await Promise.all(outDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('companion bundle', () => {
  it('leaves the dummy devices and the simulator out of a release build', async () => {
    const js = await bundle('production');
    expect(js).not.toContain('ridrs-companion-dummy-devices');
    expect(js).not.toContain('KICKR SIM');
  });

  it('contains them in the developer build', async () => {
    const js = await bundle('dummy');
    expect(js).toContain('ridrs-companion-dummy-devices');
    expect(js).toContain('KICKR SIM');
  });
}, 60_000);
