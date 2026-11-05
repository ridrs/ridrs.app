// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BleDiscoveredPeripheral } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { SharedBleScan } from './shared-scan.ts';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A platform with one scan at a time: records starts and stops, lets tests advertise. */
function fakePlatform() {
  const log: string[] = [];
  let advertise: ((p: BleDiscoveredPeripheral) => void) | undefined;
  let end: (() => void) | undefined;
  const scans = new SharedBleScan(async (services, onDiscovered, _signal, onEnded) => {
    log.push(`start ${services.join('+') || '*'}`);
    advertise = onDiscovered;
    end = onEnded;
    return {
      stop: async () => {
        log.push('stop');
        advertise = undefined;
      },
    };
  });
  const device = (id: string, service: string) =>
    advertise?.({ peripheralId: id, name: id, serviceUuids: [service] });
  /** The platform ends its scan by itself (a timeout, a connect). */
  const endScan = () => {
    log.push('ended');
    advertise = undefined;
    end?.();
  };
  return { scans, log, device, endScan };
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
  it('starts the native scan again when it ends while a consumer still searches', async () => {
    const { scans, log, device, endScan } = fakePlatform();
    const heartRate = new AbortController();
    const b = collect(scans, '180d', heartRate.signal);
    await flush();
    endScan();
    await flush();
    expect(log).toEqual(['start 180d', 'ended', 'start 180d']);

    device('hrm', '180d');
    await flush();
    expect(b.seen).toEqual(['hrm']);
    heartRate.abort();
    await b.done;
  });

  it('starts no native scan while paused, and the one the consumers need once the work is done', async () => {
    const { scans, log, endScan } = fakePlatform();
    const trainer = new AbortController();
    const a = collect(scans, '1826', trainer.signal);
    await flush();
    let finish: () => void = () => undefined;
    const paused = scans.pausedWhile(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await flush();
    // The platform's own scan ends ours meanwhile, and another consumer arrives.
    endScan();
    const heartRate = new AbortController();
    const b = collect(scans, '180d', heartRate.signal);
    await flush();
    expect(log).toEqual(['start 1826', 'stop', 'ended']);

    finish();
    await paused;
    await flush();
    expect(log).toEqual(['start 1826', 'stop', 'ended', 'start 180d+1826']);
    trainer.abort();
    heartRate.abort();
    await Promise.all([a.done, b.done]);
  });

  it('starts the scan again after paused work that failed', async () => {
    const { scans, log } = fakePlatform();
    const trainer = new AbortController();
    const a = collect(scans, '1826', trainer.signal);
    await flush();
    await expect(scans.pausedWhile(() => Promise.reject(new Error('no device')))).rejects.toThrow(
      'no device',
    );
    await flush();
    expect(log).toEqual(['start 1826', 'stop', 'start 1826']);
    trainer.abort();
    await a.done;
  });

  it('does not start again when nobody searches any more', async () => {
    const { scans, log, endScan } = fakePlatform();
    const trainer = new AbortController();
    const a = collect(scans, '1826', trainer.signal);
    await flush();
    trainer.abort();
    await a.done;
    endScan();
    await flush();
    expect(log).toEqual(['start 1826', 'stop', 'ended']);
  });

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

  it('reports a device again once its signal moved by 5 dB or more, not for less', async () => {
    let advertise: ((p: BleDiscoveredPeripheral) => void) | undefined;
    const scans = new SharedBleScan(async (_services, onDiscovered) => {
      advertise = onDiscovered;
      return { stop: async () => undefined };
    });
    const controller = new AbortController();
    const seen: (number | undefined)[] = [];
    const done = (async () => {
      for await (const p of scans.scan({ serviceUuids: ['1826'], signal: controller.signal })) {
        seen.push(p.rssi);
      }
    })();
    await flush();
    for (const rssi of [-60, -62, -64, -65, -70, -61]) {
      advertise?.({ peripheralId: 'kickr', name: 'KICKR', serviceUuids: ['1826'], rssi });
    }
    await flush();
    controller.abort();
    await done;
    expect(seen).toEqual([-60, -65, -70, -61]);
  });

  it('reports a device again once its name arrives, as only a scan response may carry it', async () => {
    let advertise: ((p: BleDiscoveredPeripheral) => void) | undefined;
    const scans = new SharedBleScan(async (_services, onDiscovered) => {
      advertise = onDiscovered;
      return { stop: async () => undefined };
    });
    const controller = new AbortController();
    const seen: string[] = [];
    const done = (async () => {
      for await (const p of scans.scan({ serviceUuids: ['180d'], signal: controller.signal })) {
        seen.push(p.name);
      }
    })();
    await flush();
    for (const name of ['', '', 'Xiaomi Smart Band 10 6014', 'Xiaomi Smart Band 10 6014', '']) {
      advertise?.({ peripheralId: 'band', name, serviceUuids: ['180d'] });
    }
    await flush();
    controller.abort();
    await done;
    expect(seen).toEqual(['', 'Xiaomi Smart Band 10 6014']);
  });

  it('reports a device again for a new key of its advertising data, and for its first change only', async () => {
    let advertise: ((p: BleDiscoveredPeripheral) => void) | undefined;
    const scans = new SharedBleScan(async (_services, onDiscovered) => {
      advertise = onDiscovered;
      return { stop: async () => undefined };
    });
    const controller = new AbortController();
    const seen: unknown[] = [];
    const done = (async () => {
      for await (const p of scans.scan({ serviceUuids: ['1826'], signal: controller.signal })) {
        seen.push([p.manufacturerData, p.serviceData]);
      }
    })();
    await flush();
    const kickr = { peripheralId: 'kickr', name: 'KICKR', serviceUuids: ['1826'] };
    advertise?.(kickr);
    advertise?.({ ...kickr, manufacturerData: { '0157': 'aa01' } });
    advertise?.({ ...kickr, manufacturerData: { '0157': 'aa01' } });
    advertise?.({ ...kickr, manufacturerData: { '0157': 'aa01' }, serviceData: { fe95: '01' } });
    advertise?.({ ...kickr, manufacturerData: { '0157': 'aa02' }, serviceData: { fe95: '01' } });
    advertise?.({ ...kickr, manufacturerData: { '0157': 'aa03' }, serviceData: { fe95: '01' } });
    await flush();
    controller.abort();
    await done;
    expect(seen).toEqual([
      [undefined, undefined],
      [{ '0157': 'aa01' }, undefined],
      [{ '0157': 'aa01' }, { fe95: '01' }],
      [{ '0157': 'aa02' }, { fe95: '01' }],
    ]);
  });
});
