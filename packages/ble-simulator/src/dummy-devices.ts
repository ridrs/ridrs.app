// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BleCentral,
  BleConnection,
  BleDiscoveredPeripheral,
  BleScanOptions,
  TimeSource,
} from '@ridrs/contracts';
import { BleSimulator } from './ble-simulator.ts';

/** FTMS trainers notify Indoor Bike Data about four times a second. */
const PACKET_INTERVAL_MS = 250;

export type DummyProfile = 'steady' | 'ramp' | 'dropout' | 'malformed';

/** What each profile does, for the developer UI. */
export const DUMMY_PROFILES: Readonly<Record<DummyProfile, string>> = {
  steady: '220 W, 92 rpm',
  ramp: '100 W, +10 W every 3 s up to 300 W, 90 rpm',
  dropout: '220 W; drops the link after 20 s and refuses it for 5 s',
  malformed: '220 W; every 10th packet is truncated',
};

export interface DummyDevice {
  readonly peripheralId: string;
  readonly name: string;
  readonly profile: DummyProfile;
  /** Power set by the developer; overrides the profile's power while set. */
  readonly watts?: number;
}

/** The power a developer can set a dummy to; FTMS Indoor Bike Data carries it as sint16. */
export const DUMMY_WATTS_RANGE = Object.freeze({ min: 0, max: 2000 });

/** FTMS Indoor Bike Data with instantaneous cadence (0.5 rpm units) and power, no speed. */
function indoorBikeData(watts: number, rpm: number): Uint8Array {
  const halfRpm = Math.round(rpm * 2);
  return Uint8Array.of(0x45, 0x00, halfRpm & 0xff, halfRpm >> 8, watts & 0xff, (watts >> 8) & 0xff);
}

interface Running {
  device: DummyDevice;
  readonly timers: Array<ReturnType<typeof setTimeout>>;
}

/**
 * Simulated FTMS trainers with scripted behaviour, played on a `BleSimulator`. The companion's
 * developer build forwards them next to real Bluetooth devices, so ridrs can be tested by hand.
 */
export class DummyDevices {
  readonly central: BleSimulator;
  private readonly clock: TimeSource;
  private readonly running = new Map<string, Running>();
  /** Every id handed out, removed devices too: connects to them must never reach real Bluetooth. */
  private readonly issued = new Set<string>();
  private readonly listeners = new Set<(devices: readonly DummyDevice[]) => void>();

  constructor(options: { readonly clock?: TimeSource } = {}) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.central = new BleSimulator({ clock: this.clock });
  }

  add(profile: DummyProfile): DummyDevice {
    let n = 1;
    const nameFor = (i: number) => (i === 1 ? 'KICKR SIM (dummy)' : `KICKR SIM ${i} (dummy)`);
    const taken = new Set(this.list().map((d) => d.name));
    while (taken.has(nameFor(n))) n += 1;
    const trainer = this.central.addFtmsTrainer(nameFor(n));
    const device: DummyDevice = { peripheralId: trainer.peripheralId, name: trainer.name, profile };
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    this.running.set(device.peripheralId, { device, timers });
    this.issued.add(device.peripheralId);

    let firstConnectedAt: number | undefined;
    let dropped = false;
    let packets = 0;
    trainer.onCentralConnected(() => {
      firstConnectedAt ??= this.clock.now();
    });
    const tick = () => {
      if (firstConnectedAt === undefined || !trainer.isConnected()) {
        return;
      }
      const t = this.clock.now() - firstConnectedAt;
      packets += 1;
      if (profile === 'dropout' && !dropped && t >= 20_000) {
        dropped = true;
        trainer.dropConnectionAndRefuseNew();
        timers.push(setTimeout(() => trainer.acceptConnections(), 5000));
        return;
      }
      if (profile === 'malformed' && packets % 10 === 0) {
        trainer.notifyIndoorBikeData(indoorBikeData(220, 92).subarray(0, 3));
        return;
      }
      const set = this.running.get(device.peripheralId)?.device.watts;
      const watts =
        set ?? (profile === 'ramp' ? Math.min(300, 100 + 10 * Math.floor(t / 3000)) : 220);
      trainer.notifyIndoorBikeData(indoorBikeData(watts, profile === 'ramp' ? 90 : 92));
    };
    timers.push(setInterval(tick, PACKET_INTERVAL_MS));
    this.changed();
    return device;
  }

  /** Sets the power the dummy reports from its next packet on, in place of its profile's. */
  setWatts(peripheralId: string, watts: number): void {
    const running = this.running.get(peripheralId);
    if (!running) {
      return;
    }
    const clamped = Math.round(
      Math.min(DUMMY_WATTS_RANGE.max, Math.max(DUMMY_WATTS_RANGE.min, watts)),
    );
    running.device = { ...running.device, watts: clamped };
    this.changed();
  }

  remove(peripheralId: string): void {
    const running = this.running.get(peripheralId);
    if (!running) {
      return;
    }
    this.running.delete(peripheralId);
    for (const timer of running.timers) clearInterval(timer);
    this.central.removePeripheral(peripheralId);
    this.changed();
  }

  /**
   * Whether the id is a dummy's, also of one removed since: a connect to it belongs to the
   * simulator, which refuses it at once, while real Bluetooth would keep searching for it.
   */
  owns(peripheralId: string): boolean {
    return this.issued.has(peripheralId);
  }

  list(): readonly DummyDevice[] {
    return [...this.running.values()].map((r) => r.device);
  }

  onChange(listener: (devices: readonly DummyDevice[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    for (const id of [...this.running.keys()]) this.remove(id);
  }

  private changed(): void {
    const devices = this.list();
    for (const listener of [...this.listeners]) listener(devices);
  }
}

/**
 * One `BleCentral` over two: scans yield from both, connects go to the one that owns the id.
 * The companion's developer build merges real Bluetooth with dummy devices this way.
 */
export function mergeBleCentrals(
  primary: BleCentral,
  secondary: BleCentral,
  ownedBySecondary: (peripheralId: string) => boolean,
): BleCentral {
  return {
    async *scan(options: BleScanOptions): AsyncIterable<BleDiscoveredPeripheral> {
      const abort = new AbortController();
      const outer = options.signal;
      const stop = () => abort.abort();
      outer?.addEventListener('abort', stop, { once: true });
      const queue: BleDiscoveredPeripheral[] = [];
      let wake: (() => void) | undefined;
      let running = 2;
      const pump = async (central: BleCentral) => {
        try {
          for await (const p of central.scan({ ...options, signal: abort.signal })) {
            queue.push(p);
            wake?.();
          }
        } catch {
          // One side failing (e.g. no Bluetooth adapter) must not end the other side's scan.
        } finally {
          running -= 1;
          wake?.();
        }
      };
      void pump(primary);
      void pump(secondary);
      try {
        while (!abort.signal.aborted && (running > 0 || queue.length > 0)) {
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
        abort.abort();
        outer?.removeEventListener('abort', stop);
      }
    },
    connect(peripheralId, options): Promise<BleConnection> {
      return (ownedBySecondary(peripheralId) ? secondary : primary).connect(peripheralId, options);
    },
  };
}
