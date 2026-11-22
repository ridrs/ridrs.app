// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, type ProcessRun, processRunCapability } from '@ridrs/contracts';
import { Channel, invoke } from '@tauri-apps/api/core';

/** Each program's id while it runs, to end it. */
let next = 0;

/**
 * `process.run` in the native app (ADR 0106): the app's commands `process_run` and
 * `process_cancel` (apps/native/src-tauri/src/process_run.rs) start a program the rider granted
 * to an installed plugin, without a shell, and end it.
 */
const run: ProcessRun = {
  async run({ program, args }, onLine, signal) {
    next += 1;
    const id = `process-${next}`;
    const lines = new Channel<{ stream: 'out' | 'err'; line: string }>();
    lines.onmessage = ({ stream, line }) => onLine?.(line, stream);
    const cancel = () => void invoke('process_cancel', { id }).catch(() => undefined);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const code = await invoke<number>('process_run', { id, program, args: [...args], onLine: lines });
      return { code };
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  },
};

export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(processRunCapability, run);
  },
});
