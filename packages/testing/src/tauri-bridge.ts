// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BleSimulator } from '@ridrs/ble-simulator';
import type { BleConnection, TimeSource } from '@ridrs/contracts';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

/** The part of a Tauri `Channel` the bridge uses to push messages to the WebView side. */
interface ChannelLike {
  readonly onmessage: (message: unknown) => void;
}

type Args = Record<string, unknown>;

/** Mirrors `SCAN_TIMEOUT_MS` in `crates/ridrs-ble/src/commands.rs`: blec ends a scan after it. */
const SCAN_TIMEOUT_MS = 120_000;

/** Mirrors `encode_frame` in `apps/native/src-tauri/src/ble.rs`: u64 µs + f64 ms (LE) + payload. */
function encodeFrame(monotonicUs: number, wallMs: number, payload: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(16 + payload.byteLength);
  const view = new DataView(buffer);
  view.setBigUint64(0, BigInt(Math.round(monotonicUs)), true);
  view.setFloat64(8, wallMs, true);
  new Uint8Array(buffer, 16).set(payload);
  return buffer;
}

function subscriptionKey(args: Args): string {
  return `${String(args.peripheralId)}:${String(args.serviceUuid)}:${String(args.characteristicUuid)}`;
}

/**
 * Stand-in for the native side of `apps/native` (the Rust `ble_*` commands): answers Tauri IPC
 * through `@tauri-apps/api/mocks` and drives a `BleSimulator`, so `transport-ble-tauri` runs
 * unchanged in Node. Only one bridge can be installed at a time (Tauri IPC is global).
 */
export class SimulatedTauriBridge {
  private readonly connections = new Map<string, BleConnection>();
  private readonly subscriptions = new Map<string, () => void>();
  private scanAbort?: AbortController;
  private scanRequests = 0;

  constructor(
    private readonly simulator: BleSimulator,
    private readonly clock: TimeSource,
  ) {}

  install(): void {
    // Tauri's mocks expect a browser-like `window`; in Node the global object serves as one.
    const global = globalThis as { window?: unknown };
    global.window ??= globalThis;
    mockIPC((command, payload) => this.handle(command, (payload ?? {}) as Args));
  }

  uninstall(): void {
    this.scanAbort?.abort();
    clearMocks();
    const global = globalThis as { window?: unknown };
    if (global.window === globalThis) {
      delete global.window;
    }
  }

  scanRequestCount(): number {
    return this.scanRequests;
  }

  subscriptionCount(): number {
    return this.subscriptions.size;
  }

  private async handle(command: string, args: Args): Promise<unknown> {
    switch (command) {
      case 'ble_scan':
        return this.scan(args);
      case 'ble_stop_scan':
        this.stopScan();
        return undefined;
      case 'ble_connect':
        return this.connect(args);
      case 'ble_subscribe':
        return this.subscribe(args);
      case 'ble_unsubscribe':
        this.subscriptions.get(subscriptionKey(args))?.();
        this.subscriptions.delete(subscriptionKey(args));
        return undefined;
      case 'ble_write':
        return this.write(args);
      case 'ble_read':
        return this.read(args);
      case 'ble_disconnect':
        return this.disconnect(String(args.peripheralId));
      default:
        throw new Error(`Simulated Tauri bridge: unknown command "${command}"`);
    }
  }

  private scan(args: Args): void {
    this.scanRequests += 1;
    // Like blec, a new scan replaces the running one.
    this.stopScan();
    const abort = new AbortController();
    this.scanAbort = abort;
    const channel = args.onEvent as ChannelLike;
    const ended = args.onEnded as ChannelLike | undefined;
    const serviceUuids = (args.serviceUuids as string[]) ?? [];
    const timeout = setTimeout(() => abort.abort(), SCAN_TIMEOUT_MS);
    // However the scan ends (stopped, replaced, a connect, the timeout), Rust reports it once.
    abort.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        ended?.onmessage({});
      },
      { once: true },
    );
    // The Rust command returns once the scan runs; results follow on the channel.
    void (async () => {
      for await (const peripheral of this.simulator.scan({ serviceUuids, signal: abort.signal })) {
        channel.onmessage({ ...peripheral, rssi: null });
      }
    })();
  }

  private stopScan(): void {
    this.scanAbort?.abort();
    this.scanAbort = undefined;
  }

  private async connect(args: Args): Promise<void> {
    const peripheralId = String(args.peripheralId);
    // Like blec, connecting cancels the running scan.
    this.stopScan();
    const connection = await this.simulator.connect(peripheralId);
    this.connections.set(peripheralId, connection);
    const lost = args.onConnectionLost as ChannelLike;
    connection.onDisconnected(() => {
      this.connections.delete(peripheralId);
      this.dropSubscriptionsOf(peripheralId);
      lost.onmessage({ peripheralId });
    });
  }

  private async subscribe(args: Args): Promise<void> {
    const peripheralId = String(args.peripheralId);
    const connection = this.connections.get(peripheralId);
    if (!connection) {
      throw new Error(`Peripheral "${peripheralId}" is not connected`);
    }
    const channel = args.onNotification as ChannelLike;
    const unsubscribe = await connection.subscribe(
      {
        serviceUuid: String(args.serviceUuid),
        characteristicUuid: String(args.characteristicUuid),
      },
      (data) => {
        const now = this.clock.now();
        channel.onmessage(encodeFrame(now * 1000, now, data));
      },
    );
    this.subscriptions.set(subscriptionKey(args), unsubscribe);
  }

  private async write(args: Args): Promise<void> {
    const peripheralId = String(args.peripheralId);
    const connection = this.connections.get(peripheralId);
    if (!connection) {
      throw new Error(`Peripheral "${peripheralId}" is not connected`);
    }
    // Like the Rust command, the bytes arrive as a JSON number array.
    await connection.write(
      {
        serviceUuid: String(args.serviceUuid),
        characteristicUuid: String(args.characteristicUuid),
      },
      Uint8Array.from(args.data as number[]),
      { withResponse: args.withResponse === true },
    );
  }

  private async read(args: Args): Promise<number[]> {
    const peripheralId = String(args.peripheralId);
    const connection = this.connections.get(peripheralId);
    if (!connection) {
      throw new Error(`Peripheral "${peripheralId}" is not connected`);
    }
    // Like the Rust command, the bytes return as a JSON number array.
    const data = await connection.read({
      serviceUuid: String(args.serviceUuid),
      characteristicUuid: String(args.characteristicUuid),
    });
    return Array.from(data);
  }

  private async disconnect(peripheralId: string): Promise<void> {
    const connection = this.connections.get(peripheralId);
    this.connections.delete(peripheralId);
    this.dropSubscriptionsOf(peripheralId);
    await connection?.disconnect();
  }

  private dropSubscriptionsOf(peripheralId: string): void {
    for (const [key, unsubscribe] of [...this.subscriptions]) {
      if (key.startsWith(`${peripheralId}:`)) {
        unsubscribe();
        this.subscriptions.delete(key);
      }
    }
  }
}
