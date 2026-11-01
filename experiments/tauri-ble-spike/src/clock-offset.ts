// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BleIpc } from './ble/ipc.ts';

export const jsWallClockMs = () => performance.timeOrigin + performance.now();

/**
 * Estimates (Rust wall clock − JS wall clock) in ms, NTP style: the `ble_clock` sample with the
 * smallest round trip wins and is assumed to be taken halfway. Both clocks read the same system
 * time, but WebKit's `timeOrigin`/`performance.now()` coarsening leaves an offset of ~1 ms.
 */
export async function calibrateClockOffset(ipc: BleIpc, samples = 200): Promise<{ offsetMs: number; rttMs: number }> {
  let best = { offsetMs: 0, rttMs: Number.POSITIVE_INFINITY };
  for (let i = 0; i < samples; i++) {
    const t0 = jsWallClockMs();
    const [, rustWallMs] = await ipc.invoke<[number, number]>('ble_clock');
    const t1 = jsWallClockMs();
    if (t1 - t0 < best.rttMs) {
      best = { offsetMs: rustWallMs - (t0 + t1) / 2, rttMs: t1 - t0 };
    }
  }
  return best;
}
