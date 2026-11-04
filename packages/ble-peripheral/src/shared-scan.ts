// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BleDiscoveredPeripheral,
  type BleScanOptions,
  normalizeBleUuid,
} from '@ridrs/contracts';

/** A running platform scan; `stop` ends it. */
export interface NativeScan {
  stop(): Promise<void>;
}

/**
 * Starts the platform's single scan for the given services (empty: all) and reports every
 * advertisement to `onDiscovered`. `signal` aborts a start that is still pending. Platforms whose
 * scan can end by itself (a timeout, a connect that cancels it) call `onEnded` then.
 */
export type StartNativeScan = (
  serviceUuids: readonly string[],
  onDiscovered: (peripheral: BleDiscoveredPeripheral) => void,
  signal: AbortSignal,
  onEnded: () => void,
) => Promise<NativeScan>;

interface ScanSession {
  /** Requested services; empty means every peripheral. */
  readonly services: ReadonlySet<string>;
  readonly queue: BleDiscoveredPeripheral[];
  readonly seen: Set<string>;
  wake?: () => void;
  done: boolean;
  error?: unknown;
}

interface RunningScan {
  readonly services: readonly string[];
  readonly abort: AbortController;
  handle?: NativeScan;
}

function covers(running: readonly string[], wanted: readonly string[]): boolean {
  return running.length === 0 || (wanted.length > 0 && wanted.every((s) => running.includes(s)));
}

/**
 * Lets several plugins scan at once on a platform that runs one scan at a time (each device
 * plugin scans for its own service). One native scan covers the union of the requested services
 * and is stopped when the last consumer is done; each consumer sees its own services, once each.
 */
export class SharedBleScan {
  private readonly sessions = new Set<ScanSession>();
  private running?: RunningScan;
  /** Native starts and stops never overlap. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly startNative: StartNativeScan) {}

  async *scan(options: BleScanOptions): AsyncIterable<BleDiscoveredPeripheral> {
    const { signal } = options;
    if (signal?.aborted) {
      return;
    }
    const session: ScanSession = {
      services: new Set(options.serviceUuids.map(normalizeBleUuid)),
      queue: [],
      seen: new Set(),
      done: false,
    };
    const finish = (): void => {
      session.done = true;
      session.wake?.();
    };
    signal?.addEventListener('abort', finish, { once: true });
    this.sessions.add(session);
    try {
      await this.reconcile();
      while (!session.done) {
        if (session.error !== undefined) {
          throw session.error;
        }
        const next = session.queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          session.wake = resolve;
        });
        session.wake = undefined;
      }
    } finally {
      session.done = true;
      this.sessions.delete(session);
      signal?.removeEventListener('abort', finish);
      await this.reconcile().catch(() => undefined);
    }
  }

  private dispatch(peripheral: BleDiscoveredPeripheral): void {
    const services = peripheral.serviceUuids.map(normalizeBleUuid);
    for (const session of this.sessions) {
      const wanted =
        session.services.size === 0 || services.some((uuid) => session.services.has(uuid));
      if (session.done || !wanted || session.seen.has(peripheral.peripheralId)) {
        continue;
      }
      session.seen.add(peripheral.peripheralId);
      session.queue.push({ ...peripheral, serviceUuids: services });
      session.wake?.();
    }
  }

  /** The services the sessions need: undefined for none, empty for all. */
  private wantedServices(): string[] | undefined {
    if (this.sessions.size === 0) {
      return undefined;
    }
    const union = new Set<string>();
    for (const session of this.sessions) {
      if (session.services.size === 0) {
        return [];
      }
      for (const uuid of session.services) {
        union.add(uuid);
      }
    }
    return [...union].sort();
  }

  /** The native scan ended without being asked: start it again while anyone is still searching. */
  private ended(scan: RunningScan): void {
    if (this.running !== scan) {
      return;
    }
    this.running = undefined;
    void this.reconcile().catch(() => undefined);
  }

  /** Makes the native scan cover what the sessions need, restarting it wider, or stops it. */
  private reconcile(): Promise<void> {
    const step = this.queue.then(async () => {
      const wanted = this.wantedServices();
      const running = this.running;
      if (running && wanted && covers(running.services, wanted)) {
        return;
      }
      if (running) {
        this.running = undefined;
        running.abort.abort();
        await running.handle?.stop().catch(() => undefined);
      }
      if (!wanted) {
        return;
      }
      const next: RunningScan = { services: wanted, abort: new AbortController() };
      this.running = next;
      try {
        next.handle = await this.startNative(
          wanted,
          (p) => this.dispatch(p),
          next.abort.signal,
          () => this.ended(next),
        );
      } catch (error) {
        if (this.running === next) {
          this.running = undefined;
        }
        for (const session of this.sessions) {
          session.error = error;
          session.wake?.();
        }
        throw error;
      }
    });
    this.queue = step.catch(() => undefined);
    return step;
  }
}
