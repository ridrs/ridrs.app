// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IpcChannel } from '@ridrs/ble-tauri';
import type { BridgeSocket } from '@ridrs/contracts';

/** Tags of `crates/ridrs-bridge` server events (`tag | u32 LE socket id | body`). */
const TAG_OPENED = 0;
const TAG_TEXT = 1;
const TAG_BINARY = 2;
const TAG_CLOSED = 3;

/** The slice of Tauri IPC the server adapter uses; faked in tests. */
export interface CompanionIpc {
  invoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T>;
  createChannel<T>(): IpcChannel<T>;
}

export interface ServeInfo {
  readonly port: number;
  readonly addresses: readonly string[];
}

class IpcServerSocket implements BridgeSocket {
  private readonly messageListeners = new Set<(message: string | Uint8Array) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private closed = false;
  private sendFailed = false;

  constructor(
    private readonly ipc: CompanionIpc,
    readonly socketId: number,
  ) {}

  receive(message: string | Uint8Array): void {
    for (const listener of [...this.messageListeners]) listener(message);
  }

  send(message: string | Uint8Array): void {
    if (this.closed) {
      return;
    }
    const sent =
      typeof message === 'string'
        ? this.ipc.invoke('bridge_server_send_text', { socketId: this.socketId, text: message })
        : // A byte array, not a raw request body: Android's IPC does not deliver raw bodies.
          this.ipc.invoke('bridge_server_send_binary', {
            socketId: this.socketId,
            data: Array.from(message),
          });
    // A send to a socket Rust already dropped fails and its close event follows; anything else is
    // a real problem, reported once per socket.
    void sent.catch((error: unknown) => {
      if (!this.closed && !this.sendFailed) {
        this.sendFailed = true;
        console.warn(`bridge socket ${this.socketId}: send failed`, error);
      }
    });
  }

  onMessage(listener: (message: string | Uint8Array) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  close(): void {
    if (!this.closed) {
      void this.ipc
        .invoke('bridge_server_close', { socketId: this.socketId })
        .catch(() => undefined);
    }
    this.finish('closed by companion');
  }

  finish(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener(reason);
  }
}

/**
 * Starts the Rust bridge server (listener + mDNS announcement) and hands every accepted
 * connection to `accept` as a `BridgeSocket`. Starting again replaces the previous server.
 */
export async function serveOverIpc(
  ipc: CompanionIpc,
  advert: {
    readonly name: string;
    readonly companionId: string;
    readonly protocol: string;
    /** Preferred listening port; Rust falls back to any free port. */
    readonly port: number;
  },
  accept: (socket: BridgeSocket, peer: string) => void,
): Promise<{ info: ServeInfo; stop: () => Promise<void> }> {
  const sockets = new Map<number, IpcServerSocket>();
  const decoder = new TextDecoder();
  const channel = ipc.createChannel<ArrayBuffer | number[]>();
  channel.onmessage = (message) => {
    const bytes =
      message instanceof ArrayBuffer ? new Uint8Array(message) : Uint8Array.from(message);
    if (bytes.byteLength < 5) {
      return;
    }
    const socketId = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1, true);
    const body = bytes.subarray(5);
    switch (bytes[0]) {
      case TAG_OPENED: {
        const socket = new IpcServerSocket(ipc, socketId);
        sockets.set(socketId, socket);
        accept(socket, decoder.decode(body));
        return;
      }
      case TAG_TEXT:
        sockets.get(socketId)?.receive(decoder.decode(body));
        return;
      case TAG_BINARY:
        sockets.get(socketId)?.receive(body.slice());
        return;
      case TAG_CLOSED:
        sockets.get(socketId)?.finish(decoder.decode(body));
        sockets.delete(socketId);
        return;
      default:
        return;
    }
  };
  const info = await ipc.invoke<ServeInfo>('bridge_serve', { ...advert, onEvent: channel });
  return {
    info,
    stop: async () => {
      for (const socket of sockets.values()) socket.finish('companion stopped');
      sockets.clear();
      await ipc.invoke('bridge_unserve');
    },
  };
}
