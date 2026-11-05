// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BleIpc } from '@ridrs/ble-tauri';
import type {
  BleBridgeConnector,
  BridgeSocket,
  CompanionAdvert,
  Secrets,
  StoredBridgePairing,
} from '@ridrs/contracts';

/** Tags of `crates/ridrs-bridge` client socket events (`tag | body`). */
const TAG_TEXT = 1;
const TAG_BINARY = 2;
const TAG_CLOSED = 3;

/** The pairing's key in `storage.secrets` (ADR 0053): its token is the secret. */
export const PAIRING_SECRET = 'bridge.pairing';
/** Where ridrs kept the pairing before, in the WebView's local storage. */
const LEGACY_PAIRING_KEY = 'ridrs.bridge.pairing';

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

/** Damaged data must not jam the app: it counts as no pairing, the rider pairs again. */
function parsePairing(raw: string | null | undefined): StoredBridgePairing | undefined {
  try {
    const pairing = raw ? (JSON.parse(raw) as Partial<StoredBridgePairing>) : undefined;
    return pairing && isPairing(pairing) ? pairing : undefined;
  } catch {
    return undefined;
  }
}

type LegacyStorage = Pick<Storage, 'getItem' | 'removeItem'>;

function webStorage(): LegacyStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The pairing in `storage.secrets` (ADR 0053), read once when the plugin initializes and kept in
 * memory; saves go to the store one after another. A pairing an older ridrs left in the WebView's
 * local storage moves to the store once. A failing store only means pairing again after a restart.
 */
export async function secretPairingStore(
  secrets: Secrets,
  legacy: LegacyStorage | undefined = webStorage(),
  warn: (message: string, error: unknown) => void = console.warn,
): Promise<PairingStore> {
  let pairing = parsePairing(
    await secrets.get(PAIRING_SECRET).catch((error: unknown) => {
      warn('the companion pairing could not be read', error);
      return undefined;
    }),
  );
  let legacyRaw: string | null | undefined;
  try {
    legacyRaw = legacy?.getItem(LEGACY_PAIRING_KEY);
  } catch {
    legacyRaw = undefined;
  }
  if (legacyRaw !== null && legacyRaw !== undefined) {
    const moved = pairing ? undefined : parsePairing(legacyRaw);
    try {
      if (moved) {
        await secrets.set(PAIRING_SECRET, JSON.stringify(moved));
        pairing = moved;
      }
      legacy?.removeItem(LEGACY_PAIRING_KEY);
    } catch (error) {
      // Kept where it was: the next start tries again.
      warn('the companion pairing could not move to the secret store', error);
      pairing ??= moved;
    }
  }
  let writes = Promise.resolve();
  const enqueue = (write: () => Promise<void>): void => {
    writes = writes
      .then(write)
      .catch((error: unknown) => warn('the companion pairing could not be saved', error));
  };
  return {
    load: () => pairing,
    save(next) {
      pairing = next;
      const value = JSON.stringify(next);
      enqueue(() => secrets.set(PAIRING_SECRET, value));
    },
    clear() {
      pairing = undefined;
      enqueue(() => secrets.remove(PAIRING_SECRET));
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
