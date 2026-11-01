// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BleCentral,
  type BleCharacteristicTarget,
  type BleConnection,
  type BleDiscoveredPeripheral,
  type BleScanOptions,
  bleCentralCapability,
  definePlugin,
  normalizeBleUuid,
} from '@ridrs/contracts';
import type * as NobleTypes from '@abandonware/noble';

type Noble = typeof NobleTypes;

// Sanctioned way to simulate a machine without a usable Bluetooth stack (see README).
// Throwing at module level makes the host report "entry-load-failure" for this plugin.
if (process.env.RIDRS_BLE_NOBLE_FAIL_LOAD) {
  throw new Error('Bluetooth stack unavailable (RIDRS_BLE_NOBLE_FAIL_LOAD is set)');
}

const nobleModule = await import('@abandonware/noble');
// noble is a CommonJS singleton; depending on the loader the instance is the namespace or `default`.
const noble: Noble = (nobleModule as unknown as { default?: Noble }).default ?? nobleModule;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

async function waitForPoweredOn(signal?: AbortSignal): Promise<void> {
  if (noble._state === 'poweredOn') {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onState = (state: string): void => {
      if (state === 'poweredOn') {
        cleanup();
        resolve();
      }
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal ? abortError(signal) : new Error('aborted'));
    };
    const cleanup = (): void => {
      noble.removeListener('stateChange', onState);
      signal?.removeEventListener('abort', onAbort);
    };
    noble.on('stateChange', onState);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toDiscovered(peripheral: NobleTypes.Peripheral): BleDiscoveredPeripheral {
  return {
    peripheralId: peripheral.id,
    name: peripheral.advertisement.localName ?? '',
    serviceUuids: peripheral.advertisement.serviceUuids.map(normalizeBleUuid),
  };
}

function createCentral(): BleCentral {
  const known = new Map<string, NobleTypes.Peripheral>();

  async function* scan(options: BleScanOptions): AsyncGenerator<BleDiscoveredPeripheral> {
    const { signal } = options;
    const queue: NobleTypes.Peripheral[] = [];
    let wake: (() => void) | undefined;
    const onDiscover = (peripheral: NobleTypes.Peripheral): void => {
      known.set(peripheral.id, peripheral);
      queue.push(peripheral);
      wake?.();
    };
    const onAbort = (): void => wake?.();

    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await waitForPoweredOn(signal);
      noble.on('discover', onDiscover);
      await noble.startScanningAsync([...options.serviceUuids], false);
      while (!signal?.aborted) {
        const next = queue.shift();
        if (next) {
          yield toDiscovered(next);
        } else {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      }
    } catch (error) {
      if (!signal?.aborted) {
        throw error;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      noble.removeListener('discover', onDiscover);
      await noble.stopScanningAsync().catch(() => undefined);
    }
  }

  async function connect(
    peripheralId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<BleConnection> {
    const peripheral = known.get(peripheralId);
    if (!peripheral) {
      throw new Error(`Unknown BLE peripheral "${peripheralId}"; it must be discovered first`);
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      throw abortError(signal);
    }
    const onAbort = (): void => {
      void peripheral.disconnectAsync().catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await peripheral.connectAsync();
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    return {
      peripheralId,
      async subscribe(target: BleCharacteristicTarget, onNotification) {
        const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
          [target.serviceUuid],
          [target.characteristicUuid],
        );
        const characteristic = characteristics[0];
        if (!characteristic) {
          throw new Error(
            `Characteristic ${target.characteristicUuid} of service ${target.serviceUuid} not found`,
          );
        }
        const onData = (data: Buffer): void => onNotification(new Uint8Array(data));
        characteristic.on('data', onData);
        await characteristic.subscribeAsync();
        return () => {
          characteristic.removeListener('data', onData);
          void characteristic.unsubscribeAsync().catch(() => undefined);
        };
      },
      onDisconnected(listener) {
        peripheral.once('disconnect', listener);
        return () => {
          peripheral.removeListener('disconnect', listener);
        };
      },
      async disconnect() {
        await peripheral.disconnectAsync();
      },
    };
  }

  return { scan, connect };
}

export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(bleCentralCapability, createCentral());
  },
});
