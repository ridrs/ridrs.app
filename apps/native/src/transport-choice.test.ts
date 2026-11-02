// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { loadTransport, saveTransport, type TransportStore } from './transport-choice.ts';

function store(initial: string | null, options: { failWrite?: boolean; lose?: boolean } = {}) {
  let value = initial;
  const s: TransportStore = {
    read: async () => value,
    write: async (t) => {
      if (options.failWrite) throw new Error('disk full');
      if (!options.lose) value = t;
    },
  };
  return s;
}

describe('BLE transport choice', () => {
  it.each([
    [null, 'local'],
    ['bridge', 'bridge'],
    ['local', 'local'],
    ['garbage', 'local'],
  ])('reads %s as %s', async (stored, expected) => {
    expect(await loadTransport(store(stored))).toBe(expected);
  });

  it('falls back to this device when the store cannot be read', async () => {
    const broken: TransportStore = {
      read: () => Promise.reject(new Error('no file')),
      write: async () => {},
    };
    expect(await loadTransport(broken)).toBe('local');
  });

  it('confirms a saved choice', async () => {
    const s = store('bridge');
    await saveTransport(s, 'local');
    expect(await loadTransport(s)).toBe('local');
  });

  it('refuses to switch when the choice was not written', async () => {
    await expect(saveTransport(store('bridge', { failWrite: true }), 'local')).rejects.toThrow();
    await expect(saveTransport(store('bridge', { lose: true }), 'local')).rejects.toThrow(
      /did not persist/,
    );
  });
});
