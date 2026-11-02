// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BleDiscoveredPeripheral } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { SharedBleScan } from './shared-scan.ts';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A platform with one scan at a time: records starts and stops, lets tests advertise. */
function fakePlatform() {
  const log: string[] = [];
  let advertise: ((p: BleDiscoveredPeripheral) => void) | undefined;
  const scans = new SharedBleScan(async (services, onDiscovered) => {
    log.push(`start ${services.join('+') || '*'}`);
    advertise = onDiscovered;
    return {
      stop: async () => {
        log.push('stop');
        advertise = undefined;
      },
    };
  });
  const device = (id: string, service: string) =>
    advertise?.({ peripheralId: id, name: id, serviceUuids: [service] });
  return { scans, log, device };
}

function collect(scans: SharedBleScan, service: string, signal: AbortSignal) {
  const seen: string[] = [];
  const done = (async () => {
    for await (const p of scans.scan({ serviceUuids: [service], signal })) {
      seen.push(p.peripheralId);
    }
  })();
  return { seen, done };
}

describe('SharedBleScan', () => {
  it('serves two consumers from one native scan, each with its own services', async () => {
    const { scans, log, device } = fakePlatform();
    const trainer = new AbortController();
    const heartRate = new AbortController();
    const a = collect(scans, '0x1826', trainer.signal);
    await flush();
    const b = collect(scans, '180D', heartRate.signal);
    await flush();
    expect(log).toEqual(['start 1826', 'stop', 'start 180d+1826']);

    device('kickr', '1826');
    device('hrm', '180d');
    device('kickr', '1826');
    await flush();
    expect(a.seen).toEqual(['kickr']);
    expect(b.seen).toEqual(['hrm']);

    trainer.abort();
    await a.done;
    expect(log.at(-1)).toBe('start 180d+1826');
    heartRate.abort();
    await b.done;
    expect(log.at(-1)).toBe('stop');
  });

  it('does not restart when the running scan already covers a new consumer', async () => {
    const { scans, log } = fakePlatform();
    const first = new AbortController();
    const second = new AbortController();
    const a = collect(scans, '1826', first.signal);
    await flush();
    const b = collect(scans, '1826', second.signal);
    await flush();
    expect(log).toEqual(['start 1826']);
    first.abort();
    second.abort();
    await Promise.all([a.done, b.done]);
    expect(log).toEqual(['start 1826', 'stop']);
  });

  it('hands a failing start to every waiting consumer', async () => {
    const scans = new SharedBleScan(async () => {
      throw new Error('Bluetooth is off');
    });
    const iterate = async () => {
      for await (const _ of scans.scan({ serviceUuids: ['1826'] })) {
        // nothing is found
      }
    };
    await expect(iterate()).rejects.toThrow('Bluetooth is off');
  });
});
