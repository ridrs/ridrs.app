// SPDX-License-Identifier: AGPL-3.0-or-later

import { decodeNotificationFrame } from './ble/frame.ts';
import type { BleIpc } from './ble/ipc.ts';
import { calibrateClockOffset, jsWallClockMs } from './clock-offset.ts';
import type { TauriBleCentral } from './ble/tauri-ble-central.ts';
import type { PacketLog } from './packet-log.ts';
import { startFtmsPluginProbe } from './probe/ftms-plugin-probe.ts';

/**
 * Unattended probe (RIDRS_SPIKE_SELFTEST=1): measures cold start and IPC round trips, then runs an
 * unfiltered and an FTMS-filtered scan through the full chain JS → Rust → OS → Rust → JS and writes
 * everything to the packet log. Needs no hardware; proves the chain, not trainer behavior.
 */
/** Rust wall clock at frame creation → JS handler, over the real raw-frame channel path. */
async function measureSyntheticNotifications(ipc: BleIpc, count: number, intervalMs: number): Promise<string> {
  const { offsetMs, rttMs } = await calibrateClockOffset(ipc);
  const latencies: number[] = [];
  let messageType = '';
  const channel = ipc.createChannel<ArrayBuffer | number[]>();
  const done = new Promise<void>((resolve) => {
    channel.onmessage = (message) => {
      const jsWallMs = jsWallClockMs();
      messageType ||= message instanceof ArrayBuffer ? 'ArrayBuffer' : Array.isArray(message) ? 'number[]' : typeof message;
      latencies.push(jsWallMs + offsetMs - decodeNotificationFrame(message).rustWallMs);
      if (latencies.length === count) resolve();
    };
  });
  await ipc.invoke('spike_synthetic_notifications', { count, intervalMs, onNotification: channel });
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, count * intervalMs + 5000))]);
  latencies.sort((a, b) => a - b);
  const pick = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]?.toFixed(2);
  return `synthetic notifications ${count} @ ${intervalMs} ms via ${messageType}: received ${latencies.length}, Rust→JS latency median ${pick(0.5)} ms, p95 ${pick(0.95)} ms, max ${latencies.at(-1)?.toFixed(2)} ms (clock offset ${offsetMs.toFixed(2)} ms, calibration RTT ${rttMs.toFixed(2)} ms)`;
}

export async function runSelftest(ipc: BleIpc, central: TauriBleCentral, log: PacketLog): Promise<void> {
  const line = (text: string) => log.line('SELFTEST', 'RESULT', text);

  const [rustMonotonicUs] = await ipc.invoke<[number, number]>('ble_clock');
  line(`cold start: Rust process start → first JS IPC = ${(rustMonotonicUs / 1000).toFixed(0)} ms`);

  // WebKit coarsens performance.now() to 1 ms, so the mean over many calls is the usable number.
  const roundTrips: number[] = [];
  const batchStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    const t0 = performance.now();
    await ipc.invoke('ble_clock');
    roundTrips.push(performance.now() - t0);
  }
  const meanMs = (performance.now() - batchStart) / 1000;
  roundTrips.sort((a, b) => a - b);
  line(
    `invoke round trip (n=1000): mean ${meanMs.toFixed(3)} ms, median ${roundTrips[500]?.toFixed(3)} ms, p95 ${roundTrips[950]?.toFixed(3)} ms`,
  );

  for (const [count, intervalMs] of [
    [120, 250],
    [1000, 5],
  ] as const) {
    line(await measureSyntheticNotifications(ipc, count, intervalMs));
  }

  line(`permissions: ${await central.checkPermissions(true).catch((e) => `error ${e}`)}`);
  line(`adapter state: ${await ipc.invoke<string>('ble_adapter_state').catch((e) => `error ${e}`)}`);
  line(`Screen Wake Lock API available: ${'wakeLock' in navigator}`);
  line(`user agent: ${navigator.userAgent}`);

  for (const [label, serviceUuids] of [
    ['unfiltered', []],
    ['ftms-filtered', ['1826']],
  ] as const) {
    const controller = new AbortController();
    const started = performance.now();
    let count = 0;
    let firstMs: number | undefined;
    setTimeout(() => controller.abort(), 8000);
    try {
      for await (const p of central.scan({ serviceUuids, signal: controller.signal })) {
        count += 1;
        firstMs ??= performance.now() - started;
        line(`${label} scan found "${p.name}" id=${p.peripheralId} rssi=${p.rssi} services=${p.serviceUuids.join(',')}`);
      }
      line(`${label} scan: ${count} peripherals in 8 s, first after ${firstMs?.toFixed(0) ?? '–'} ms`);
    } catch (error) {
      line(`${label} scan failed: ${error}`);
    }
  }
  // Stage 2 inside the WebView: the real plugin must start and search (no trainer needed for that).
  try {
    const probe = await startFtmsPluginProbe(
      central,
      (event) => line(`stage 2 event ${event.type} ${JSON.stringify(event.payload)}`),
      (logLine) => line(`stage 2 log ${logLine}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await probe.stop();
    line('stage 2: device-ftms-trainer started, searched and stopped inside the WebView');
  } catch (error) {
    line(`stage 2 failed in WebView: ${error}`);
  }

  line('done');
  await log.flush();
}
