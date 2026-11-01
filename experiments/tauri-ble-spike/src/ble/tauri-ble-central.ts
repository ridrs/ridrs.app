// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BleCentral,
  type BleCharacteristicTarget,
  type BleConnection,
  type BleDiscoveredPeripheral,
  type BleScanOptions,
  normalizeBleUuid,
} from '@ridrs/contracts';
import { decodeNotificationFrame, type NotificationFrame } from './frame.ts';
import { type BleIpc, createTauriIpc } from './ipc.ts';

interface ScanEvent {
  readonly peripheralId: string;
  readonly name: string;
  readonly serviceUuids: readonly string[];
  readonly rssi: number | null;
}

interface ConnectionLostEvent {
  readonly peripheralId: string;
}

/** Scan result with the RSSI the contract does not carry (contract gap, see FINDINGS.md). */
export interface SpikeDiscoveredPeripheral extends BleDiscoveredPeripheral {
  readonly rssi: number | null;
}

export interface TimedNotification extends NotificationFrame {
  /** JS wall-clock time when the handler ran, for the IPC latency probe. */
  readonly jsWallMs: number;
}

export interface BleWriteOptions {
  readonly withResponse: boolean;
}

/** Experiment-local extension: what `BleConnection` lacks for trainer control and Zwift Ride. */
export interface SpikeBleConnection extends BleConnection {
  write(target: BleCharacteristicTarget, data: Uint8Array, options: BleWriteOptions): Promise<void>;
  subscribeTimed(
    target: BleCharacteristicTarget,
    onNotification: (notification: TimedNotification) => void,
  ): Promise<() => void>;
}

export interface TauriBleCentralOptions {
  /** Sub-millisecond wall clock for latency measurement; not used for measurement timestamps. */
  readonly wallClockMs?: () => number;
}

const defaultWallClockMs = () => performance.timeOrigin + performance.now();

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

function targetArgs(target: BleCharacteristicTarget) {
  return {
    serviceUuid: normalizeBleUuid(target.serviceUuid),
    characteristicUuid: normalizeBleUuid(target.characteristicUuid),
  };
}

class TauriBleConnection implements SpikeBleConnection {
  private readonly listeners = new Set<() => void>();
  private closedByUser = false;
  private lost = false;

  constructor(
    readonly peripheralId: string,
    private readonly ipc: BleIpc,
    private readonly wallClockMs: () => number,
  ) {}

  /** Called by the central when Rust reports the link as gone. */
  handleConnectionLost(): void {
    if (this.closedByUser || this.lost) {
      return;
    }
    this.lost = true;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  async subscribe(
    target: BleCharacteristicTarget,
    onNotification: (data: Uint8Array) => void,
  ): Promise<() => void> {
    return this.subscribeTimed(target, (notification) => onNotification(notification.data));
  }

  async subscribeTimed(
    target: BleCharacteristicTarget,
    onNotification: (notification: TimedNotification) => void,
  ): Promise<() => void> {
    const args = { peripheralId: this.peripheralId, ...targetArgs(target) };
    const channel = this.ipc.createChannel<ArrayBuffer | number[]>();
    let active = true;
    channel.onmessage = (message) => {
      if (!active) {
        return;
      }
      const jsWallMs = this.wallClockMs();
      onNotification({ ...decodeNotificationFrame(message), jsWallMs });
    };
    await this.ipc.invoke('ble_subscribe', { ...args, onNotification: channel });
    return () => {
      if (!active) {
        return;
      }
      active = false;
      channel.onmessage = () => undefined;
      void this.ipc.invoke('ble_unsubscribe', args).catch(() => undefined);
    };
  }

  async write(target: BleCharacteristicTarget, data: Uint8Array, options: BleWriteOptions): Promise<void> {
    // Writes are rare (control points), so a JSON number array is acceptable here.
    await this.ipc.invoke('ble_write', {
      peripheralId: this.peripheralId,
      ...targetArgs(target),
      data: [...data],
      withResponse: options.withResponse,
    });
  }

  onDisconnected(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async disconnect(): Promise<void> {
    this.closedByUser = true;
    await this.ipc.invoke('ble_disconnect', { peripheralId: this.peripheralId });
  }
}

/** `BleCentral` on top of the spike's Rust BLE commands (`src-tauri/src/ble.rs`). */
export class TauriBleCentral implements BleCentral {
  private readonly wallClockMs: () => number;

  constructor(
    private readonly ipc: BleIpc = createTauriIpc(),
    options: TauriBleCentralOptions = {},
  ) {
    this.wallClockMs = options.wallClockMs ?? defaultWallClockMs;
  }

  /** Android runtime permissions; resolves `true` on platforms that ask on first use. */
  checkPermissions(askIfDenied = true): Promise<boolean> {
    return this.ipc.invoke<boolean>('ble_check_permissions', { askIfDenied });
  }

  async *scan(options: BleScanOptions): AsyncIterable<SpikeDiscoveredPeripheral> {
    const { signal } = options;
    if (signal?.aborted) {
      return;
    }

    const queue: SpikeDiscoveredPeripheral[] = [];
    const seen = new Set<string>();
    let wake: (() => void) | undefined;
    let finished = false;
    const finish = () => {
      finished = true;
      wake?.();
    };

    const channel = this.ipc.createChannel<ScanEvent>();
    channel.onmessage = (event) => {
      if (finished || seen.has(event.peripheralId)) {
        return;
      }
      seen.add(event.peripheralId);
      queue.push({
        peripheralId: event.peripheralId,
        name: event.name,
        serviceUuids: event.serviceUuids.map(normalizeBleUuid),
        rssi: event.rssi,
      });
      wake?.();
    };
    signal?.addEventListener('abort', finish, { once: true });

    try {
      await this.ipc.invoke('ble_scan', {
        serviceUuids: options.serviceUuids.map(normalizeBleUuid),
        onEvent: channel,
      });
      while (!finished) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      finished = true;
      channel.onmessage = () => undefined;
      signal?.removeEventListener('abort', finish);
      await this.ipc.invoke('ble_stop_scan').catch(() => undefined);
    }
  }

  async connect(
    peripheralId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SpikeBleConnection> {
    const { signal } = options;
    if (signal?.aborted) {
      throw abortError();
    }
    const connection = new TauriBleConnection(peripheralId, this.ipc, this.wallClockMs);
    const lostChannel = this.ipc.createChannel<ConnectionLostEvent>();
    lostChannel.onmessage = () => connection.handleConnectionLost();

    await this.ipc.invoke('ble_connect', { peripheralId, onConnectionLost: lostChannel });
    if (signal?.aborted) {
      await connection.disconnect().catch(() => undefined);
      throw abortError();
    }
    return connection;
  }
}
