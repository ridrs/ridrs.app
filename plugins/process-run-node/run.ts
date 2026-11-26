// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ChildProcess, spawn } from 'node:child_process';
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

type OnLine = (line: string, stream: 'out' | 'err') => void;

/** A program that runs: who hears its lines, and its exit code once it has ended. */
interface Running {
  readonly child: ChildProcess;
  readonly listeners: Set<OnLine>;
  readonly done: Promise<number>;
}

/** Hears `running` until it ends; aborting `signal` ends it, for every caller (ADR 0112). */
async function join(running: Running, onLine: OnLine | undefined, signal: AbortSignal | undefined) {
  if (onLine) running.listeners.add(onLine);
  const end = () => void running.child.kill();
  if (signal?.aborted) end();
  signal?.addEventListener('abort', end, { once: true });
  try {
    return { code: await running.done };
  } finally {
    signal?.removeEventListener('abort', end);
    if (onLine) running.listeners.delete(onLine);
  }
}

/**
 * `process.run` on Node (ADR 0106): a granted program, found on the `PATH`, started without a
 * shell; its lines go to `onLine`, aborting ends it. The grants are read anew for every program.
 * One program runs under a key; a caller with the same key attaches to it (ADR 0112).
 */
export function nodeProcessRun(files: AppFiles | undefined): ProcessRun {
  const keyed = new Map<string, Running>();
  return {
    async run({ program, args, key }, onLine, signal) {
      const choices = parsePluginChoices(files ? await files.read(PLUGIN_CHOICES_PATH).catch(() => undefined) : undefined);
      if (!grantedPrograms(choices).has(program)) {
        throw new Error(`No installed plugin was granted the program "${program}"`);
      }
      const found = key === undefined ? undefined : keyed.get(key);
      if (found) return join(found, onLine, signal);
      const child = spawn(program, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      const listeners = new Set<OnLine>();
      for (const [stream, name] of [
        [child.stdout, 'out'],
        [child.stderr, 'err'],
      ] as const) {
        createInterface({ input: stream }).on('line', (line) => {
          for (const listener of listeners) listener(line, name);
        });
      }
      const done = new Promise<number>((resolve, reject) => {
        const forget = () => {
          if (key !== undefined && keyed.get(key) === running) keyed.delete(key);
        };
        child.once('error', (error) => {
          forget();
          reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`The program "${program}" was not found`) : error);
        });
        child.once('close', (code) => {
          forget();
          resolve(code ?? -1);
        });
      });
      const running: Running = { child, listeners, done };
      if (key !== undefined) keyed.set(key, running);
      return join(running, onLine, signal);
    },
    async attach(key, onLine, signal) {
      const running = keyed.get(key);
      return running ? join(running, onLine, signal) : undefined;
    },
  };
}
