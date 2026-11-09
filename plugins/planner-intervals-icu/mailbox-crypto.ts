// SPDX-License-Identifier: AGPL-3.0-or-later

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * The crypto of the mailbox client (ADR 0079), the same pure-JS code on every platform: Ed25519
 * signs the requests, X25519 with HKDF-SHA256 and AES-256-GCM opens the events. Binary values are
 * base64url without padding.
 */

const text = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error('Not base64url');
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

/** A device's two key pairs: the private halves go to the secret store, the public ones to the server. */
export interface DeviceKeys {
  readonly signPrivate: Uint8Array;
  readonly encPrivate: Uint8Array;
}

export function generateKeys(): DeviceKeys {
  return { signPrivate: ed25519.utils.randomSecretKey(), encPrivate: x25519.utils.randomSecretKey() };
}

export const signPublic = (keys: DeviceKeys): Uint8Array => ed25519.getPublicKey(keys.signPrivate);
export const encPublic = (keys: DeviceKeys): Uint8Array => x25519.getPublicKey(keys.encPrivate);

/** `METHOD \n pathAndQuery \n timestamp \n hex(sha256(body))`, signed; the body is empty for none. */
export function signRequest(
  keys: DeviceKeys,
  method: string,
  pathAndQuery: string,
  timestamp: number,
  body: Uint8Array = new Uint8Array(),
): string {
  const message = `${method}\n${pathAndQuery}\n${timestamp}\n${bytesToHex(sha256(body))}`;
  return toBase64Url(ed25519.sign(text.encode(message), keys.signPrivate));
}

/** What the server stores of an event for one device. */
export interface SealedEvent {
  readonly type: string;
  readonly timestamp: string;
  readonly eph_pub: string;
  readonly ciphertext: string;
}

/** Opens an event: the plaintext is the UTF-8 JSON the server sealed. Throws on any mismatch. */
export function openEvent(keys: DeviceKeys, deviceId: string, event: SealedEvent): string {
  const ephPublic = fromBase64Url(event.eph_pub);
  const shared = x25519.getSharedSecret(keys.encPrivate, ephPublic);
  const salt = new Uint8Array([...ephPublic, ...encPublic(keys)]);
  const key = hkdf(sha256, shared, salt, text.encode('ridrs-mailbox-v1'), 32);
  const sealed = fromBase64Url(event.ciphertext);
  if (sealed.length < 12 + 16) {
    throw new Error('The ciphertext is too short');
  }
  const aad = text.encode(`${deviceId}|${event.type}|${event.timestamp}`);
  const plain = gcm(key, sealed.slice(0, 12), aad).decrypt(sealed.slice(12));
  return new TextDecoder().decode(plain);
}

export const sha256Hex = (body: Uint8Array): string => bytesToHex(sha256(body));
