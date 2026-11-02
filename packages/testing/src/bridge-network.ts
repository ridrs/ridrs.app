// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BleBridgeConnector,
  BridgeSocket,
  CompanionAdvert,
  StoredBridgePairing,
} from '@ridrs/contracts';

type Message = string | Uint8Array;

class InMemorySocket implements BridgeSocket {
  peer?: InMemorySocket;
  private readonly messageListeners = new Set<(message: Message) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private closed = false;

  constructor(
    private readonly network: SimulatedNetwork,
    readonly address: string,
  ) {}

  get isOpen(): boolean {
    return !this.closed;
  }

  send(message: Message): void {
    if (this.closed) {
      return;
    }
    const peer = this.peer;
    const copy = typeof message === 'string' ? message : message.slice();
    this.network.deliver(() => peer?.receive(copy));
  }

  onMessage(listener: (message: Message) => void): () => void {
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
    this.shutdown('closed');
  }

  /** Closes this end now and the other end like a TCP FIN would (asynchronously). */
  shutdown(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const peer = this.peer;
    queueMicrotask(() => {
      for (const listener of [...this.closeListeners]) {
        listener(reason);
      }
      peer?.shutdown(reason);
    });
  }

  private receive(message: Message): void {
    if (this.closed) {
      return;
    }
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }
}

interface Listener {
  readonly companionId: string;
  readonly name: string;
  accept(socket: BridgeSocket): void;
  announced: boolean;
  present: boolean;
}

/**
 * A deterministic stand-in for the local network between ridrs and companions: DNS-SD style
 * announcements, message-framed socket pairs, stalls (Wi-Fi power save) and departures. Messages
 * are delivered as microtasks, so fake timers fully control time.
 */
export class SimulatedNetwork {
  private readonly listeners = new Map<string, Listener>();
  private readonly sockets = new Set<InMemorySocket>();
  private readonly watchers = new Set<(companions: readonly CompanionAdvert[]) => void>();
  private stalled?: Array<() => void>;

  listen(
    address: string,
    companion: { companionId: string; name: string; announced?: boolean },
    accept: (socket: BridgeSocket) => void,
  ): void {
    this.listeners.set(address, {
      ...companion,
      accept,
      announced: companion.announced ?? true,
      present: true,
    });
    this.announce();
  }

  async open(address: string): Promise<BridgeSocket> {
    await Promise.resolve();
    const listener = this.listeners.get(address);
    if (!listener?.present) {
      throw new Error(`connect ECONNREFUSED ${address}`);
    }
    const client = new InMemorySocket(this, address);
    const server = new InMemorySocket(this, address);
    client.peer = server;
    server.peer = client;
    this.sockets.add(client).add(server);
    listener.accept(server);
    return client;
  }

  watch(listener: (companions: readonly CompanionAdvert[]) => void): () => void {
    this.watchers.add(listener);
    listener(this.adverts());
    return () => {
      this.watchers.delete(listener);
    };
  }

  setAnnounced(address: string, announced: boolean): void {
    const listener = this.listeners.get(address);
    if (listener) {
      listener.announced = announced;
      this.announce();
    }
  }

  /** The companion's phone leaves the Wi-Fi: its sockets break, it can no longer be reached. */
  leave(address: string): void {
    const listener = this.listeners.get(address);
    if (!listener) {
      return;
    }
    listener.present = false;
    for (const socket of this.sockets) {
      if (socket.address === address) {
        socket.shutdown('network unreachable');
      }
    }
    this.announce();
  }

  join(address: string): void {
    const listener = this.listeners.get(address);
    if (listener) {
      listener.present = true;
      this.announce();
    }
  }

  move(from: string, to: string): void {
    const listener = this.listeners.get(from);
    if (listener) {
      this.listeners.delete(from);
      this.listeners.set(to, listener);
      this.announce();
    }
  }

  /** Holds every message until `resume()`, like a radio in power save. */
  stall(): void {
    this.stalled ??= [];
  }

  resume(): void {
    const held = this.stalled ?? [];
    this.stalled = undefined;
    for (const deliver of held) {
      queueMicrotask(deliver);
    }
  }

  /** @internal */
  deliver(fn: () => void): void {
    if (this.stalled) {
      this.stalled.push(fn);
    } else {
      queueMicrotask(fn);
    }
  }

  private adverts(): CompanionAdvert[] {
    return [...this.listeners]
      .filter(([, l]) => l.announced && l.present)
      .map(([address, l]) => ({ companionId: l.companionId, name: l.name, address }));
  }

  private announce(): void {
    const adverts = this.adverts();
    for (const watcher of [...this.watchers]) {
      watcher(adverts);
    }
  }
}

/** `BleBridgeConnector` on the simulated network, with an in-memory pairing store. */
export class SimulatedBridgeConnector implements BleBridgeConnector {
  pairing?: StoredBridgePairing;
  /** Reject like Tauri IPC does: with the plain error text instead of an `Error`. */
  failuresAsText = false;

  constructor(private readonly network: SimulatedNetwork) {}

  watchCompanions(listener: (companions: readonly CompanionAdvert[]) => void): () => void {
    return this.network.watch(listener);
  }

  open(address: string): Promise<BridgeSocket> {
    const opening = this.network.open(address);
    return this.failuresAsText
      ? opening.catch((error: unknown) => {
          throw error instanceof Error ? error.message : error;
        })
      : opening;
  }

  loadPairing(): StoredBridgePairing | undefined {
    return this.pairing;
  }

  savePairing(pairing: StoredBridgePairing): void {
    this.pairing = pairing;
  }

  clearPairing(): void {
    this.pairing = undefined;
  }
}
