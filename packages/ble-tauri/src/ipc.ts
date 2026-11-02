// SPDX-License-Identifier: AGPL-3.0-or-later

import { Channel, invoke } from '@tauri-apps/api/core';

/** The slice of Tauri IPC the adapter uses; faked in tests. */
export interface IpcChannel<T> {
  onmessage: (message: T) => void;
}

export interface BleIpc {
  invoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T>;
  createChannel<T>(): IpcChannel<T>;
}

export function createTauriIpc(): BleIpc {
  return {
    invoke: (command, args) => invoke(command, args),
    createChannel: <T>() => new Channel<T>(),
  };
}
