// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { formatPairingUri, parsePairingUri } from './ble-bridge.ts';

const secret = '0123456789abcdef0123456789abcdef';

describe('pairing QR code URI', () => {
  it('round-trips secret and name, including characters that need escaping', () => {
    const uri = formatPairingUri({ secret, name: 'ridrs on the living-room TV & Mac’s screen' });
    expect(uri.startsWith('ridrs://pair?v=1&s=')).toBe(true);
    expect(parsePairingUri(uri)).toEqual({
      secret,
      name: 'ridrs on the living-room TV & Mac’s screen',
    });
  });

  it.each([
    ['another scheme', `https://ridrs.app/pair?v=1&s=${secret}`],
    ['an unknown version', `ridrs://pair?v=2&s=${secret}&n=x`],
    ['a short secret', 'ridrs://pair?v=1&s=0123&n=x'],
    ['an uppercase secret', `ridrs://pair?v=1&s=${secret.toUpperCase()}&n=x`],
    ['plain text', 'hello'],
  ])('rejects %s', (_case, text) => {
    expect(parsePairingUri(text)).toBeUndefined();
  });
});
