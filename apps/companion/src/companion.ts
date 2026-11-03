// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BridgeServer,
  type BridgeServerStatus,
  PairingAuthority,
  type PairingStore,
} from '@ridrs/ble-bridge';
import {
  BLE_BRIDGE_PROTOCOL_VERSION,
  type BleCentral,
  parsePairingUri,
  type TimeSource,
} from '@ridrs/contracts';
import { type CompanionIpc, type ServeInfo, serveOverIpc } from './ipc-server.ts';

/** Default listening port: stays the same across restarts so a stored address keeps working. */
export const DEFAULT_BRIDGE_PORT = 42229;

export interface CompanionOptions {
  readonly ipc: CompanionIpc;
  /** Native Bluetooth, or native Bluetooth merged with dummy devices in the developer build. */
  readonly central: BleCentral;
  readonly name: string;
  readonly pairingStore: PairingStore;
  readonly port?: number;
  readonly clock?: TimeSource;
}

export interface CompanionView {
  readonly name: string;
  readonly code: string;
  readonly serve: ServeInfo;
  readonly status: BridgeServerStatus;
  /** Name of the ridrs whose QR code was scanned last; it pairs as soon as it reaches the phone. */
  readonly scannedFor?: string;
}

export interface Companion {
  view(): CompanionView;
  onChange(listener: () => void): () => void;
  /**
   * Takes the text of a scanned QR code. A ridrs pairing code lets that ridrs pair once within
   * ten minutes; returns its name, or `undefined` for any other QR code.
   */
  acceptPairingQr(text: string): string | undefined;
  /** Ends the session with this ridrs; it does not reconnect until someone presses Connect. */
  disconnect(token: string): void;
  /** Lifts a deliberate disconnect: the ridrs connects on its next attempt (within 3 s). */
  connect(token: string): void;
  /** Revokes this ridrs's pairing, on both devices. */
  forget(token: string): void;
  stop(): Promise<void>;
}

/**
 * Composition root of the companion: pairing authority and bridge server on top of the Rust
 * listener. Everything but the socket plumbing is the same code the Cucumber scenarios run.
 */
export async function startCompanion(options: CompanionOptions): Promise<Companion> {
  const clock = options.clock ?? { now: () => Date.now() };
  const authority = new PairingAuthority({ clock, store: options.pairingStore });
  const server = new BridgeServer({
    central: options.central,
    authority,
    clock,
    companionName: options.name,
  });
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  server.onStatus(changed);

  const served = await serveOverIpc(
    options.ipc,
    {
      name: options.name,
      companionId: authority.companionId,
      protocol: BLE_BRIDGE_PROTOCOL_VERSION,
      port: options.port ?? DEFAULT_BRIDGE_PORT,
    },
    (socket) => server.accept(socket),
  );

  let scannedFor: string | undefined;
  server.onStatus((status) => {
    if (status.client !== undefined) {
      scannedFor = undefined;
    }
  });

  return {
    view: () => ({
      name: options.name,
      code: authority.code,
      serve: served.info,
      status: server.status(),
      scannedFor,
    }),
    acceptPairingQr(text) {
      const offer = parsePairingUri(text.trim());
      if (!offer) {
        return undefined;
      }
      authority.acceptScannedSecret(offer.secret);
      scannedFor = offer.name || 'ridrs';
      changed();
      return scannedFor;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    disconnect: (token) => server.disconnect(token),
    connect: (token) => server.connect(token),
    forget: (token) => server.forget(token),
    async stop() {
      server.close();
      await served.stop();
    },
  };
}
