// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * PKCE (RFC 7636, S256) and the OAuth `state` with Web Crypto, built into Node and every webview
 * (ADR 0048). These are secrets, not ids: they come from the system's random source on purpose,
 * never from `ctx.ids`, and never enter an event.
 */

const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** Characters from the unreserved alphabet, without modulo bias (256 = 66 · 3 + 58 is rejected). */
export function randomUnreserved(length: number): string {
  const limit = 256 - (256 % UNRESERVED.length);
  let result = '';
  while (result.length < length) {
    for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < limit && result.length < length) {
        result += UNRESERVED[byte % UNRESERVED.length];
      }
    }
  }
  return result;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}
