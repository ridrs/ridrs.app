// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BLE_SCAN_REPORT_INTERVAL_MS,
  type BleDiscoveredPeripheral,
  type BleScanOptions,
  normalizeBleUuid,
} from '@ridrs/contracts';
import { type Advertised, advertisedAfter, advertisesNews } from './advertising.ts';

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
  /** Each device reported, with the signal strength it was last reported with. */
  readonly seen: Map<string, Reported>;
  wake?: () => void;
  done: boolean;
  error?: unknown;
}

interface RunningScan {
  readonly services: readonly string[];
  readonly abort: AbortController;
  handle?: NativeScan;
}

/**
 * How much the signal must move before a device is reported again. Platforms report every
 * advertisement, many a second, and the signal jitters by a few dB from one to the next.
 */
const SIGNAL_STEP_DB = 5;

/** What a consumer was last told about a device. */
interface Reported {
  readonly rssi: number | undefined;
  /** Whether it was reported with a name: a device's name may only come with a scan response. */
  readonly named: boolean;
  /** Its advertising data as reported: a key's bytes, or `changing` once a change was. */
  readonly advertised: Advertised;
  /** When it was reported. */
  readonly at: number;
}

/**
 * A device not reported yet, one reported without a name that now has one, one whose signal
 * moved by a step since it was reported, or one whose advertising data has a key not reported
 * yet or bytes of a key that changed for the first time; and every device heard again once its
 * report interval has passed.
 */
function news(
  seen: ReadonlyMap<string, Reported>,
  p: BleDiscoveredPeripheral,
  now: number,
): boolean {
  const last = seen.get(p.peripheralId);
  if (!last || (!last.named && p.name !== '')) {
    return true;
  }
  if (now - last.at >= BLE_SCAN_REPORT_INTERVAL_MS) {
    return true;
  }
  if (advertisesNews(last.advertised, p)) {
    return true;
  }
  if (p.rssi === undefined) {
    return false;
  }
  return last.rssi === undefined || Math.abs(p.rssi - last.rssi) >= SIGNAL_STEP_DB;
}

function covers(running: readonly string[], wanted: readonly string[]): boolean {
  return running.length === 0 || (wanted.length > 0 && wanted.every((s) => running.includes(s)));
}

/**
 * Lets several plugins scan at once on a platform that runs one scan at a time (each device
 * plugin scans for its own service). One native scan covers the union of the requested services
 * and is stopped when the last consumer is done; each consumer sees its own services, once each,
 * and again once a device's name arrives, its signal strength moved by 5 dB or more, its
 * advertising data brings a new key, or the bytes of a key change for the first time; a device
 * still heard is reported again every `BLE_SCAN_REPORT_INTERVAL_MS`.
 */
export class SharedBleScan {
  private readonly sessions = new Set<ScanSession>();
  private running?: RunningScan;
  /** Native starts and stops never overlap. */
  private queue: Promise<void> = Promise.resolve();
  /** Work in flight that needs the platform's Bluetooth to itself: no native scan meanwhile. */
  private pauses = 0;

  constructor(
    private readonly startNative: StartNativeScan,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async *scan(options: BleScanOptions): AsyncIterable<BleDiscoveredPeripheral> {
    const { signal } = options;
    if (signal?.aborted) {
      return;
    }
    const session: ScanSession = {
      services: new Set(options.serviceUuids.map(normalizeBleUuid)),
      queue: [],
      seen: new Map(),
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

  /**
   * Runs `work` without a native scan: the running one stops first, none starts until `work`
   * settles, then the one the consumers need starts again. For platforms whose connect scans on
   * its own (blec looks for an address it does not know), where a scan of ours would end that one.
   */
  async pausedWhile<T>(work: () => Promise<T>): Promise<T> {
    this.pauses += 1;
    try {
      await this.reconcile().catch(() => undefined);
      return await work();
    } finally {
      this.pauses -= 1;
      void this.reconcile().catch(() => undefined);
    }
  }

  private dispatch(peripheral: BleDiscoveredPeripheral): void {
    const services = peripheral.serviceUuids.map(normalizeBleUuid);
    const now = this.now();
    for (const session of this.sessions) {
      const wanted =
        session.services.size === 0 || services.some((uuid) => session.services.has(uuid));
      if (session.done || !wanted || !news(session.seen, peripheral, now)) {
        continue;
      }
      const last = session.seen.get(peripheral.peripheralId);
      session.seen.set(peripheral.peripheralId, {
        rssi: peripheral.rssi,
        named: peripheral.name !== '' || last?.named === true,
        advertised: advertisedAfter(last?.advertised, peripheral),
        at: now,
      });
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
      const wanted = this.pauses > 0 ? undefined : this.wantedServices();
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
