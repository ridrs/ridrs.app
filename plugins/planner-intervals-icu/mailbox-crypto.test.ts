// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  encPublic,
  fromBase64Url,
  generateKeys,
  openEvent,
  sha256Hex,
  signPublic,
  signRequest,
  toBase64Url,
} from './mailbox-crypto.ts';

/** The server's test vector (web/test-vectors/mailbox-v1.json of the relay), copied. */
const vector = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/mailbox/mailbox-v1.json', import.meta.url), 'utf8'),
) as Record<string, string>;

describe('the mailbox crypto', () => {
  it('opens the server test vector', () => {
    const keys = { signPrivate: new Uint8Array(32), encPrivate: fromBase64Url(vector.device_enc_priv ?? '') };
    expect(toBase64Url(encPublic(keys))).toBe(vector.device_enc_pub);
    const plaintext = openEvent(keys, vector.device_id ?? '', {
      type: vector.type ?? '',
      timestamp: vector.timestamp ?? '',
      eph_pub: vector.eph_pub ?? '',
      ciphertext: vector.ciphertext ?? '',
    });
    expect(plaintext).toBe(vector.plaintext);
  });

  it('does not open an event whose type, timestamp, device or ciphertext was changed', () => {
    const keys = { signPrivate: new Uint8Array(32), encPrivate: fromBase64Url(vector.device_enc_priv ?? '') };
    const event = {
      type: vector.type ?? '',
      timestamp: vector.timestamp ?? '',
      eph_pub: vector.eph_pub ?? '',
      ciphertext: vector.ciphertext ?? '',
    };
    expect(() => openEvent(keys, 'OTHERDEVICE', event)).toThrow();
    expect(() => openEvent(keys, vector.device_id ?? '', { ...event, type: 'CALENDAR_UPDATED' })).toThrow();
    expect(() => openEvent(keys, vector.device_id ?? '', { ...event, timestamp: '2026-01-01T10:00:01' })).toThrow();
    const flipped = fromBase64Url(event.ciphertext);
    flipped[20] = (flipped[20] ?? 0) ^ 1;
    expect(() => openEvent(keys, vector.device_id ?? '', { ...event, ciphertext: toBase64Url(flipped) })).toThrow();
    expect(() => openEvent(keys, vector.device_id ?? '', { ...event, ciphertext: 'AAAA' })).toThrow();
  });

  it('signs the way the relay verifies: METHOD, path and query, timestamp, hash of the body', () => {
    const keys = generateKeys();
    const body = new TextEncoder().encode('{"upto":3}');
    const signature = signRequest(keys, 'POST', '/updates/ack', 1_700_000_000, body);
    const message = `POST\n/updates/ack\n1700000000\n${createHash('sha256').update(body).digest('hex')}`;
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: toBase64Url(signPublic(keys)) },
      format: 'jwk',
    });
    expect(verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('writes base64url without padding and refuses anything else', () => {
    expect(toBase64Url(new Uint8Array([251, 255, 254]))).toBe('-__-');
    expect(Array.from(fromBase64Url('-__-'))).toEqual([251, 255, 254]);
    expect(() => fromBase64Url('a+b=')).toThrow();
  });
});
