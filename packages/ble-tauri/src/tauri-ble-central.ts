// SPDX-License-Identifier: AGPL-3.0-or-later

import { SharedBleScan } from '@ridrs/ble-peripheral';
import {
  type BleCentral,
  type BleCharacteristicTarget,
  type BleConnection,
  type BleDiscoveredPeripheral,
  type BleScanOptions,
  normalizeBleUuid,
} from '@ridrs/contracts';
import { decodeNotificationFrame } from './frame.ts';
import type { BleIpc } from './ipc.ts';

/** Scan event as sent by `ble_scan` in `apps/native/src-tauri/src/ble.rs`. */
interface ScanEvent {
  readonly peripheralId: string;
  readonly name: string;
  readonly serviceUuids: readonly string[];
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

function targetArgs(target: BleCharacteristicTarget) {
  return {
    serviceUuid: normalizeBleUuid(target.serviceUuid),
    characteristicUuid: normalizeBleUuid(target.characteristicUuid),
  };
}

class TauriBleConnection implements BleConnection {
  private readonly listeners = new Set<() => void>();
  private closedByUser = false;
  private lost = false;

  constructor(
    readonly peripheralId: string,
    private readonly ipc: BleIpc,
  ) {}

  /** Called when Rust reports the link as gone: at most once, never after `disconnect()`. */
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
    const args = { peripheralId: this.peripheralId, ...targetArgs(target) };
    const channel = this.ipc.createChannel<ArrayBuffer | number[]>();
    let active = true;
    channel.onmessage = (message) => {
      if (active) {
        // Rust receive timestamps in the frame are diagnostics only; receive time stays the host clock.
        onNotification(decodeNotificationFrame(message).data);
      }
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

/** `BleCentral` on top of the app-local Rust BLE commands (native backends via tauri-plugin-blec). */
export class TauriBleCentral implements BleCentral {
  /** blec runs one scan at a time; device plugins scan concurrently for their own services. */
  private readonly scans: SharedBleScan;

  constructor(private readonly ipc: BleIpc) {
    this.scans = new SharedBleScan(async (serviceUuids, onDiscovered, _signal, onEnded) => {
      const channel = this.ipc.createChannel<ScanEvent>();
      channel.onmessage = (event) =>
        onDiscovered({
          peripheralId: event.peripheralId,
          name: event.name,
          serviceUuids: event.serviceUuids,
        });
      // blec ends the scan after its timeout and whenever it connects a device.
      const ended = this.ipc.createChannel<Record<string, never>>();
      ended.onmessage = () => onEnded();
      await this.ipc.invoke('ble_scan', { serviceUuids, onEvent: channel, onEnded: ended });
      return {
        stop: async () => {
          channel.onmessage = () => undefined;
          ended.onmessage = () => undefined;
          await this.ipc.invoke('ble_stop_scan').catch(() => undefined);
        },
      };
    });
  }

  scan(options: BleScanOptions): AsyncIterable<BleDiscoveredPeripheral> {
    return this.scans.scan(options);
  }

  async connect(
    peripheralId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<BleConnection> {
    const { signal } = options;
    if (signal?.aborted) {
      throw abortError();
    }
    const connection = new TauriBleConnection(peripheralId, this.ipc);
    const lostChannel = this.ipc.createChannel<{ readonly peripheralId: string }>();
    lostChannel.onmessage = () => connection.handleConnectionLost();

    await this.ipc.invoke('ble_connect', { peripheralId, onConnectionLost: lostChannel });
    if (signal?.aborted) {
      await connection.disconnect().catch(() => undefined);
      throw abortError();
    }
    return connection;
  }
}
