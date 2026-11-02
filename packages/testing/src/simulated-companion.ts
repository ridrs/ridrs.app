// SPDX-License-Identifier: AGPL-3.0-or-later

import { BridgeServer, PairingAuthority, type PairingState } from '@ridrs/ble-bridge';
import type { BleCentral, Clock } from '@ridrs/contracts';
import type { SimulatedNetwork } from './bridge-network.ts';

export interface SimulatedCompanionOptions {
  readonly network: SimulatedNetwork;
  readonly name: string;
  readonly address: string;
  /** What the companion forwards: a simulator, dummy devices, or both. */
  readonly central: BleCentral;
  readonly clock: Clock;
  /** The pairing code the phone shows (every fresh code too). */
  readonly code: string;
  readonly announced?: boolean;
}

/**
 * The companion app minus its UI and Rust shell: pairing authority and bridge server, listening
 * on the simulated network. Its clock can run off the ridrs clock, like a real phone's.
 */
export class SimulatedCompanion {
  authority: PairingAuthority;
  server: BridgeServer;
  address: string;
  clockOffsetMs = 0;
  /** What the phone keeps across app restarts. */
  private stored?: PairingState;
  private seed = 0;

  constructor(private readonly options: SimulatedCompanionOptions) {
    this.address = options.address;
    [this.authority, this.server] = this.boot();
    options.network.listen(
      options.address,
      { companionId: this.authority.companionId, name: options.name, announced: options.announced },
      (socket) => this.server.accept(socket),
    );
  }

  /** The companion app is closed and opened again: sockets drop, pairings and pauses stay. */
  restart(): void {
    this.server.close();
    [this.authority, this.server] = this.boot();
  }

  private boot(): [PairingAuthority, BridgeServer] {
    const clock: Clock = { now: () => this.options.clock.now() + this.clockOffsetMs };
    const authority = new PairingAuthority({
      clock,
      generateCode: () => this.options.code,
      store: {
        load: () => this.stored,
        save: (state) => {
          this.stored = state;
        },
      },
      // Deterministic ids and tokens: tests compare them, never guess them.
      randomBytes: (length) => Uint8Array.from({ length }, () => (this.seed++ * 37 + 11) % 256),
    });
    const server = new BridgeServer({
      central: this.options.central,
      authority,
      clock,
      companionName: this.options.name,
    });
    return [authority, server];
  }

  leave(): void {
    this.options.network.leave(this.address);
  }

  join(): void {
    this.options.network.join(this.address);
  }

  moveTo(address: string): void {
    this.options.network.move(this.address, address);
    this.address = address;
  }
}
