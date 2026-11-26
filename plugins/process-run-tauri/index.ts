// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, type ProcessRun, processRunCapability } from '@ridrs/contracts';
import { Channel, invoke } from '@tauri-apps/api/core';

type OnLine = (line: string, stream: 'out' | 'err') => void;

/**
 * Each caller's id while its program runs, to end it: unique beyond a reload of the page, since
 * the native side keeps the programs of the page before (ADR 0112).
 */
const page = crypto.randomUUID();
let next = 0;

/**
 * Calls `command` with a new caller id and a channel for the lines; aborting `signal` ends the
 * program through `process_cancel`.
 */
async function call<T>(command: string, args: Record<string, unknown>, onLine?: OnLine, signal?: AbortSignal): Promise<T> {
  next += 1;
  const id = `process-${page}-${next}`;
  const lines = new Channel<{ stream: 'out' | 'err'; line: string }>();
  lines.onmessage = ({ stream, line }) => onLine?.(line, stream);
  const cancel = () => void invoke('process_cancel', { id }).catch(() => undefined);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await invoke<T>(command, { ...args, id, onLine: lines });
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

/**
 * `process.run` in the native app (ADR 0106, 0112): the app's commands `process_run`,
 * `process_attach` and `process_cancel` (apps/native/src-tauri/src/process_run.rs) start a program
 * the rider granted to an installed plugin, without a shell, find a program under a key again
 * after a reload, and end it.
 */
const run: ProcessRun = {
  async run({ program, args, key }, onLine, signal) {
    const code = await call<number>('process_run', { program, args: [...args], key: key ?? null }, onLine, signal);
    return { code };
  },
  async attach(key, onLine, signal) {
    const code = await call<number | null>('process_attach', { key }, onLine, signal);
    return code === null ? undefined : { code };
  },
};

export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(processRunCapability, run);
  },
});
