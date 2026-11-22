// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  type AppFiles,
  PLUGIN_CHOICES_PATH,
  type PluginChoices,
  type ProcessRun,
  parsePluginChoices,
} from '@ridrs/contracts';

/** The programs granted to the installed plugins that are switched on. */
export function grantedPrograms(choices: PluginChoices): Set<string> {
  return new Set(
    Object.entries(choices.programs)
      .filter(([id]) => !choices.disabled.includes(id))
      .flatMap(([, programs]) => programs),
  );
}

/**
 * `process.run` on Node (ADR 0106): a granted program, found on the `PATH`, started without a
 * shell; its lines go to `onLine`, aborting ends it. The grants are read anew for every program.
 */
export function nodeProcessRun(files: AppFiles | undefined): ProcessRun {
  return {
    async run({ program, args }, onLine, signal) {
      const choices = parsePluginChoices(files ? await files.read(PLUGIN_CHOICES_PATH).catch(() => undefined) : undefined);
      if (!grantedPrograms(choices).has(program)) {
        throw new Error(`No installed plugin was granted the program "${program}"`);
      }
      const child = spawn(program, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal });
      for (const [stream, name] of [
        [child.stdout, 'out'],
        [child.stderr, 'err'],
      ] as const) {
        createInterface({ input: stream }).on('line', (line) => onLine?.(line, name));
      }
      return new Promise((resolve, reject) => {
        child.once('error', (error) =>
          reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`The program "${program}" was not found`) : error),
        );
        child.once('close', (code) => resolve({ code: code ?? -1 }));
      });
    },
  };
}
