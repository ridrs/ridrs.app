// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BleIpc, IpcChannel } from '../src/ble/ipc.ts';

export interface RecordedInvoke {
  readonly command: string;
  readonly args: Record<string, unknown>;
}

/** In-memory stand-in for Tauri IPC: records commands and lets tests push channel messages. */
export class FakeIpc implements BleIpc {
  readonly calls: RecordedInvoke[] = [];
  private readonly handlers = new Map<string, (args: Record<string, unknown>) => unknown>();

  on(command: string, handler: (args: Record<string, unknown>) => unknown): void {
    this.handlers.set(command, handler);
  }

  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ command, args });
    const handler = this.handlers.get(command);
    return (await handler?.(args)) as T;
  }

  createChannel<T>(): IpcChannel<T> {
    return { onmessage: () => undefined };
  }

  callsOf(command: string): RecordedInvoke[] {
    return this.calls.filter((call) => call.command === command);
  }

  /** The channel passed as `argName` to the latest call of `command`. */
  channel<T>(command: string, argName: string): IpcChannel<T> {
    const call = this.callsOf(command).at(-1);
    if (!call) {
      throw new Error(`no call of ${command}`);
    }
    return call.args[argName] as IpcChannel<T>;
  }
}

export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
