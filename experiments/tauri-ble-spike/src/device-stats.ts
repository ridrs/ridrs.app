// SPDX-License-Identifier: AGPL-3.0-or-later

/** Per-device counters for the results matrix (checks 6, 8, 9, 15). Driven by Rust timestamps. */
export class DeviceStats {
  state = 'idle';
  notifications = 0;
  reconnects = 0;
  gapsOverOneSecond = 0;
  maxGapMs = 0;
  private lastMonotonicUs: number | undefined;
  private readonly recentMonotonicUs: number[] = [];

  /** Call for every notification; returns the gap to the previous one in ms. */
  record(rustMonotonicUs: number): number | undefined {
    this.notifications += 1;
    let gapMs: number | undefined;
    if (this.lastMonotonicUs !== undefined) {
      gapMs = (rustMonotonicUs - this.lastMonotonicUs) / 1000;
      this.maxGapMs = Math.max(this.maxGapMs, gapMs);
      if (gapMs > 1000) {
        this.gapsOverOneSecond += 1;
      }
    }
    this.lastMonotonicUs = rustMonotonicUs;
    this.recentMonotonicUs.push(rustMonotonicUs);
    while (this.recentMonotonicUs.length > 0 && rustMonotonicUs - (this.recentMonotonicUs[0] ?? 0) > 5_000_000) {
      this.recentMonotonicUs.shift();
    }
    return gapMs;
  }

  /** Gaps across a reconnect are not notification gaps. */
  resetGapTracking(): void {
    this.lastMonotonicUs = undefined;
    this.recentMonotonicUs.length = 0;
  }

  /** Notifications per second over the last 5 s window. */
  get rate(): number {
    const first = this.recentMonotonicUs[0];
    const last = this.recentMonotonicUs.at(-1);
    if (first === undefined || last === undefined || last === first) {
      return 0;
    }
    return ((this.recentMonotonicUs.length - 1) * 1_000_000) / (last - first);
  }
}

/** Rust receive timestamp -> JS handler latency samples (same machine, both wall clocks). */
export class LatencyStats {
  private readonly samples: number[] = [];

  add(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > 20_000) {
      this.samples.shift();
    }
  }

  get count(): number {
    return this.samples.length;
  }

  percentile(p: number): number | undefined {
    if (this.samples.length === 0) {
      return undefined;
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
  }
}
