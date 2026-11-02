// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BleIpc } from '@ridrs/ble-tauri';
import type {
  BleBridgeConnector,
  BridgeSocket,
  CompanionAdvert,
  StoredBridgePairing,
} from '@ridrs/contracts';

/** Tags of `crates/ridrs-bridge` client socket events (`tag | body`). */
const TAG_TEXT = 1;
const TAG_BINARY = 2;
const TAG_CLOSED = 3;

const PAIRING_KEY = 'ridrs.bridge.pairing';

export interface PairingStore {
  load(): StoredBridgePairing | undefined;
  save(pairing: StoredBridgePairing): void;
  clear(): void;
}

function isPairing(value: Partial<StoredBridgePairing>): value is StoredBridgePairing {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.companionId === 'string' &&
    typeof value.companionName === 'string' &&
    typeof value.address === 'string' &&
    typeof value.token === 'string' &&
    (value.forgotten === undefined || typeof value.forgotten === 'boolean')
  );
}

/** The WebView's local storage; a failing storage only means pairing again after a restart. */
export function webStoragePairingStore(): PairingStore {
  return {
    load() {
      try {
        const raw = localStorage.getItem(PAIRING_KEY);
        if (!raw) {
          return undefined;
        }
        const pairing = JSON.parse(raw) as Partial<StoredBridgePairing>;
        if (isPairing(pairing)) {
          return pairing;
        }
        // Damaged data must not jam the app: forget it, the rider pairs again.
        localStorage.removeItem(PAIRING_KEY);
        return undefined;
      } catch {
        return undefined;
      }
    },
    save(pairing) {
      try {
        localStorage.setItem(PAIRING_KEY, JSON.stringify(pairing));
      } catch {
        // see above
      }
    },
    clear() {
      try {
        localStorage.removeItem(PAIRING_KEY);
      } catch {
        // see above
      }
    },
  };
}

class IpcBridgeSocket implements BridgeSocket {
  socketId?: number;
  private readonly messageListeners = new Set<(message: string | Uint8Array) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readonly decoder = new TextDecoder();
  private closed = false;

  constructor(private readonly ipc: BleIpc) {}

  /** One event of the Rust socket: `tag | body`. */
  receive(message: ArrayBuffer | number[]): void {
    const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : Uint8Array.from(message);
    const body = bytes.subarray(1);
    if (bytes[0] === TAG_TEXT) {
      const text = this.decoder.decode(body);
      for (const listener of [...this.messageListeners]) listener(text);
    } else if (bytes[0] === TAG_BINARY) {
      const copy = body.slice();
      for (const listener of [...this.messageListeners]) listener(copy);
    } else if (bytes[0] === TAG_CLOSED) {
      this.finish(this.decoder.decode(body));
    }
  }

  send(message: string | Uint8Array): void {
    if (this.closed || this.socketId === undefined) {
      return;
    }
    if (typeof message !== 'string') {
      // ridrs only sends JSON to the companion; binary flows the other way.
      throw new Error('Binary messages to the companion are not supported');
    }
    void this.ipc
      .invoke('bridge_send_text', { socketId: this.socketId, text: message })
      .catch(() => undefined);
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
    if (this.socketId !== undefined && !this.closed) {
      void this.ipc.invoke('bridge_close', { socketId: this.socketId }).catch(() => undefined);
    }
    this.finish('closed by ridrs');
  }

  private finish(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener(reason);
  }
}

/** The companion network through `crates/ridrs-bridge` (mDNS browse, WebSocket in Rust). */
export class TauriBridgeConnector implements BleBridgeConnector {
  constructor(
    private readonly ipc: BleIpc,
    private readonly pairings: PairingStore,
  ) {}

  watchCompanions(listener: (companions: readonly CompanionAdvert[]) => void): () => void {
    const channel = this.ipc.createChannel<CompanionAdvert[]>();
    let active = true;
    channel.onmessage = (companions) => {
      if (active) listener(companions);
    };
    void this.ipc.invoke('bridge_browse', { onEvent: channel }).catch((error: unknown) => {
      console.warn('companion discovery failed', error);
    });
    return () => {
      active = false;
      void this.ipc.invoke('bridge_stop_browse').catch(() => undefined);
    };
  }

  async open(address: string): Promise<BridgeSocket> {
    const socket = new IpcBridgeSocket(this.ipc);
    const channel = this.ipc.createChannel<ArrayBuffer | number[]>();
    channel.onmessage = (message) => socket.receive(message);
    try {
      socket.socketId = await this.ipc.invoke<number>('bridge_open', {
        address,
        onMessage: channel,
      });
    } catch (error) {
      // Tauri rejects with the Rust error text; callers (and p-retry) expect an Error.
      throw error instanceof Error ? error : new Error(`${address}: ${String(error)}`);
    }
    return socket;
  }

  loadPairing(): StoredBridgePairing | undefined {
    return this.pairings.load();
  }

  savePairing(pairing: StoredBridgePairing): void {
    this.pairings.save(pairing);
  }

  clearPairing(): void {
    this.pairings.clear();
  }
}
