// SPDX-License-Identifier: AGPL-3.0-or-later

import { type AppFiles, PLUGIN_CHOICES_PATH } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { grantedPrograms, nodeProcessRun } from './run.ts';

/** App files that hold only the rider's choices of plugins. */
const granted = (choices: object) =>
  ({
    read: async (path: string) => {
      if (path !== PLUGIN_CHOICES_PATH) throw new Error(`No file ${path}`);
      return new TextEncoder().encode(JSON.stringify({ version: 1, disabled: [], programs: {}, ...choices }));
    },
  }) as unknown as AppFiles;

describe('grantedPrograms', () => {
  it('grants the programs of the plugins that are on', () => {
    expect([...grantedPrograms({ version: 1, disabled: ['off'], programs: { on: ['node'], off: ['yt-dlp'] } })]).toEqual(['node']);
  });
});

describe('nodeProcessRun', () => {
  it('runs a granted program without a shell and hears its lines', async () => {
    const lines: string[] = [];
    const run = nodeProcessRun(granted({ programs: { tester: ['node'] } }));
    const { code } = await run.run({ program: 'node', args: ['-e', 'console.log("a; b")'] }, (line) => lines.push(line));
    expect(code).toBe(0);
    expect(lines).toEqual(['a; b']);
  });

  it('refuses a program no plugin was granted', async () => {
    await expect(nodeProcessRun(granted({})).run({ program: 'node', args: [] })).rejects.toThrow(
      'No installed plugin was granted the program "node"',
    );
  });

  it('says when a granted program is not on the device', async () => {
    const run = nodeProcessRun(granted({ programs: { tester: ['no-such-program-ridrs'] } }));
    await expect(run.run({ program: 'no-such-program-ridrs', args: [] })).rejects.toThrow('was not found');
  });
});
